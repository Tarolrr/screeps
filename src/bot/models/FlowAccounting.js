// FlowAccounting (A3, contract A.2 §4.2, DESIGN §3, docs/strategy/RECONCILIATION.md).
//
// Pure model: energy flows of a room between two consecutive snapshots
// (FlowDelta) and 100-tick aggregates (FlowWindow). Values only; no world or
// persisted-state access.
//
// Rules:
//   - every unit is counted once: the room balance is the sum of the room's
//     EnergyNodes (spawn/extension, storage/container/link/terminal, cargo,
//     piles); spawnPool:<room> is a ledger node only and is never added;
//   - harvest by an own creep is income; transfer/withdraw/pickup/drop between
//     own nodes is internalTransfer and NEVER income; transfers with a foreign
//     or untracked object (tower, lab, hostile creep) are externalIn/externalOut;
//   - spawn cost is charged once, in the delta where a new spawning creep is
//     first seen in spawn.spawning (there is no EVENT_SPAWN);
//   - build/repair/upgrade use NormalizedEvent.energyAmount (UNKNOWN stays UNKNOWN;
//     BUILD.amount is progress, not energy);
//   - decayLoss: dropped-resource decay ceil(amount/1000) and link loss
//     ceil(amount*0.03) (DERIVED);
//   - the remainder of the balance change is `unexplained`; a non-zero value adds
//     UNEXPLAINED_BALANCE and lowers quality to ESTIMATED;
//   - a gap / lost visibility / non-consecutive snapshots give a delta whose
//     flows are all UNKNOWN; a window touched by such a delta is UNKNOWN, never 0.

const { measured, unknownMeasure, FLOW_FIELDS, FLOW_WINDOW_TICKS } = require('../domain/dtos');
const { fingerprint } = require('../domain/fingerprint');
const { READY, REJECTED } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { Quality, NormalizedEventType, Visibility, EventLogStatus } = require('../domain/enums');

/** Engine BODYPART_COST (common/lib/constants.js). */
const BODYPART_COST = Object.freeze({ move: 50, work: 100, attack: 80, carry: 50, heal: 250, ranged_attack: 150, tough: 10, claim: 600 });
const ENERGY_DECAY = 1000;
const LINK_LOSS_RATIO = 0.03;
const TOWER_ENERGY_COST = 10;
/** Upper bound of the decay-rounding tolerance per room delta (energy units). */
const MAX_PILE_ROUNDING = 3;
/** Structure types that define a room's energy topology. */
const TOPOLOGY_OBJECT_TYPES = Object.freeze(['spawn', 'extension', 'storage', 'container', 'link', 'tower']);

const QUALITY_RANK = Object.freeze({ OBSERVED: 4, DERIVED: 3, ESTIMATED: 2, STALE: 1, UNKNOWN: 0 });

/**
 * @param {Array<string|{type:string}>} body
 * @returns {number|null} cost, null when a part is unknown
 */
function bodyCost(body) {
    if (!Array.isArray(body)) return null;
    let total = 0;
    for (let i = 0; i < body.length; i++) {
        const type = typeof body[i] === 'string' ? body[i] : (body[i] && body[i].type);
        if (!Object.prototype.hasOwnProperty.call(BODYPART_COST, type)) return null;
        total += BODYPART_COST[type];
    }
    return total;
}

function worseQuality(a, b) {
    return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

/** Mutable accumulator of a Measured sum. */
function acc() {
    return { value: 0, quality: Quality.OBSERVED, reason: null };
}

function addTo(a, m) {
    if (a.value === null) return;
    if (m.value === null) { a.value = null; a.quality = Quality.UNKNOWN; a.reason = m.reason; return; }
    a.value += m.value;
    a.quality = worseQuality(a.quality, m.quality);
}

function addValue(a, value, quality) {
    if (a.value === null) return;
    a.value += value;
    a.quality = worseQuality(a.quality, quality);
}

function setUnknown(a, reason) {
    if (a.value === null) return;
    a.value = null; a.quality = Quality.UNKNOWN; a.reason = reason;
}

function toMeasured(a) {
    return a.value === null ? unknownMeasure(a.reason) : measured(a.value, a.quality);
}

function allUnknownFlows(reason) {
    const flows = {};
    for (let i = 0; i < FLOW_FIELDS.length; i++) flows[FLOW_FIELDS[i]] = unknownMeasure(reason);
    return flows;
}

function sortedUnique(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) if (out.indexOf(list[i]) === -1) out.push(list[i]);
    out.sort();
    return out;
}

