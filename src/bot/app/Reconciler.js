// Reconciler (A3, contract A.2 §5/§10, ARCHITECTURE §5, docs/strategy/RECONCILIATION.md).
//
// Pure reduce(snapshot, stateView, pendingOps) -> Result<ReconciliationPatch>.
// No ports, no Game/Memory: everything comes in as values; the output is a list
// of StatePatch (writer 'observation') for StateStore.apply plus gaps, a
// per-room DomainStatus and reason codes.
//
// Stage A (no commands of the new system):
//   1. events: EventNormalizer per room with the persisted EventCursor;
//   2. lifecycle: births/deaths/spawning of own creeps (snapshot T-1/T and the
//      persisted observedBindings), observation-only bindings of legacy creeps;
//   3. observedOperations for legacy effects (persisted: SPAWN, derived
//      PICKUP/DROP and every UNKNOWN effect; event-backed TRANSFER/HARVEST/BUILD/
//      REPAIR/UPGRADE are aggregated in flow windows only, see RECONCILIATION.md);
//   4. FlowAccounting deltas folded into 100-tick FlowWindows.
// pendingOps (all optional): {previous: Snapshot|null (T-1, heap), operations:
// Operation[], receipts: CallReceipt[], expectations}. Operations are matched by
// EffectMatcher (stage B); their results only affect domainStatus/reasonCodes
// here because the A.2 ReconciliationPatch has no slot for EffectResults.
//
// Idempotency: flows are folded only for rooms whose cursor advanced in this
// call, every patch is a full `set` of the new value, and values equal to the
// stored ones are not re-emitted. reduce() on the state after applying its own
// patch with the same snapshot returns no patches; applying one patch twice
// gives the same state. patchId = 'rc:<tick>:<hash of path/op/value>'.

const { fingerprint } = require('../domain/fingerprint');
const { isRoomName } = require('../domain/keys');
const { canonicalJson } = require('../domain/canonical');
const { READY, REJECTED } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const E = require('../domain/enums');
const { LIMITS, emptyShadowRoot, validateReconciliationPatch } = require('../domain/stateLayout');
const { normalizeRoomEvents, creepBodiesById, isCompleteLog } = require('../observation/EventNormalizer');
const { matchEffects, observeOperations } = require('../observation/EffectMatcher');
const FA = require('../models/FlowAccounting');
const { FLOW_WINDOW_TICKS } = require('../domain/dtos');

/** ObservedBinding.lastSeen is refreshed at most this often when nothing else changed. */
const LAST_SEEN_REFRESH_TICKS = 20;
/** DEAD bindings are deleted after this many ticks. */
const DEAD_BINDING_RETENTION = 100;
/** Persisted observedOperations older than this (lastSeen) are deleted. */
const OBSERVED_OPERATION_RETENTION = 300;
/** Keep this many observedOperations at most (below LIMITS.observedOperations). */
const OBSERVED_OPERATION_SOFT_CAP = LIMITS.observedOperations - 64;

function same(a, b) {
    return canonicalJson(a) === canonicalJson(b);
}

function patchId(tick, namespace, path, op, value) {
    return 'rc:' + tick + ':' + fingerprint({ n: namespace, p: path, o: op, v: value === undefined ? null : value }).slice(8);
}

function setPatch(tick, path, value) {
    return { patchId: patchId(tick, 'strategyShadow', path, 'set', value), writer: E.StateWriter.OBSERVATION, namespace: 'strategyShadow', path: path, op: 'set', value: value };
}

function deletePatch(tick, path) {
    return { patchId: patchId(tick, 'strategyShadow', path, 'delete'), writer: E.StateWriter.OBSERVATION, namespace: 'strategyShadow', path: path, op: 'delete' };
}

