// EffectMatcher (A3, contract A.2 §4.3, ARCHITECTURE §5, docs/strategy/RECONCILIATION.md).
//
// Pure. Two jobs:
//   matchEffects      — our Operations (stage B; tested on synthetic ops in stage A)
//                       against the multiset of observed events/snapshot facts ->
//                       EffectResult CONFIRMED(amount) | NO_EFFECT(evidence) | UNKNOWN(reason);
//   observeOperations — legacy/world actions seen in shadow -> ObservedOperation.
//
// Invariants:
//   - a CallReceipt (RETURNED/THREW) never confirms; a RETURNED error code (< 0)
//     is the only receipt-based NO_EFFECT (the engine got no intent);
//   - events and operations are matched as multisets: an operation is CONFIRMED
//     only when its connected component in the candidate graph is exactly one
//     operation and one event; anything else is UNKNOWN(AMBIGUOUS_EFFECT);
//   - NO_EFFECT from absence needs: the effect tick is T-1 of the current
//     snapshot, a complete (unfiltered) event log of the actor's room, and an
//     actor that is still alive (the death tick never proves "not delivered");
//   - partial transfers keep the same operationKey; confirmedAmount is cumulative
//     (effect.partial = true while below requestedAmount);
//   - spawn is confirmed by the observed creep/spawning with the expected name,
//     body and creation envelope (operationKey, home); there is no EVENT_SPAWN;
//   - events already accounted for by operation.lastEffect are not used twice.

const { parseOperationKey, shortCreepName, isRoomName } = require('../domain/keys');
const { measured, unknownMeasure } = require('../domain/dtos');
const { READY, REJECTED } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { canonicalJson } = require('../domain/canonical');
const { fingerprint } = require('../domain/fingerprint');
const E = require('../domain/enums');
const { bodyCost, spawnStarts, derivePileTransfers } = require('../models/FlowAccounting');

const EVENT_ACTIONS = Object.freeze({
    transfer: E.NormalizedEventType.TRANSFER,
    withdraw: E.NormalizedEventType.TRANSFER,
    harvest: E.NormalizedEventType.HARVEST,
    build: E.NormalizedEventType.BUILD,
    repair: E.NormalizedEventType.REPAIR,
    upgrade: E.NormalizedEventType.UPGRADE_CONTROLLER,
    upgradeController: E.NormalizedEventType.UPGRADE_CONTROLLER,
});

/** Actions whose confirmedAmount accumulates across ticks under one key. */
const PARTIAL_ACTIONS = Object.freeze(['transfer', 'withdraw', 'pickup']);

const ACTIVE_STATES = Object.freeze([E.OperationState.PREPARED, E.OperationState.ISSUED, E.OperationState.UNKNOWN]);

function near(a, b) {
    return !!a && !!b && a.roomName === b.roomName && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
}

function sortedUnique(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) if (out.indexOf(list[i]) === -1) out.push(list[i]);
    out.sort();
    return out;
}

function result(kind, op, ctx, fields) {
    return {
        kind: kind,
        operationKey: op.operationKey,
        commandId: ctx.commandId,
        evaluatedAt: ctx.current.tick,
        confirmedAmount: fields.confirmedAmount === undefined ? null : fields.confirmedAmount,
        effect: fields.effect === undefined ? null : fields.effect,
        evidence: fields.evidence === undefined ? null : fields.evidence,
        reason: fields.reason === undefined ? null : fields.reason,
        eventKeys: sortedUnique(fields.eventKeys || []),
    };
}

function unknown(op, ctx, reason, eventKeys) {
    return result(E.EffectKind.UNKNOWN, op, ctx, { reason: reason, eventKeys: eventKeys || [] });
}

function currentReceipt(op, receipts) {
    let best = null;
    const list = Array.isArray(receipts) ? receipts.slice() : [];
    if (op.lastReceipt) list.push(op.lastReceipt);
    for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.operationKey !== op.operationKey) continue;
        if (op.lastCommandId !== null && op.lastCommandId !== undefined && r.commandId !== op.lastCommandId) continue;
        if (best === null || r.tick > best.tick) best = r;
    }
    return best;
}

function isErrorReceipt(receipt) {
    return receipt !== null && receipt.kind === E.CallReceiptKind.RETURNED && typeof receipt.code === 'number' && receipt.code < 0;
}

function creepById(snapshot, id) {
    if (!snapshot || !id) return null;
    for (const name in snapshot.ownCreeps) if (snapshot.ownCreeps[name].id === id) return snapshot.ownCreeps[name];
    return null;
}

function ownCreepsComplete(snapshot) {
    for (let i = 0; i < snapshot.missingFields.length; i++) if (snapshot.missingFields[i].indexOf('ownCreeps') === 0) return false;
    return true;
}