function unknownDelta(roomName, fromTick, toTick, reason) {
    return { roomName: roomName, fromTick: fromTick, toTick: toTick, flows: allUnknownFlows(reason), quality: Quality.UNKNOWN, reasonCodes: [reason] };
}

/**
 * Object id -> {nodeId, objectType, nodeClass} for one room of one snapshot;
 * own creeps are mapped by their object id to 'creep:<name>'.
 */
function nodeIndex(snapshot, roomName) {
    const index = {};
    const room = snapshot && snapshot.rooms ? snapshot.rooms[roomName] : null;
    if (room) {
        for (let i = 0; i < room.energyNodes.length; i++) {
            const n = room.energyNodes[i];
            // REMOTE nodes (source energy) are not stock and never a transfer endpoint
            if (n.nodeClass !== 'CARGO' && n.nodeClass !== 'REMOTE') index[n.nodeId] = { nodeId: n.nodeId, objectType: n.objectType, nodeClass: n.nodeClass, node: n };
        }
    }
    if (snapshot && snapshot.ownCreeps) {
        for (const name in snapshot.ownCreeps) {
            const c = snapshot.ownCreeps[name];
            if (c.id) index[c.id] = { nodeId: 'creep:' + name, objectType: 'creep', nodeClass: 'CARGO', creepName: name, node: null };
        }
    }
    return index;
}

function mergedIndex(previous, current, roomName) {
    const a = nodeIndex(previous, roomName);
    const b = nodeIndex(current, roomName);
    for (const k in b) a[k] = b[k];
    return a;
}

/**
 * Spawning starts between previous and current: a spawn whose spawning name is
 * new compared with the previous snapshot. Seen exactly once per start.
 * @returns {Array<{roomName, spawnId, creepName, startTick, cost: number|null, body: string[]|null}>}
 */
function spawnStarts(previous, current) {
    const out = [];
    // after a gap the start tick is unknown: the delta of that interval is UNKNOWN anyway
    if (!previous || !current || current.tick !== previous.tick + 1) return out;
    for (const roomName in current.rooms) {
        const room = current.rooms[roomName];
        const prevRoom = previous.rooms[roomName];
        if (room.visibility !== Visibility.VISIBLE || !prevRoom || prevRoom.visibility !== Visibility.VISIBLE) continue;
        const prevSpawning = {};
        for (let i = 0; i < prevRoom.spawns.length; i++) {
            const s = prevRoom.spawns[i];
            if (s.spawning) prevSpawning[s.id] = s.spawning.name;
        }
        for (let i = 0; i < room.spawns.length; i++) {
            const s = room.spawns[i];
            if (!s.spawning || prevSpawning[s.id] === s.spawning.name) continue;
            const creep = current.ownCreeps[s.spawning.name] || null;
            const body = creep ? creep.body.map(function (p) { return p.type; }) : null;
            out.push({ roomName: roomName, spawnId: s.id, creepName: s.spawning.name, startTick: previous.tick, cost: body ? bodyCost(body) : null, body: body });
        }
    }
    out.sort(function (a, b) { return a.spawnId < b.spawnId ? -1 : (a.spawnId > b.spawnId ? 1 : 0); });
    return out;
}

function near(a, b) {
    return !!a && !!b && a.roomName === b.roomName && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
}

/**
 * Pickups/drops derived from neighbouring snapshots (no pickup/drop events
 * exist). Quality at most DERIVED. A creep whose residual cargo change cannot be
 * tied to exactly one adjacent dropped-resource pile is `ambiguous`.
 * @param {object|null} previous Snapshot at T-1
 * @param {object} current Snapshot at T
 * @param {object[]} events NormalizedEvents of effectTick T-1
 * @returns {Array<{kind:'PICKUP'|'DROP', roomName, creepName, actorId, pileId: string|null, amount: number, effectTick, ambiguous: boolean}>}
 */