function hasObservationData(shadow) {
    for (const roomName in shadow.rooms) {
        const r = shadow.rooms[roomName];
        if (r.eventCursor !== null || r.flowWindows.length > 0 || Object.keys(r.observedBindings).length > 0) return true;
    }
    return Object.keys(shadow.observedOperations || {}).length > 0;
}

function ownCreepsComplete(snapshot) {
    for (let i = 0; i < snapshot.missingFields.length; i++) if (snapshot.missingFields[i].indexOf('ownCreeps') === 0) return false;
    return true;
}

function spawnRoomOf(snapshot, creepName) {
    if (!snapshot) return null;
    for (const roomName in snapshot.rooms) {
        const spawns = snapshot.rooms[roomName].spawns;
        for (let i = 0; i < spawns.length; i++) if (spawns[i].spawning && spawns[i].spawning.name === creepName) return roomName;
    }
    return null;
}

/** All persisted observed bindings: creepName -> {room, binding}. */
function existingBindings(shadow) {
    const out = {};
    for (const roomName in shadow.rooms) {
        const b = shadow.rooms[roomName].observedBindings || {};
        for (const name in b) out[name] = { room: roomName, binding: b[name] };
    }
    return out;
}

function resolveHome(creep, snapshot, previous, existing) {
    if (creep.strategyEnvelope) return { homeRoom: creep.strategyEnvelope.homeRoom, homeSource: E.HomeSource.CREEP_MEMORY, homeQuality: E.Quality.OBSERVED };
    const spawnRoom = spawnRoomOf(snapshot, creep.name) || spawnRoomOf(previous, creep.name);
    if (spawnRoom) return { homeRoom: spawnRoom, homeSource: E.HomeSource.SPAWN_ROOM, homeQuality: E.Quality.DERIVED };
    if (existing && existing.binding.homeRoom !== null) {
        return { homeRoom: existing.binding.homeRoom, homeSource: existing.binding.homeSource, homeQuality: existing.binding.homeQuality };
    }
    return { homeRoom: null, homeSource: E.HomeSource.UNKNOWN, homeQuality: E.Quality.UNKNOWN }; // orphan
}

function bindingCore(b) {
    return [b.homeRoom, b.homeSource, b.homeQuality, b.legacyRole, b.legacyOrderId, b.body.join(','), b.bodyCost, b.firstSeen, b.lifeState].join('|');
}

/** Effect tick window of an observation is closed: its uncertainty now lives in the FlowWindow. */
function observationResolved(o, tick) {
    if (o.effect === E.EffectKind.CONFIRMED) return true;
    const effectTick = Math.max(0, o.lastSeen - 1);
    const windowEnd = effectTick - (effectTick % FLOW_WINDOW_TICKS) + FLOW_WINDOW_TICKS;
    return tick >= windowEnd;
}

/**
 * Retention of strategyShadow.observedOperations.
 *   - CONFIRMED records: deleted after OBSERVED_OPERATION_RETENTION ticks, evicted first under cap pressure;
 *   - disputed (effect != CONFIRMED) records: never evicted while unresolved (their
 *     flow window still open); once resolved, evicted after CONFIRMED ones;
 *   - when the soft cap is still exceeded, new CONFIRMED (optional) records are not
 *     added; new disputed records are added up to LIMITS.observedOperations; anything
 *     not stored marks the call `degraded` (reported as MISSING_FIELD).
 * @returns {{sets: string[], deletes: string[], degraded: boolean}}
 */