function findNode(snapshot, id) {
    if (!snapshot) return null;
    for (const roomName in snapshot.rooms) {
        const room = snapshot.rooms[roomName];
        if (room.visibility !== E.Visibility.VISIBLE) continue;
        for (let i = 0; i < room.energyNodes.length; i++) {
            const n = room.energyNodes[i];
            if (n.nodeId === id && n.nodeClass !== 'CARGO' && n.nodeClass !== 'REMOTE') return n;
        }
    }
    return null;
}

function findRoomObject(snapshot, id) {
    if (!snapshot) return null;
    for (const roomName in snapshot.rooms) {
        const room = snapshot.rooms[roomName];
        if (room.controller && room.controller.id === id) return roomName;
        for (let i = 0; i < room.constructionSites.length; i++) if (room.constructionSites[i].id === id) return roomName;
        for (let i = 0; i < room.sources.length; i++) if (room.sources[i].id === id) return roomName;
        for (let i = 0; i < room.spawns.length; i++) if (room.spawns[i].id === id) return roomName;
    }
    return null;
}

/**
 * Resolve an Operation actorRef/targetRef to an engine object id (event ids).
 * Accepted forms: an own creep NAME (resolved through ownCreeps[name].id of the
 * previous or current snapshot), an own creep id, or the id of a visible
 * EnergyNode / controller / construction site / source / spawn.
 * expectations.actorId/targetId are raw object ids and are used as-is.
 * @returns {{id: string, creepName: string|null, roomName: string|null}|null} null = unresolved
 */
function resolveRef(ref, rawId, ctx) {
    if (typeof rawId === 'string' && rawId.length > 0) {
        const c = creepById(ctx.previous, rawId) || creepById(ctx.current, rawId);
        const n = findNode(ctx.previous, rawId) || findNode(ctx.current, rawId);
        return { id: rawId, creepName: c ? c.name : null, roomName: c ? c.roomName : (n ? n.roomName : findRoomObject(ctx.current, rawId)) };
    }
    if (typeof ref !== 'string' || ref.length === 0) return null;
    const byName = (ctx.previous && ctx.previous.ownCreeps[ref]) || ctx.current.ownCreeps[ref] || null;
    if (byName) return byName.id ? { id: byName.id, creepName: byName.name, roomName: byName.roomName } : null;
    const byId = creepById(ctx.previous, ref) || creepById(ctx.current, ref);
    if (byId) return { id: ref, creepName: byId.name, roomName: byId.roomName };
    const node = findNode(ctx.previous, ref) || findNode(ctx.current, ref);
    if (node) return { id: ref, creepName: null, roomName: node.roomName };
    const room = findRoomObject(ctx.previous, ref) || findRoomObject(ctx.current, ref);
    return room ? { id: ref, creepName: null, roomName: room } : null;
}

/** Candidate predicate of an event-backed operation (resolved ids). */
function eventPredicate(action, actorId, targetId, resource) {
    const type = EVENT_ACTIONS[action];
    return function (e) {
        if (e.type !== type) return false;
        switch (action) {
            case 'transfer': return e.sourceId === actorId && e.targetId === targetId && e.resourceType === resource;
            case 'withdraw': return e.sourceId === targetId && e.targetId === actorId && e.resourceType === resource;
            case 'harvest': return e.actorId === actorId && (targetId === null || e.sourceId === targetId);
            case 'upgrade':
            case 'upgradeController': return e.actorId === actorId;
            default: return e.actorId === actorId && (targetId === null || e.targetId === targetId);
        }
    };
}

/** Actions that need a resolved target. */
const TARGET_REQUIRED = Object.freeze(['transfer', 'withdraw', 'build', 'repair']);

/** Coverage index: (room, effectTick) of complete normalized logs actually passed in. */
function coverageIndex(list) {
    const index = {};
    const items = Array.isArray(list) ? list : [];
    for (let i = 0; i < items.length; i++) index[items[i].roomName + ':' + items[i].effectTick] = true;
    return index;
}

/**
 * Whether every tick of [fromTick, toTick] is covered in roomName and no gap
 * intersects it. Returns null when complete, else the UNKNOWN reason.
 */
function windowProblem(ctx, roomName, fromTick, toTick) {
    if (roomName === null) return ReasonCode.NO_VISIBILITY;
    for (let i = 0; i < ctx.gaps.length; i++) {
        const g = ctx.gaps[i];
        if (g.roomName === roomName && g.fromTick <= toTick && fromTick <= g.toTick) return g.reasonCode;
    }
    const room = ctx.current.rooms[roomName];
    if (!room || room.visibility !== E.Visibility.VISIBLE) return ReasonCode.NO_VISIBILITY;
    if (toTick < fromTick) return ReasonCode.EVENT_GAP;
    for (let t = fromTick; t <= toTick; t++) if (ctx.coverage[roomName + ':' + t] !== true) return ReasonCode.EVENT_GAP;
    return null;
}