function derivePileTransfers(previous, current, events) {
    const out = [];
    if (!previous || !current || current.tick !== previous.tick + 1) return out;
    const net = {}; // creep id -> net cargo change explained by events, null if unknown
    function bump(id, m, sign) {
        if (!id) return;
        if (!Object.prototype.hasOwnProperty.call(net, id)) net[id] = 0;
        if (net[id] === null) return;
        net[id] = m.value === null ? null : net[id] + sign * m.value;
    }
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.effectTick !== previous.tick) continue;
        if (e.type === NormalizedEventType.TRANSFER) { bump(e.sourceId, e.energyAmount, -1); bump(e.targetId, e.energyAmount, +1); }
        else if (e.type === NormalizedEventType.HARVEST) bump(e.targetId, e.energyAmount, +1);
        else if (e.type === NormalizedEventType.BUILD || e.type === NormalizedEventType.REPAIR || e.type === NormalizedEventType.UPGRADE_CONTROLLER) bump(e.actorId, e.energyAmount, -1);
    }
    const names = Object.keys(current.ownCreeps).sort();
    const claims = {}; // pileId -> total claimed
    const candidates = [];
    for (let k = 0; k < names.length; k++) {
        const name = names[k];
        const cur = current.ownCreeps[name];
        const prev = previous.ownCreeps[name];
        if (!prev || !prev.roomName || prev.roomName !== cur.roomName || prev.spawning) continue;
        const prevRoom = previous.rooms[prev.roomName];
        const curRoom = current.rooms[prev.roomName];
        if (!prevRoom || !curRoom || prevRoom.visibility !== Visibility.VISIBLE || curRoom.visibility !== Visibility.VISIBLE) continue;
        if (prev.store.energy.value === null || cur.store.energy.value === null) continue;
        const explained = Object.prototype.hasOwnProperty.call(net, cur.id) ? net[cur.id] : 0;
        if (explained === null) continue;
        const residual = cur.store.energy.value - prev.store.energy.value - explained;
        if (residual === 0) continue;
        const kind = residual > 0 ? 'PICKUP' : 'DROP';
        const piles = [];
        const curPiles = {};
        for (let i = 0; i < curRoom.energyNodes.length; i++) if (curRoom.energyNodes[i].objectType === 'resource') curPiles[curRoom.energyNodes[i].nodeId] = curRoom.energyNodes[i];
        const prevPiles = {};
        for (let i = 0; i < prevRoom.energyNodes.length; i++) if (prevRoom.energyNodes[i].objectType === 'resource') prevPiles[prevRoom.energyNodes[i].nodeId] = prevRoom.energyNodes[i];
        if (kind === 'PICKUP') {
            for (const id in prevPiles) {
                const p = prevPiles[id];
                if (!near(p.pos, prev.pos) || p.amount.value === null) continue;
                const after = curPiles[id] ? curPiles[id].amount.value : 0;
                if (after === null) continue;
                if (p.amount.value - after > 0) piles.push(id);
            }
        } else {
            for (const id in curPiles) {
                const p = curPiles[id];
                if (!near(p.pos, prev.pos) || p.amount.value === null) continue;
                const before = prevPiles[id] ? prevPiles[id].amount.value : 0;
                if (before !== null && p.amount.value - before > 0) piles.push(id);
            }
        }
        piles.sort();
        if (piles.length === 0) continue; // no pile involved: stays in `unexplained`, not a pickup/drop
        const amount = Math.abs(residual);
        const pileId = piles.length === 1 ? piles[0] : null;
        if (pileId !== null) claims[pileId] = (claims[pileId] || 0) + amount;
        candidates.push({ kind: kind, roomName: prev.roomName, creepName: name, actorId: cur.id, pileId: pileId, amount: amount, effectTick: previous.tick, ambiguous: pileId === null, prevPiles: prevPiles, curPiles: curPiles });
    }
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c.ambiguous && c.kind === 'PICKUP') {
            const before = c.prevPiles[c.pileId].amount.value;
            const after = c.curPiles[c.pileId] ? c.curPiles[c.pileId].amount.value : 0;
            // more claimed than the pile lost (beyond decay rounding) -> cannot attribute
            if (claims[c.pileId] > before - after + Math.ceil(before / ENERGY_DECAY)) c.ambiguous = true;
        }
        out.push({ kind: c.kind, roomName: c.roomName, creepName: c.creepName, actorId: c.actorId, pileId: c.pileId, amount: c.amount, effectTick: c.effectTick, ambiguous: c.ambiguous });
    }
    return out;
}