function planObservedOperations(stored, additions, tick) {
    const deletes = [];
    const alive = {};
    for (const k in stored) {
        const o = stored[k];
        const value = additions[k] || o;
        if (!additions[k] && tick - value.lastSeen > OBSERVED_OPERATION_RETENTION && observationResolved(value, tick)) deletes.push(k);
        else alive[k] = value;
    }
    let count = Object.keys(alive).length;
    const newKeys = Object.keys(additions).filter(function (k) { return !stored[k]; }).sort();
    count += newKeys.length;
    if (count > OBSERVED_OPERATION_SOFT_CAP) {
        const evictable = Object.keys(alive).filter(function (k) { return !additions[k] && observationResolved(alive[k], tick); });
        evictable.sort(function (a, b) {
            const ca = alive[a].effect === E.EffectKind.CONFIRMED ? 0 : 1;
            const cb = alive[b].effect === E.EffectKind.CONFIRMED ? 0 : 1;
            return ca - cb || alive[a].lastSeen - alive[b].lastSeen || (a < b ? -1 : 1);
        });
        for (let i = 0; i < evictable.length && count > OBSERVED_OPERATION_SOFT_CAP; i++) { deletes.push(evictable[i]); count--; }
    }
    let degraded = false;
    const sets = [];
    const updates = Object.keys(additions).filter(function (k) { return !!stored[k]; });
    for (let i = 0; i < updates.length; i++) sets.push(updates[i]);
    const optional = newKeys.filter(function (k) { return additions[k].effect === E.EffectKind.CONFIRMED; });
    const disputed = newKeys.filter(function (k) { return additions[k].effect !== E.EffectKind.CONFIRMED; });
    // count already includes every new key; drop optional ones first, then disputed beyond the hard limit
    for (let i = optional.length - 1; i >= 0 && count > OBSERVED_OPERATION_SOFT_CAP; i--) { optional.splice(i, 1); count--; degraded = true; }
    for (let i = disputed.length - 1; i >= 0 && count > LIMITS.observedOperations; i--) { disputed.splice(i, 1); count--; degraded = true; }
    const added = optional.concat(disputed);
    for (let i = 0; i < added.length; i++) sets.push(added[i]);
    sets.sort();
    deletes.sort();
    return { sets: sets, deletes: deletes, degraded: degraded };
}

function addReason(set, code) {

    if (set.indexOf(code) === -1) set.push(code);
}

/**
 * @param {object} snapshot Snapshot (contract A.2) of tick T
 * @param {object} stateView StateView (A2) — strategy.lastClosedTick, strategy.operations, shadow
 * @param {object|null} pendingOps {previous?, operations?, receipts?, expectations?}
 * @returns {object} READY(ReconciliationPatch) | REJECTED(INVALID_RECORD, …)
 */