/** Room of an object id in one snapshot (creep, energy node or room object), or null. */
function roomIn(snapshot, id) {
    if (!snapshot || !id) return null;
    const c = creepById(snapshot, id);
    if (c) return c.roomName;
    const n = findNode(snapshot, id);
    if (n) return n.roomName;
    return findRoomObject(snapshot, id);
}

/**
 * Every room whose log could hold the effect: the actor's room in the previous and
 * the current snapshot, the target's rooms, the expected room and the rooms of the
 * candidates found. null when the actor's room at the issue tick is unknown.
 */
function possibleRooms(p) {
    const ctx = p.ctx;
    const rooms = [];
    function add(r) { if (r && rooms.indexOf(r) === -1) rooms.push(r); }
    const actorPrev = roomIn(ctx.previous, p.actor.id);
    const actorCur = roomIn(ctx.current, p.actor.id);
    if (actorPrev === null && actorCur === null) return null;
    add(actorPrev); add(actorCur);
    if (p.target) { add(roomIn(ctx.previous, p.target.id)); add(roomIn(ctx.current, p.target.id)); }
    add(p.eventRoom);
    for (let i = 0; i < p.candidates.length; i++) add(p.candidates[i].roomName);
    rooms.sort();
    return rooms;
}

/** null when every possible room is covered for the whole window, else the UNKNOWN reason. */
function roomsProblem(p) {
    const rooms = possibleRooms(p);
    if (rooms === null) return ReasonCode.NO_VISIBILITY;
    for (let i = 0; i < rooms.length; i++) {
        const problem = windowProblem(p.ctx, rooms[i], p.fromTick, p.ctx.current.tick - 1);
        if (problem !== null) return problem;
    }
    return null;
}

function absenceVerdict(p) {
    const ctx = p.ctx;
    const current = ctx.current;
    if (p.issuedTick !== current.tick - 1) return { reason: ReasonCode.EVENT_GAP };
    // absence needs the adjacent snapshot of the issue tick: a stale previous may show the actor elsewhere
    if (!ctx.previous || ctx.previous.tick !== p.issuedTick) return { reason: ReasonCode.EVENT_GAP };
    const problem = roomsProblem(p);
    if (problem !== null) return { reason: problem };
    // the actor must still exist: its death tick never proves "not delivered"
    const wasCreep = p.actor.creepName !== null;
    const alive = wasCreep ? !!creepById(current, p.actor.id) : !!(findNode(current, p.actor.id) || findRoomObject(current, p.actor.id));
    if (!alive) return { reason: ReasonCode.AMBIGUOUS_EFFECT };
    const rooms = possibleRooms(p);
    return { evidence: { absent: true, rooms: rooms, effectTick: p.issuedTick, rawFingerprints: rooms.map(function (r) { return current.rooms[r].eventLog.rawFingerprint; }) } };
}

function confirmedFromEvent(op, ctx, action, e) {
    const keys = [e.eventKey];
    if (PARTIAL_ACTIONS.indexOf(action) !== -1) {
        if (e.amount.value === null) return unknown(op, ctx, ReasonCode.MISSING_FIELD, keys);
        const total = op.confirmedAmount + e.amount.value;
        if (op.requestedAmount !== null && total > op.requestedAmount) return unknown(op, ctx, ReasonCode.AMBIGUOUS_EFFECT, keys);
        const partial = op.requestedAmount !== null && total < op.requestedAmount;
        return result(E.EffectKind.CONFIRMED, op, ctx, {
            confirmedAmount: total,
            effect: { eventKey: e.eventKey, amount: e.amount.value, energyAmount: e.energyAmount.value, partial: partial, remaining: op.requestedAmount === null ? null : op.requestedAmount - total },
            eventKeys: keys,
        });
    }
    return result(E.EffectKind.CONFIRMED, op, ctx, {
        confirmedAmount: e.energyAmount.value,
        effect: { eventKey: e.eventKey, amount: e.amount.value, energyAmount: e.energyAmount.value, partial: false, remaining: null },
        eventKeys: keys,
    });
}