function roomGap(gaps, roomName, tick) {
    if (!Array.isArray(gaps)) return null;
    for (let i = 0; i < gaps.length; i++) {
        const g = gaps[i];
        if (g.roomName === roomName && g.fromTick <= tick && tick <= g.toTick) return g.reasonCode;
    }
    return null;
}

/**
 * Stock balance of a room. REMOTE nodes (energy still in a remote source) are
 * NOT stock: a source drop is the origin of harvest income and regeneration is
 * not income, so they never enter the balance.
 */
function sumNodes(room) {
    let total = 0;
    for (let i = 0; i < room.energyNodes.length; i++) {
        if (room.energyNodes[i].nodeClass === 'REMOTE') continue;
        const v = room.energyNodes[i].amount.value;
        if (v === null) return null;
        total += v;
    }
    return total;
}

function cargoRooms(snapshot) {
    const out = {};
    if (!snapshot) return out;
    for (const roomName in snapshot.rooms) {
        const nodes = snapshot.rooms[roomName].energyNodes;
        for (let i = 0; i < nodes.length; i++) if (nodes[i].nodeClass === 'CARGO') out[nodes[i].nodeId] = { roomName: roomName, node: nodes[i] };
    }
    return out;
}

function deltaForRoom(roomName, previous, current, events, gaps, pileTransfers, starts) {
    const prevRoom = previous.rooms[roomName];
    const curRoom = current.rooms[roomName];
    if (!prevRoom || prevRoom.visibility !== Visibility.VISIBLE || curRoom.visibility !== Visibility.VISIBLE) {
        return unknownDelta(roomName, previous.tick, current.tick, ReasonCode.NO_VISIBILITY);
    }
    if (current.tick !== previous.tick + 1) return unknownDelta(roomName, previous.tick, current.tick, ReasonCode.EVENT_GAP);
    const gapReason = roomGap(gaps, roomName, previous.tick);
    if (gapReason !== null) return unknownDelta(roomName, previous.tick, current.tick, gapReason);
    if (curRoom.eventLog.status !== EventLogStatus.CAPTURED || curRoom.eventLog.effectTick !== previous.tick) {
        return unknownDelta(roomName, previous.tick, current.tick, ReasonCode.EVENT_GAP);
    }

    const reasons = [];
    const f = {};
    for (let i = 0; i < FLOW_FIELDS.length; i++) f[FLOW_FIELDS[i]] = acc();
    const index = mergedIndex(previous, current, roomName);
    const own = function (id) { return id !== null && Object.prototype.hasOwnProperty.call(index, id); };
    const ownCreep = function (id) { return own(id) && index[id].nodeClass === 'CARGO'; };

    let filtered = curRoom.eventLog.entries.length !== curRoom.eventLog.rawLength;
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.roomName !== roomName || e.effectTick !== previous.tick) continue;
        switch (e.type) {
            case NormalizedEventType.TRANSFER: {
                if (e.resourceType !== 'energy') break;
                const s = own(e.sourceId);
                const t = own(e.targetId);
                if (s && t) {
                    addTo(f.internalTransfer, e.energyAmount);
                    if (index[e.sourceId].objectType === 'link' && index[e.targetId].objectType === 'link' && e.energyAmount.value !== null) {
                        addValue(f.decayLoss, Math.ceil(e.energyAmount.value * LINK_LOSS_RATIO), Quality.DERIVED);
                    }
                } else if (s) addTo(f.externalOut, e.energyAmount);
                else if (t) addTo(f.externalIn, e.energyAmount);
                break;
            }
            case NormalizedEventType.HARVEST:
                if (ownCreep(e.targetId)) addTo(f.harvest, e.energyAmount);
                break;
            case NormalizedEventType.BUILD:
                if (ownCreep(e.actorId)) addTo(f.build, e.energyAmount);
                break;
            case NormalizedEventType.REPAIR:
                // own creeps and own energy-node structures (towers, contract A.3)
                if (own(e.actorId)) addTo(f.repair, e.energyAmount);
                break;
            case NormalizedEventType.ATTACK:
            case NormalizedEventType.HEAL:
                // tower attack/heal spends TOWER_ENERGY_COST from a tracked node; no
                // 'defense' flow field in A.2/A.3 -> booked as externalOut (energy leaves the node set)
                if (own(e.actorId) && index[e.actorId].objectType === 'tower') addValue(f.externalOut, TOWER_ENERGY_COST, Quality.DERIVED);
                break;
            case NormalizedEventType.UPGRADE_CONTROLLER:
                if (ownCreep(e.actorId)) addTo(f.upgrade, e.energyAmount);
                break;
            default:
                break;
        }
    }

    // spawn cost, once at the observed spawning start
    for (let i = 0; i < starts.length; i++) {
        if (starts[i].roomName !== roomName) continue;
        if (starts[i].cost === null) setUnknown(f.spawnSpend, ReasonCode.MISSING_FIELD);
        else addValue(f.spawnSpend, starts[i].cost, Quality.DERIVED);
    }

    // pickups/drops: internal, derived
    let pileTolerance = 0;
    let roundingApplied = false;
    for (let i = 0; i < pileTransfers.length; i++) {
        const p = pileTransfers[i];
        if (p.roomName !== roomName) continue;
        pileTolerance++;
        addValue(f.internalTransfer, p.amount, Quality.DERIVED);
        if (p.ambiguous && reasons.indexOf(ReasonCode.AMBIGUOUS_EFFECT) === -1) reasons.push(ReasonCode.AMBIGUOUS_EFFECT);
    }

    // decay of dropped resources that are still present (vanished piles: rounding tolerance)
    const curIds = {};
    for (let i = 0; i < curRoom.energyNodes.length; i++) curIds[curRoom.energyNodes[i].nodeId] = curRoom.energyNodes[i];
    for (let i = 0; i < prevRoom.energyNodes.length; i++) {
        const n = prevRoom.energyNodes[i];
        if (n.objectType !== 'resource') continue;
        if (n.amount.value === null) { setUnknown(f.decayLoss, ReasonCode.MISSING_FIELD); continue; }
        if (curIds[n.nodeId]) addValue(f.decayLoss, Math.ceil(n.amount.value / ENERGY_DECAY), Quality.DERIVED);
        else pileTolerance++;
    }

    // cargo crossing room borders
    const prevCargo = cargoRooms(previous);
    const curCargo = cargoRooms(current);
    for (const nodeId in curCargo) {
        const c = curCargo[nodeId];
        const p = prevCargo[nodeId];
        if (!p || p.roomName === c.roomName) continue;
        if (c.roomName === roomName) addTo(f.externalIn, c.node.amount);
        else if (p.roomName === roomName) addTo(f.externalOut, c.node.amount);
    }

    // balance: every node once
    const before = sumNodes(prevRoom);
    const after = sumNodes(curRoom);
    const parts = ['harvest', 'externalIn', 'externalOut', 'spawnSpend', 'build', 'repair', 'upgrade', 'decayLoss'];
    let known = before !== null && after !== null;
    for (let i = 0; i < parts.length && known; i++) if (f[parts[i]].value === null) known = false;
    if (!known) {
        setUnknown(f.unexplained, ReasonCode.MISSING_FIELD);
        if (reasons.indexOf(ReasonCode.MISSING_FIELD) === -1) reasons.push(ReasonCode.MISSING_FIELD);
    } else {
        const explained = f.harvest.value + f.externalIn.value - f.externalOut.value - f.spawnSpend.value - f.build.value - f.repair.value - f.upgrade.value - f.decayLoss.value;
        let rest = (after - before) - explained;
        const tolerance = Math.min(pileTolerance, MAX_PILE_ROUNDING);
        if (Math.abs(rest) <= tolerance && rest !== 0) {
            // decay rounding on picked-up/vanished piles (<= 1 per pile, bounded):
            // booked as decay, flagged by DERIVED quality of decayLoss
            addValue(f.decayLoss, -rest, Quality.DERIVED);
            rest = 0;
            roundingApplied = true;
        }
        f.unexplained.value = rest;
        f.unexplained.quality = Quality.DERIVED;
        if (rest !== 0) reasons.push(ReasonCode.UNEXPLAINED_BALANCE);
    }
    if (filtered && reasons.indexOf(ReasonCode.MISSING_FIELD) === -1) reasons.push(ReasonCode.MISSING_FIELD);

    const flows = {};
    let quality = Quality.OBSERVED;
    for (let i = 0; i < FLOW_FIELDS.length; i++) {
        flows[FLOW_FIELDS[i]] = toMeasured(f[FLOW_FIELDS[i]]);
        if (FLOW_FIELDS[i] !== 'unexplained' && flows[FLOW_FIELDS[i]].value !== null) quality = worseQuality(quality, flows[FLOW_FIELDS[i]].quality);
    }
    for (let i = 0; i < FLOW_FIELDS.length; i++) if (flows[FLOW_FIELDS[i]].value === null) quality = worseQuality(quality, Quality.ESTIMATED);
    if (roundingApplied) quality = worseQuality(quality, Quality.DERIVED);
    if (reasons.indexOf(ReasonCode.UNEXPLAINED_BALANCE) !== -1 || filtered || reasons.indexOf(ReasonCode.AMBIGUOUS_EFFECT) !== -1) quality = worseQuality(quality, Quality.ESTIMATED);
    return { roomName: roomName, fromTick: previous.tick, toTick: current.tick, flows: flows, quality: quality, reasonCodes: sortedUnique(reasons) };
}