function reduce(snapshot, stateView, pendingOps) {
    if (!snapshot || snapshot.dtoType !== 'Snapshot' || !snapshot.rooms || !snapshot.ownCreeps) return REJECTED(ReasonCode.INVALID_RECORD, { what: 'snapshot' });
    if (!stateView || !stateView.strategy) return REJECTED(ReasonCode.INVALID_RECORD, { what: 'stateView' });
    const pending = pendingOps || {};
    const tick = snapshot.tick;
    const previous = pending.previous && pending.previous.tick < tick ? pending.previous : null;
    const shadow = stateView.shadow || emptyShadowRoot();
    const patches = [];
    const gaps = [];
    const reasons = [];
    const uncertain = {};
    const rooms = Object.keys(snapshot.rooms).sort();

    // ARCHITECTURE §5: lastClosedTick is checked against T-1
    // lastClosedTick null: fresh state only when no shadow room carries observation data
    // (cursor, flow windows, bindings); null next to such data means CLOSE records were lost.
    const lastClosed = stateView.strategy.lastClosedTick;
    const closedMissing = (lastClosed === null || lastClosed === undefined) && hasObservationData(shadow);
    if (closedMissing || (lastClosed !== null && lastClosed !== undefined && lastClosed < tick - 1)) {
        addReason(reasons, ReasonCode.UNCERTAIN_FUNDING);
        addReason(reasons, ReasonCode.EVENT_GAP);
        for (let i = 0; i < rooms.length; i++) uncertain[rooms[i]] = true;
    }

    // 1. events
    const bodies = creepBodiesById(snapshot);
    const events = [];
    const advanced = {};
    const hadCursor = {};
    const coverage = []; // (room, effectTick) whose complete event list is in `events`
    for (let i = 0; i < rooms.length; i++) {
        const roomName = rooms[i];
        const shadowRoom = shadow.rooms[roomName] || null;
        const cursor = shadowRoom ? shadowRoom.eventCursor : null;
        hadCursor[roomName] = cursor !== null;
        const res = normalizeRoomEvents(snapshot.rooms[roomName], cursor, { creepBodies: bodies });
        if (res.kind !== 'READY') {
            addReason(reasons, res.kind === 'REJECTED' ? res.reasonCode : res.reason);
            uncertain[roomName] = true;
            continue;
        }
        if (cursor !== null && same(res.value.cursor, cursor)) continue; // already processed
        advanced[roomName] = true;
        const log = snapshot.rooms[roomName].eventLog;
        if (res.value.gaps.length === 0 && isCompleteLog(snapshot.rooms[roomName])) coverage.push({ roomName: roomName, effectTick: log.effectTick });
        for (let k = 0; k < res.value.events.length; k++) events.push(res.value.events[k]);
        for (let k = 0; k < res.value.gaps.length; k++) { gaps.push(res.value.gaps[k]); addReason(reasons, res.value.gaps[k].reasonCode); }
        patches.push(setPatch(tick, ['rooms', roomName, 'eventCursor'], res.value.cursor));
    }

    // 4. flows (only rooms whose cursor advanced: no double folding)
    const deltasByRoom = {};
    function addDelta(d) { (deltasByRoom[d.roomName] = deltasByRoom[d.roomName] || []).push(d); }
    for (let i = 0; i < gaps.length; i++) addDelta(FA.unknownDelta(gaps[i].roomName, gaps[i].fromTick, gaps[i].toTick + 1, gaps[i].reasonCode));
    const flowRes = FA.accountFlows({ previous: previous, current: snapshot, events: events, gaps: gaps });
    if (flowRes.kind === 'READY') {
        for (let i = 0; i < flowRes.value.length; i++) {
            const d = flowRes.value[i];
            if (!advanced[d.roomName]) continue;
            addDelta(d);
            if (d.reasonCodes.indexOf(ReasonCode.UNEXPLAINED_BALANCE) !== -1) { addReason(reasons, ReasonCode.UNEXPLAINED_BALANCE); uncertain[d.roomName] = true; }
        }
    } else {
        addReason(reasons, flowRes.kind === 'REJECTED' ? flowRes.reasonCode : flowRes.reason);
    }
    for (let i = 0; i < rooms.length; i++) {
        const roomName = rooms[i];
        // cursor existed, but T-1 snapshot is not available (e.g. after reset): this tick is uncovered
        if (advanced[roomName] && hadCursor[roomName] && (previous === null || !previous.rooms[roomName])) {
            addDelta(FA.unknownDelta(roomName, tick - 1, tick, ReasonCode.EVENT_GAP));
            addReason(reasons, ReasonCode.EVENT_GAP);
        }
    }
    const deltaRooms = Object.keys(deltasByRoom).sort();
    for (let i = 0; i < deltaRooms.length; i++) {
        const roomName = deltaRooms[i];
        const stored = shadow.rooms[roomName] ? shadow.rooms[roomName].flowWindows : [];
        const windows = {};
        for (let k = 0; k < stored.length; k++) windows[stored[k].windowStart] = stored[k];
        const list = deltasByRoom[roomName];
        // topology observed now; an unseen room (null) never proves "unchanged"
        const topology = FA.topologyVersion(snapshot, roomName);
        for (let k = 0; k < list.length; k++) {
            const starts = FA.windowStartsOf(list[k]);
            for (let s = 0; s < starts.length; s++) {
                const w = windows[starts[s]] || FA.emptyWindow(roomName, starts[s], topology);
                windows[starts[s]] = FA.mergeDelta(w, list[k], topology);
            }
        }
        const merged = Object.keys(windows).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return windows[k]; });
        const kept = merged.slice(Math.max(0, merged.length - LIMITS.flowWindowsPerRoom));
        if (!same(kept, stored)) patches.push(setPatch(tick, ['rooms', roomName, 'flowWindows'], kept));
    }

    // 2. lifecycle / observed bindings
    const knownOps = {};
    const strategyOps = stateView.strategy.operations || {};
    for (const k in strategyOps) knownOps[k] = true;
    const pendingList = Array.isArray(pending.operations) ? pending.operations : [];
    for (let i = 0; i < pendingList.length; i++) knownOps[pendingList[i].operationKey] = true;
    const existing = existingBindings(shadow);
    const creepsComplete = ownCreepsComplete(snapshot);
    const names = Object.keys(snapshot.ownCreeps).sort();
    for (let i = 0; i < names.length; i++) {
        const creep = snapshot.ownCreeps[names[i]];
        const old = existing[creep.name] || null;
        const home = resolveHome(creep, snapshot, previous, old);
        const roomKey = home.homeRoom || creep.roomName || (old ? old.room : null);
        if (roomKey === null) { addReason(reasons, ReasonCode.MISSING_FIELD); continue; }
        const body = creep.body.map(function (p) { return p.type; });
        const cost = FA.bodyCost(body);
        const binding = {
            homeRoom: home.homeRoom,
            homeSource: home.homeSource,
            homeQuality: home.homeQuality,
            legacyRole: creep.legacyRole,
            legacyOrderId: old ? old.binding.legacyOrderId : null,
            body: body,
            bodyCost: cost === null ? 0 : cost,
            firstSeen: old && old.binding.lifeState !== E.LifeState.DEAD ? old.binding.firstSeen : tick,
            lastSeen: tick,
            lifeState: creep.spawning ? E.LifeState.SPAWNING : E.LifeState.ALIVE,
        };
        if (cost === null) addReason(reasons, ReasonCode.MISSING_FIELD);
        // missing operation: a creation envelope of the new system without a record
        if (creep.strategyEnvelope && !knownOps[creep.strategyEnvelope.operationKey]) {
            addReason(reasons, ReasonCode.UNCERTAIN_FUNDING);
            uncertain[creep.strategyEnvelope.homeRoom] = true;
        }
        const moved = old !== null && old.room !== roomKey;
        const changed = old === null || moved || bindingCore(old.binding) !== bindingCore(binding);
        if (!changed && tick - old.binding.lastSeen < LAST_SEEN_REFRESH_TICKS) continue;
        if (moved) patches.push(deletePatch(tick, ['rooms', old.room, 'observedBindings', creep.name]));
        patches.push(setPatch(tick, ['rooms', roomKey, 'observedBindings', creep.name], binding));
    }
    const existingNames = Object.keys(existing).sort();
    for (let i = 0; i < existingNames.length; i++) {
        const name = existingNames[i];
        if (snapshot.ownCreeps[name]) continue;
        const rec = existing[name];
        const b = rec.binding;
        if (b.lifeState === E.LifeState.DEAD) {
            if (tick - b.lastSeen > DEAD_BINDING_RETENTION) patches.push(deletePatch(tick, ['rooms', rec.room, 'observedBindings', name]));
            continue;
        }
        const nextState = creepsComplete ? E.LifeState.DEAD : E.LifeState.UNKNOWN;
        if (b.lifeState === nextState) continue;
        patches.push(setPatch(tick, ['rooms', rec.room, 'observedBindings', name], Object.assign({}, b, { lifeState: nextState })));
    }

    // 3. observed operations of legacy/world
    const observed = observeOperations({ events: events, previous: previous, current: snapshot });
    const stored = shadow.observedOperations || {};
    const additions = {}; // key -> value to set (new or updated)
    for (let i = 0; i < observed.length; i++) {
        const o = observed[i];
        if (!advanced[o.roomName]) continue; // events of this room were not (re)read in this call
        const persist = o.kind === E.ObservedOperationKind.SPAWN || o.kind === E.ObservedOperationKind.PICKUP || o.kind === E.ObservedOperationKind.OTHER || o.effect !== E.EffectKind.CONFIRMED;
        if (o.effect === E.EffectKind.UNKNOWN) addReason(reasons, ReasonCode.AMBIGUOUS_EFFECT);
        if (!persist) continue;
        const prior = stored[o.observationKey];
        const value = prior ? Object.assign({}, o, { firstSeen: Math.min(prior.firstSeen, o.firstSeen), lastSeen: Math.max(prior.lastSeen, o.lastSeen) }) : o;
        if (prior && same(prior, value)) continue;
        additions[o.observationKey] = value;
    }
    const obsPlan = planObservedOperations(stored, additions, tick);
    for (let i = 0; i < obsPlan.deletes.length; i++) patches.push(deletePatch(tick, ['observedOperations', obsPlan.deletes[i]]));
    for (let i = 0; i < obsPlan.sets.length; i++) patches.push(setPatch(tick, ['observedOperations', obsPlan.sets[i]], additions[obsPlan.sets[i]]));
    if (obsPlan.degraded) addReason(reasons, ReasonCode.MISSING_FIELD);

    // stage B: our operations (stage A: none)
    if (pendingList.length > 0) {
        const effects = matchEffects({ operations: pendingList, receipts: pending.receipts || [], events: events, coverage: coverage, gaps: gaps, previous: previous, current: snapshot, expectations: pending.expectations || {} });
        for (let i = 0; i < effects.length; i++) {
            if (effects[i].kind !== E.EffectKind.UNKNOWN) continue;
            addReason(reasons, effects[i].reason);
            const parts = effects[i].operationKey.split('/');
            if (snapshot.rooms[parts[0]]) uncertain[parts[0]] = true;
        }
    }

    const domainStatus = {};
    for (let i = 0; i < rooms.length; i++) domainStatus[rooms[i]] = uncertain[rooms[i]] ? E.DomainStatus.UNCERTAIN_FUNDING : E.DomainStatus.OK;
    for (const r in uncertain) if (!domainStatus[r] && isRoomName(r)) domainStatus[r] = E.DomainStatus.UNCERTAIN_FUNDING;
    if (Object.keys(uncertain).length > 0) addReason(reasons, ReasonCode.UNCERTAIN_FUNDING);

    patches.sort(function (a, b) {
        const pa = a.path.join('\u0000');
        const pb = b.path.join('\u0000');
        if (pa !== pb) return pa < pb ? -1 : 1;
        return a.op < b.op ? -1 : (a.op > b.op ? 1 : 0);
    });
    gaps.sort(function (a, b) { return a.roomName < b.roomName ? -1 : (a.roomName > b.roomName ? 1 : a.fromTick - b.fromTick); });
    reasons.sort();
    const patch = { tick: tick, patches: patches, gaps: gaps, domainStatus: domainStatus, reasonCodes: reasons };
    const check = validateReconciliationPatch(patch);
    if (!check.ok) return REJECTED(ReasonCode.INVALID_RECORD, { what: 'ReconciliationPatch', errors: check.errors.slice(0, 5) });
    return READY(patch, fingerprint({ snapshot: snapshot.fingerprint, revision: stateView.strategy.revision, previous: previous ? previous.fingerprint : null, operations: pendingList.map(function (o) { return o.operationKey + '@' + o.updatedAt; }) }));
}

module.exports = {
    LAST_SEEN_REFRESH_TICKS,
    DEAD_BINDING_RETENTION,
    OBSERVED_OPERATION_RETENTION,
    OBSERVED_OPERATION_SOFT_CAP,
    planObservedOperations,
    reduce,
};