function sameBody(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function matchSpawn(op, ctx, exp, parts, receipt, issuedTick) {
    const current = ctx.current;
    const name = exp.creepName || shortCreepName(op.operationKey);
    const home = exp.homeRoom || (isRoomName(parts.domain) ? parts.domain : null);
    const creep = current.ownCreeps[name] || null;
    let spawnId = null;
    for (const roomName in current.rooms) {
        const spawns = current.rooms[roomName].spawns;
        for (let i = 0; i < spawns.length; i++) if (spawns[i].spawning && spawns[i].spawning.name === name) spawnId = spawns[i].id;
    }
    if (creep) {
        if (!Array.isArray(exp.body)) return unknown(op, ctx, ReasonCode.MISSING_FIELD);
        const body = creep.body.map(function (p) { return p.type; });
        const env = creep.strategyEnvelope;
        if (env === null) return unknown(op, ctx, ReasonCode.AMBIGUOUS_EFFECT); // orphan: name alone is not proof
        if (env.operationKey !== op.operationKey || !sameBody(body, exp.body)) return unknown(op, ctx, ReasonCode.NAME_COLLISION);
        if (home !== null && env.homeRoom !== home) return unknown(op, ctx, ReasonCode.LEGACY_BINDING_CONFLICT);
        return result(E.EffectKind.CONFIRMED, op, ctx, {
            confirmedAmount: bodyCost(body),
            effect: { creepName: name, spawning: creep.spawning, spawnId: spawnId, homeRoom: env.homeRoom, body: body },
        });
    }
    if (spawnId !== null || !ownCreepsComplete(current)) return unknown(op, ctx, ReasonCode.MISSING_FIELD);
    if (isErrorReceipt(receipt)) return result(E.EffectKind.NO_EFFECT, op, ctx, { evidence: { receiptCode: receipt.code, creepAbsent: true } });
    if (issuedTick === current.tick - 1) return result(E.EffectKind.NO_EFFECT, op, ctx, { evidence: { creepAbsent: true, spawningAbsent: true, effectTick: issuedTick } });
    return unknown(op, ctx, ReasonCode.EVENT_GAP); // could have been born and died in the missed interval
}

function matchPickup(op, ctx, exp, receipt, issuedTick, events) {
    const current = ctx.current;
    const previous = ctx.previous;
    if (isErrorReceipt(receipt)) return result(E.EffectKind.NO_EFFECT, op, ctx, { evidence: { receiptCode: receipt.code } });
    if (issuedTick !== current.tick - 1 || !previous || previous.tick !== issuedTick) return unknown(op, ctx, ReasonCode.EVENT_GAP);
    const actor = resolveRef(op.actorRef, exp.actorId, ctx);
    if (actor === null || actor.creepName === null) return unknown(op, ctx, ReasonCode.MISSING_FIELD);
    const target = op.targetRef || exp.targetId ? resolveRef(op.targetRef, exp.targetId, ctx) : null;
    if ((op.targetRef || exp.targetId) && target === null) return unknown(op, ctx, ReasonCode.MISSING_FIELD);
    const before = previous.ownCreeps[actor.creepName] || null;
    const after = current.ownCreeps[actor.creepName] || null;
    if (!before) return unknown(op, ctx, ReasonCode.MISSING_FIELD);
    if (!after) return unknown(op, ctx, ReasonCode.AMBIGUOUS_EFFECT);
    // derivation needs every event of the tick (pickup has none of its own)
    const problem = windowProblem(ctx, before.roomName, issuedTick, issuedTick);
    if (problem !== null) return unknown(op, ctx, problem);
    const transfers = derivePileTransfers(previous, current, events);
    const mine = transfers.filter(function (t) { return t.kind === 'PICKUP' && t.actorId === after.id; });
    if (mine.length === 1) {
        const t = mine[0];
        if (t.ambiguous || (target && t.pileId !== target.id)) return unknown(op, ctx, ReasonCode.AMBIGUOUS_EFFECT);
        const total = op.confirmedAmount + t.amount;
        if (op.requestedAmount !== null && total > op.requestedAmount) return unknown(op, ctx, ReasonCode.AMBIGUOUS_EFFECT);
        return result(E.EffectKind.CONFIRMED, op, ctx, {
            confirmedAmount: total,
            effect: { derived: true, pileId: t.pileId, amount: t.amount, partial: op.requestedAmount !== null && total < op.requestedAmount, remaining: op.requestedAmount === null ? null : op.requestedAmount - total },
        });
    }
    const touched = events.some(function (e) { return e.effectTick === issuedTick && (e.sourceId === after.id || e.targetId === after.id || e.actorId === after.id); });
    if (!touched && before.store.energy.value !== null && before.store.energy.value === after.store.energy.value) {
        return result(E.EffectKind.NO_EFFECT, op, ctx, { evidence: { cargoUnchanged: before.store.energy.value, effectTick: issuedTick } });
    }
    return unknown(op, ctx, ReasonCode.AMBIGUOUS_EFFECT);
}

function matchMove(op, ctx, exp, receipt, issuedTick) {
    const current = ctx.current;
    if (isErrorReceipt(receipt)) return result(E.EffectKind.NO_EFFECT, op, ctx, { evidence: { receiptCode: receipt.code } });
    const actor = resolveRef(op.actorRef, exp.actorId, ctx);
    if (actor === null || actor.creepName === null) return unknown(op, ctx, ReasonCode.MISSING_FIELD);
    const creep = current.ownCreeps[actor.creepName] || null;
    if (!creep || !exp.targetPos) return unknown(op, ctx, !creep ? ReasonCode.AMBIGUOUS_EFFECT : ReasonCode.MISSING_FIELD);
    const p = creep.pos;
    if (p && p.roomName === exp.targetPos.roomName && p.x === exp.targetPos.x && p.y === exp.targetPos.y) {
        return result(E.EffectKind.CONFIRMED, op, ctx, { confirmedAmount: null, effect: { pos: p } });
    }
    // NO_EFFECT only between adjacent snapshots (previous = the issue tick)
    const previous = ctx.previous;
    const before = previous && previous.tick === issuedTick ? previous.ownCreeps[creep.name] : null;
    if (issuedTick === current.tick - 1 && before && before.pos && p && before.pos.x === p.x && before.pos.y === p.y && before.pos.roomName === p.roomName) {
        return result(E.EffectKind.NO_EFFECT, op, ctx, { evidence: { stayed: p } });
    }
    return unknown(op, ctx, ReasonCode.AMBIGUOUS_EFFECT);
}

/**
 * @param {{operations: object[], receipts?: object[], events: object[], previous: object|null,
 *          current: object, coverage?: Array<{roomName: string, effectTick: number}>,
 *          gaps?: object[], expectations?: Object<string, object>}} input
 *   coverage: (room, effectTick) whose COMPLETE normalized event list is included in
 *   `events`. Without coverage nothing is CONFIRMED or NO_EFFECT from events
 *   (absence and uniqueness are unprovable). gaps: EventGap[]; a window that
 *   intersects a gap is UNKNOWN.
 *   expectations (A3-internal until the contract carries them; see RECONCILIATION.md):
 *   operationKey -> {creepName?, body?: string[], homeRoom?, actorId?, targetId?, roomName?,
 *   resourceType?, targetPos?}
 * @returns {object[]} EffectResult[] sorted by operationKey (terminal/NO_EFFECT operations skipped)
 */
function matchEffects(input) {
    const operations = Array.isArray(input.operations) ? input.operations : [];
    const events = Array.isArray(input.events) ? input.events : [];
    const expectations = input.expectations || {};
    const current = input.current;
    const previous = input.previous || null;
    const coverage = coverageIndex(input.coverage);
    const gaps = Array.isArray(input.gaps) ? input.gaps : [];
    const out = [];
    const pendingEventOps = [];

    for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        if (ACTIVE_STATES.indexOf(op.state) === -1) continue;
        // already evaluated against this (or a later) snapshot: idempotent, never re-derive absence
        if (op.lastEffect && op.lastEffect.evaluatedAt >= current.tick) { out.push(op.lastEffect); continue; }
        const parts = parseOperationKey(op.operationKey);
        const action = parts.action;
        const exp = Object.prototype.hasOwnProperty.call(expectations, op.operationKey) ? expectations[op.operationKey] : {};
        const receipt = currentReceipt(op, input.receipts);
        const ctx = { current: current, previous: previous, coverage: coverage, gaps: gaps, commandId: op.lastCommandId || (receipt ? receipt.commandId : null) };
        if (op.state === E.OperationState.PREPARED && receipt === null) { out.push(unknown(op, ctx, ReasonCode.MISSING_FIELD)); continue; }
        const issuedTick = receipt !== null ? receipt.tick : op.issuedAt;
        if (issuedTick === null || issuedTick === undefined) { out.push(unknown(op, ctx, ReasonCode.MISSING_FIELD)); continue; }
        if (action === 'spawn') { out.push(matchSpawn(op, ctx, exp, parts, receipt, issuedTick)); continue; }
        if (action === 'pickup') { out.push(matchPickup(op, ctx, exp, receipt, issuedTick, events)); continue; }
        if (action === 'move') { out.push(matchMove(op, ctx, exp, receipt, issuedTick)); continue; }
        if (!Object.prototype.hasOwnProperty.call(EVENT_ACTIONS, action)) { out.push(unknown(op, ctx, ReasonCode.UNSUPPORTED_CAPABILITY)); continue; }

        // names -> ids before matching; unresolved actor/target -> UNKNOWN
        const actor = resolveRef(op.actorRef, exp.actorId, ctx);
        const needsTarget = TARGET_REQUIRED.indexOf(action) !== -1 || !!op.targetRef || !!exp.targetId;
        const target = needsTarget ? resolveRef(op.targetRef, exp.targetId, ctx) : null;
        if (actor === null || (needsTarget && target === null)) {
            // an error code means the engine never received the intent; otherwise unresolvable -> UNKNOWN
            out.push(isErrorReceipt(receipt) ? result(E.EffectKind.NO_EFFECT, op, ctx, { evidence: { receiptCode: receipt.code } }) : unknown(op, ctx, ReasonCode.MISSING_FIELD));
            continue;
        }
        const eventRoom = exp.roomName || (action === 'withdraw' && target.roomName ? target.roomName : actor.roomName) || (target ? target.roomName : null) || (isRoomName(parts.domain) ? parts.domain : null);

        // candidates: events of the effect window not already consumed by lastEffect
        const used = op.lastEffect ? op.lastEffect.eventKeys : [];
        const fromTick = Math.max(issuedTick, op.lastEffect ? op.lastEffect.evaluatedAt : 0);
        const pred = eventPredicate(action, actor.id, target ? target.id : null, exp.resourceType || 'energy');
        const candidates = [];
        const seen = {};
        for (let k = 0; k < events.length; k++) {
            const e = events[k];
            if (e.effectTick < fromTick || e.effectTick > current.tick - 1 || used.indexOf(e.eventKey) !== -1) continue;
            if (seen[e.eventKey] === true) continue; // the same event delivered twice is one event
            if (pred(e)) { seen[e.eventKey] = true; candidates.push(e); }
        }
        pendingEventOps.push({ op: op, ctx: ctx, action: action, receipt: receipt, issuedTick: issuedTick, fromTick: fromTick, actor: actor, target: target, eventRoom: eventRoom, candidates: candidates });
    }

    // multiset matching: components of the op<->event candidate graph
    const parent = [];
    for (let i = 0; i < pendingEventOps.length; i++) parent.push(i);
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    const owner = {};
    for (let i = 0; i < pendingEventOps.length; i++) {
        const cands = pendingEventOps[i].candidates;
        for (let k = 0; k < cands.length; k++) {
            const key = cands[k].eventKey;
            if (Object.prototype.hasOwnProperty.call(owner, key)) parent[find(i)] = find(owner[key]);
            else owner[key] = i;
        }
    }
    const compOps = {};
    const compEvents = {};
    for (let i = 0; i < pendingEventOps.length; i++) {
        const r = find(i);
        compOps[r] = (compOps[r] || 0) + 1;
        if (!compEvents[r]) compEvents[r] = {};
        for (let k = 0; k < pendingEventOps[i].candidates.length; k++) compEvents[r][pendingEventOps[i].candidates[k].eventKey] = true;
    }
    for (let i = 0; i < pendingEventOps.length; i++) {
        const p = pendingEventOps[i];
        const r = find(i);
        const eventCount = Object.keys(compEvents[r]).length;
        const keys = p.candidates.map(function (e) { return e.eventKey; });
        if (p.candidates.length === 0) {
            if (isErrorReceipt(p.receipt)) { out.push(result(E.EffectKind.NO_EFFECT, p.op, p.ctx, { evidence: { receiptCode: p.receipt.code } })); continue; }
            const verdict = absenceVerdict(p);
            out.push(verdict.evidence ? result(E.EffectKind.NO_EFFECT, p.op, p.ctx, { evidence: verdict.evidence }) : unknown(p.op, p.ctx, verdict.reason));
            continue;
        }
        // never CONFIRMED from an incomplete candidate set (gap / uncovered tick in the window)
        const problem = roomsProblem(p); // uniqueness needs every possible room covered too
        if (problem !== null) { out.push(unknown(p.op, p.ctx, problem, keys)); continue; }
        if (compOps[r] !== 1 || eventCount !== 1) { out.push(unknown(p.op, p.ctx, ReasonCode.AMBIGUOUS_EFFECT, keys)); continue; }
        if (isErrorReceipt(p.receipt)) { out.push(unknown(p.op, p.ctx, ReasonCode.AMBIGUOUS_EFFECT, keys)); continue; } // conflict
        out.push(confirmedFromEvent(p.op, p.ctx, p.action, p.candidates[0]));
    }
    out.sort(function (a, b) { return a.operationKey < b.operationKey ? -1 : (a.operationKey > b.operationKey ? 1 : 0); });
    return out;
}