/**
 * Flows of every room of `current` since `previous`.
 * @param {{previous: object|null, current: object, events: object[], gaps: object[]}} input
 * @returns {object} READY(FlowDelta[]) sorted by roomName; [] without a previous snapshot
 */
function accountFlows(input) {
    if (!input || !input.current || !input.current.rooms) return REJECTED(ReasonCode.INVALID_RECORD, { what: 'current' });
    const previous = input.previous || null;
    const current = input.current;
    const events = Array.isArray(input.events) ? input.events : [];
    const gaps = Array.isArray(input.gaps) ? input.gaps : [];
    const inputFp = fingerprint({ previous: previous ? previous.fingerprint : null, current: current.fingerprint, events: events.map(function (e) { return e.eventKey; }), gaps: gaps });
    if (previous === null) return READY([], inputFp);
    if (!(current.tick > previous.tick)) return REJECTED(ReasonCode.STALE_INPUT, { previousTick: previous.tick, currentTick: current.tick });
    const pileTransfers = derivePileTransfers(previous, current, events);
    const starts = spawnStarts(previous, current);
    const out = [];
    const rooms = Object.keys(current.rooms).sort();
    for (let i = 0; i < rooms.length; i++) out.push(deltaForRoom(rooms[i], previous, current, events, gaps, pileTransfers, starts));
    return READY(out, inputFp);
}

/**
 * @param {string} roomName
 * @param {number} windowStart multiple of 100
 * @returns {object|null} accumulator window: nothing covered yet (flows are 0 only
 *          together with ticksCovered 0; any gap turns them UNKNOWN)
 */
function emptyWindow(roomName, windowStart, topology) {
    const flows = {};
    for (let i = 0; i < FLOW_FIELDS.length; i++) flows[FLOW_FIELDS[i]] = measured(0);
    return { roomName: roomName, windowStart: windowStart, windowEnd: windowStart + FLOW_WINDOW_TICKS, ticksCovered: 0, complete: false, topologyVersion: typeof topology === 'string' ? topology : null, flows: flows, quality: Quality.OBSERVED, reasonCodes: [] };
}

/**
 * Fold one FlowDelta into a FlowWindow (returns a new window). Only the part of
 * the delta overlapping [windowStart, windowEnd) counts; an UNKNOWN delta makes
 * every flow of the window UNKNOWN and adds no covered ticks.
 * @param {object} window FlowWindow
 * @param {object} delta FlowDelta
 * @param {string} [topology] topologyVersion observed for the delta; a window keeps a
 *        version only while every folded delta had the same one (else null = unproven)
 * @returns {object} FlowWindow
 */
function mergeDelta(window, delta, topology) {
    const from = Math.max(window.windowStart, delta.fromTick);
    const to = Math.min(window.windowEnd, delta.toTick);
    if (delta.roomName !== window.roomName || to <= from) return window;
    const flows = {};
    const unknownDeltaFlag = delta.quality === Quality.UNKNOWN;
    for (let i = 0; i < FLOW_FIELDS.length; i++) {
        const name = FLOW_FIELDS[i];
        const a = { value: window.flows[name].value, quality: window.flows[name].quality, reason: window.flows[name].reason };
        if (unknownDeltaFlag) setUnknown(a, delta.flows[name].reason || delta.reasonCodes[0] || ReasonCode.EVENT_GAP);
        else addTo(a, delta.flows[name]);
        flows[name] = toMeasured(a);
    }
    const ticksCovered = window.ticksCovered + (unknownDeltaFlag ? 0 : to - from);
    const quality = worseQuality(window.quality, delta.quality);
    return {
        roomName: window.roomName,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        ticksCovered: Math.min(FLOW_WINDOW_TICKS, ticksCovered),
        complete: ticksCovered >= FLOW_WINDOW_TICKS && quality !== Quality.UNKNOWN,
        topologyVersion: topology === undefined || window.topologyVersion === topology ? window.topologyVersion : null,
        flows: flows,
        quality: quality,
        reasonCodes: sortedUnique(window.reasonCodes.concat(delta.reasonCodes)),
    };
}