/**
 * Apply an EffectResult to its Operation (pure; for stage B and for tests).
 * Idempotent: applying the same result twice returns an equal operation.
 * @param {object} operation Operation
 * @param {object} effect EffectResult of the same operationKey
 * @returns {object} READY(Operation) | REJECTED(INVALID_RECORD|STALE_INPUT)
 */
function applyEffect(operation, effect) {
    if (effect.operationKey !== operation.operationKey) return REJECTED(ReasonCode.INVALID_RECORD, { what: 'operationKey' });
    const fp = fingerprint({ operation: operation, effect: effect });
    if (operation.lastEffect !== null && canonicalJson(operation.lastEffect) === canonicalJson(effect)) return READY(operation, fp);
    const next = Object.assign({}, operation, { updatedAt: Math.max(operation.updatedAt, effect.evaluatedAt), lastEffect: effect });
    let to;
    if (effect.kind === E.EffectKind.CONFIRMED) {
        const partial = effect.effect !== null && effect.effect.partial === true;
        if (effect.confirmedAmount !== null && effect.confirmedAmount >= operation.confirmedAmount) next.confirmedAmount = effect.confirmedAmount;
        to = partial ? operation.state : E.OperationState.CONFIRMED;
        if (!partial) next.reasonCode = null;
    } else if (effect.kind === E.EffectKind.NO_EFFECT) {
        to = E.OperationState.NO_EFFECT;
    } else {
        to = E.OperationState.UNKNOWN;
        next.reasonCode = operation.state === E.OperationState.UNKNOWN && operation.reasonCode ? operation.reasonCode : effect.reason;
    }
    if (!E.canTransition(E.OPERATION_TRANSITIONS, operation.state, to)) {
        return REJECTED(ReasonCode.STALE_INPUT, { from: operation.state, to: to });
    }
    next.state = to;
    return READY(next, fp);
}

/**
 * UNKNOWN_RETIRED gate (ARCHITECTURE §5). Retirement is allowed only when the
 * operation is UNKNOWN, its effect window is over (no latent effect), every
 * affected node is visible with a known balance and every possible continuation
 * is excluded. Returns the blocking reasons; an empty list allows retirement.
 * @param {object} operation
 * @param {{current: object, expectation?: object, observedBindings?: Object<string, object>}} input
 * @returns {{retire: boolean, blockers: string[]}}
 */
function retirementCheck(operation, input) {
    const blockers = [];
    const current = input.current;
    const exp = input.expectation || {};
    const bindings = input.observedBindings || {};
    if (operation.state !== E.OperationState.UNKNOWN) blockers.push('NOT_UNKNOWN');
    if (operation.issuedAt === null || current.tick <= operation.issuedAt + 1) blockers.push('LATENT_EFFECT');
    const parts = parseOperationKey(operation.operationKey);
    const roomName = exp.roomName || (isRoomName(parts.domain) ? parts.domain : null);
    const room = roomName ? current.rooms[roomName] : null;
    if (!room || room.visibility !== E.Visibility.VISIBLE) blockers.push('NO_VISIBILITY');
    if (parts.action === 'spawn') {
        if (!ownCreepsComplete(current)) blockers.push('CREEPS_INCOMPLETE');
        if (room && room.energyAvailable.value === null) blockers.push('BALANCE_UNKNOWN');
        const name = exp.creepName || shortCreepName(operation.operationKey);
        if (current.ownCreeps[name]) blockers.push('CANDIDATE_ALIVE');
        for (const r in current.rooms) {
            for (let i = 0; i < current.rooms[r].spawns.length; i++) {
                const s = current.rooms[r].spawns[i];
                if (s.spawning && s.spawning.name === name) blockers.push('CANDIDATE_SPAWNING');
            }
        }
        for (const n in current.ownCreeps) {
            const c = current.ownCreeps[n];
            if (c.strategyEnvelope && c.strategyEnvelope.operationKey === operation.operationKey) blockers.push('CANDIDATE_ENVELOPE');
            const body = c.body.map(function (p) { return p.type; });
            const b = bindings[n];
            const legacyOwned = (b && b.legacyRole) || c.legacyRole;
            if (!c.strategyEnvelope && !legacyOwned && Array.isArray(exp.body) && sameBody(body, exp.body)) blockers.push('UNRESOLVED_CANDIDATE');
        }
        if (!Array.isArray(exp.body)) blockers.push('BODY_UNKNOWN');
    } else {
        // MOVE/CAPACITY (ARCHITECTURE §5): both nodes visible with known balance, the
        // target capacity known, and no possible continuation by the actor.
        const ctx = { current: current, previous: null };
        const actor = resolveRef(operation.actorRef, exp.actorId, ctx);
        const target = resolveRef(operation.targetRef, exp.targetId, ctx);
        const ends = [actor, target];
        const state = [];
        for (let k = 0; k < ends.length; k++) {
            const ref = ends[k];
            if (ref === null) { blockers.push('NODE_UNRESOLVED'); state.push(null); continue; }
            const creep = creepById(current, ref.id);
            const node = creep ? null : findNode(current, ref.id);
            if (!creep && !node) { blockers.push(k === 0 ? 'ACTOR_NOT_VISIBLE' : 'NODE_NOT_VISIBLE'); state.push(null); continue; }
            const visibleRoom = current.rooms[creep ? creep.roomName : node.roomName];
            if (!visibleRoom || visibleRoom.visibility !== E.Visibility.VISIBLE) blockers.push('NODE_NOT_VISIBLE');
            const amount = creep ? creep.store.energy : node.amount;
            const capacity = creep ? creep.store.capacity : node.capacity;
            if (amount.value === null) blockers.push('NODE_BALANCE_UNKNOWN');
            if (capacity.value === null) blockers.push('CAPACITY_UNKNOWN');
            state.push({ creep: creep, pos: creep ? creep.pos : node.pos, amount: amount.value, capacity: capacity.value });
        }
        const a = state[0];
        const t = state[1];
        if (a && t && a.creep) {
            const adjacent = near(a.pos, t.pos);
            const giver = parts.action === 'withdraw' ? t : a;
            const taker = parts.action === 'withdraw' ? a : t;
            // a living adjacent actor that can still move energy giver -> taker may continue
            if (adjacent && giver.amount !== null && giver.amount > 0 && taker.capacity !== null && taker.amount !== null && taker.capacity - taker.amount > 0) {
                blockers.push('CONTINUATION_POSSIBLE');
            }
        }
    }
    const unique = sortedUnique(blockers);
    return { retire: unique.length === 0, blockers: unique };
}