/**
 * Aggregate the deltas of one room into the window starting at windowStart.
 * @param {number} windowStart
 * @param {object[]} deltas FlowDelta[] of one room
 * @param {string[]} [topologies] topologyVersion per delta (same order); omitted -> null
 * @returns {object|null} FlowWindow, null when no delta touches the window
 */
function closeWindow(windowStart, deltas, topologies) {
    if (!Array.isArray(deltas) || deltas.length === 0 || windowStart % FLOW_WINDOW_TICKS !== 0) return null;
    const topo = Array.isArray(topologies) ? topologies : null;
    let window = emptyWindow(deltas[0].roomName, windowStart, topo ? topo[0] : null);
    let touched = false;
    for (let i = 0; i < deltas.length; i++) {
        const d = deltas[i];
        if (Math.min(window.windowEnd, d.toTick) <= Math.max(windowStart, d.fromTick)) continue;
        window = mergeDelta(window, d, topo ? topo[i] : null);
        touched = true;
    }
    return touched ? window : null;
}

/**
 * Energy topology of a room (FlowWindow.topologyVersion): fingerprint of the
 * ids/positions of spawn/extension/storage/container/link/tower nodes, the source
 * ids, and the multiset of own creeps (spawning included) by legacyRole and body
 * signature. Creeps are taken empire-wide: stage-A homes are often unknown and a
 * moving hauler must not flap the room topology; any change of the composition
 * (death without replacement, a new body) changes the version, which is the
 * conservative direction (A4 resets statistics). Unknown room -> null.
 * @param {object} snapshot
 * @param {string} roomName
 * @returns {string|null}
 */
function topologyVersion(snapshot, roomName) {
    const room = snapshot && snapshot.rooms ? snapshot.rooms[roomName] : null;
    if (!room || room.visibility !== Visibility.VISIBLE) return null;
    const structures = [];
    for (let i = 0; i < room.energyNodes.length; i++) {
        const n = room.energyNodes[i];
        if (TOPOLOGY_OBJECT_TYPES.indexOf(n.objectType) !== -1) structures.push([n.objectType, n.nodeId, n.pos ? n.pos.x + ',' + n.pos.y : null]);
    }
    const sources = room.sources.map(function (s) { return s.id; });
    const creeps = [];
    for (const name in snapshot.ownCreeps) {
        const c = snapshot.ownCreeps[name];
        creeps.push((c.legacyRole || '?') + ':' + c.body.map(function (p) { return p.type + (p.boost ? '+' + p.boost : ''); }).join(','));
    }
    creeps.sort();
    return fingerprint({ structures: structures, sources: sources, creeps: creeps });
}

/**
 * Window starts touched by a delta, ascending.
 * @param {object} delta
 * @returns {number[]}
 */
function windowStartsOf(delta) {
    const out = [];
    const first = delta.fromTick - (delta.fromTick % FLOW_WINDOW_TICKS);
    for (let s = first; s < delta.toTick; s += FLOW_WINDOW_TICKS) out.push(s);
    return out;
}

module.exports = {
    BODYPART_COST,
    ENERGY_DECAY,
    LINK_LOSS_RATIO,
    TOWER_ENERGY_COST,
    MAX_PILE_ROUNDING,
    bodyCost,
    topologyVersion,
    spawnStarts,
    derivePileTransfers,
    accountFlows,
    emptyWindow,
    mergeDelta,
    closeWindow,
    windowStartsOf,
    unknownDelta,
};