const OBS_KIND = Object.freeze({
    TRANSFER: E.ObservedOperationKind.TRANSFER,
    HARVEST: E.ObservedOperationKind.HARVEST,
    BUILD: E.ObservedOperationKind.BUILD,
    REPAIR: E.ObservedOperationKind.REPAIR,
    UPGRADE_CONTROLLER: E.ObservedOperationKind.UPGRADE,
});

/**
 * Legacy/world actions seen in shadow (no operationKey of ours).
 *   events -> TRANSFER/HARVEST/BUILD/REPAIR/UPGRADE ('obs:<KIND>:<eventKey>');
 *   spawning starts (snapshot T-1 vs T) -> SPAWN ('obs:SPAWN:<room>:<spawnId>:<name>:<startTick>');
 *   derived pickups/drops -> PICKUP / OTHER ('obs:PICKUP|DROP:<room>:<tick>:<creep>'),
 *   DERIVED quality, UNKNOWN effect when ambiguous.
 * @param {{events: object[], previous: object|null, current: object}} input
 * @returns {object[]} ObservedOperation[] sorted by observationKey
 */
function observeOperations(input) {
    const events = Array.isArray(input.events) ? input.events : [];
    const current = input.current;
    const previous = input.previous || null;
    const out = [];
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (!Object.prototype.hasOwnProperty.call(OBS_KIND, e.type)) continue;
        const isTransfer = e.type === E.NormalizedEventType.TRANSFER;
        const isHarvest = e.type === E.NormalizedEventType.HARVEST;
        out.push({
            observationKey: 'obs:' + OBS_KIND[e.type] + ':' + e.eventKey,
            kind: OBS_KIND[e.type],
            roomName: e.roomName,
            actorRef: isTransfer ? e.sourceId : e.actorId,
            targetRef: isHarvest ? e.sourceId : e.targetId,
            firstSeen: e.observedAt,
            lastSeen: e.observedAt,
            effect: E.EffectKind.CONFIRMED,
            amount: e.amount,
            energyAmount: e.energyAmount,
            eventKeys: [e.eventKey],
        });
    }
    const starts = spawnStarts(previous, current);
    for (let i = 0; i < starts.length; i++) {
        const s = starts[i];
        const cost = s.cost === null ? unknownMeasure(ReasonCode.MISSING_FIELD) : measured(s.cost, E.Quality.DERIVED);
        out.push({
            observationKey: 'obs:SPAWN:' + s.roomName + ':' + s.spawnId + ':' + s.creepName + ':' + s.startTick,
            kind: E.ObservedOperationKind.SPAWN,
            roomName: s.roomName,
            actorRef: s.spawnId,
            targetRef: s.creepName,
            firstSeen: current.tick,
            lastSeen: current.tick,
            effect: E.EffectKind.CONFIRMED,
            amount: cost,
            energyAmount: cost,
            eventKeys: [],
        });
    }
    const piles = derivePileTransfers(previous, current, events);
    for (let i = 0; i < piles.length; i++) {
        const p = piles[i];
        out.push({
            observationKey: 'obs:' + p.kind + ':' + p.roomName + ':' + p.effectTick + ':' + p.creepName,
            kind: p.kind === 'PICKUP' ? E.ObservedOperationKind.PICKUP : E.ObservedOperationKind.OTHER,
            roomName: p.roomName,
            actorRef: p.actorId,
            targetRef: p.pileId,
            firstSeen: current.tick,
            lastSeen: current.tick,
            effect: p.ambiguous ? E.EffectKind.UNKNOWN : E.EffectKind.CONFIRMED,
            amount: measured(p.amount, E.Quality.DERIVED),
            energyAmount: measured(p.amount, E.Quality.DERIVED),
            eventKeys: [],
        });
    }
    out.sort(function (a, b) { return a.observationKey < b.observationKey ? -1 : (a.observationKey > b.observationKey ? 1 : 0); });
    return out;
}

module.exports = {
    EVENT_ACTIONS,
    PARTIAL_ACTIONS,
    matchEffects,
    applyEffect,
    retirementCheck,
    observeOperations,
};
