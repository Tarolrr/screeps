// BudgetLedger (A4): pure energy-node accounting of reservations
// (DESIGN §3, ARCHITECTURE §5, CONTRACTS-A §4.4). Stage A computes
// hypothetical/shadow values only: nothing here issues an intent.
//
// Rules implemented here:
//   - free in a node = observed amount − active reservations of that node
//     (− disputed part); observed UNKNOWN => free UNKNOWN;
//   - future income never grants spending now: admit() only looks at free;
//   - MOVE holds its source node and never adds energy to its target;
//   - CAPACITY reserves store space / spawn lanes, not energy (not in free);
//   - a disputed reservation (not terminal, unknownAmount > 0) closes optional
//     spending of its node; RETIRED no longer holds the node, but its unknown
//     upper bound still counts against mission exposure limits;
//   - SPEND on spawning lives on 'spawnPool:<room>' whose observed value is
//     RoomSnapshot.energyAvailable; SETTLED/RELEASED reservations hold nothing,
//     so a confirmed spawn is never subtracted twice from the snapshot;
//   - applySettlement() is idempotent per (tick, actor, action, target).

'use strict';

const E = require('../domain/enums');
const { measured, unknownMeasure, validateReservation, validateLedgerView, isDisputedReservation } = require('../domain/dtos');
const { spawnPoolNodeId, parseOperationKey, isOperationKey, buildOperationKey } = require('../domain/keys');
const { READY, REJECTED } = require('../domain/results');
const { fingerprint } = require('../domain/fingerprint');
const { canonicalJson } = require('../domain/canonical');
const { validateStatePatch } = require('../domain/stateLayout');

const ENERGY = 'energy';
const Q_RANK = { OBSERVED: 0, DERIVED: 1, ESTIMATED: 2, STALE: 3, UNKNOWN: 4 };

/** @param {string[]} qualities @returns {string} the worst quality */
function worstQuality(qualities) {
    let worst = E.Quality.OBSERVED;
    for (let i = 0; i < qualities.length; i++) if (Q_RANK[qualities[i]] > Q_RANK[worst]) worst = qualities[i];
    return worst;
}

/** @param {object} r Reservation @returns {number} amount still held (not settled/released/unknown) */
function outstandingAmount(r) {
    if (E.RESERVATION_TRANSITIONS[r.state].length === 0) return 0;
    return Math.max(0, r.amount - r.settledAmount - r.releasedAmount - r.unknownAmount);
}

/** @param {*} reservations array or record of Reservation @returns {object[]} sorted by reservationId */
function toReservationList(reservations) {
    const list = [];
    if (Array.isArray(reservations)) {
        for (let i = 0; i < reservations.length; i++) list.push(reservations[i]);
    } else if (reservations && typeof reservations === 'object') {
        for (const key in reservations) if (Object.prototype.hasOwnProperty.call(reservations, key)) list.push(reservations[key]);
    }
    list.sort(function (a, b) { return a.reservationId < b.reservationId ? -1 : a.reservationId > b.reservationId ? 1 : 0; });
    return list;
}

function pickRoom(snapshot, roomName) {
    if (roomName) return roomName;
    const names = Object.keys(snapshot.rooms);
    return names.length === 1 ? names[0] : null;
}

/**
 * Liquid-node classification used by the forecast (each unit counted once):
 * the spawn pool replaces individual spawn/extension nodes; REMOTE and towers
 * are excluded (not withdrawable liquidity at home).
 * @param {object} roomSnapshot
 * @returns {Object<string,string>} nodeId -> nodeClass for nodes of the room
 */
function nodeClasses(roomSnapshot) {
    const out = {};
    for (let i = 0; i < roomSnapshot.energyNodes.length; i++) {
        const n = roomSnapshot.energyNodes[i];
        // contract A.3 adds 'tower' to STORAGE_CONTAINER: tower energy cannot be withdrawn, so it is not liquidity
        out[n.nodeId] = n.objectType === 'tower' ? 'TOWER' : n.nodeClass;
    }
    out[spawnPoolNodeId(roomSnapshot.roomName)] = 'SPAWN_POOL';
    return out;
}

/**
 * LedgerView of one room: every EnergyNode of the snapshot plus the
 * 'spawnPool:<room>' node, plus nodes referenced by live reservations that are
 * no longer observed (observed UNKNOWN(MISSING_FIELD): losing the node does not
 * prove the energy was not spent).
 *
 * SPEND/MOVE reservations held on an individual spawn/extension node also
 * count against the spawn pool (the pool draws on the same energy).
 *
 * @param {object} snapshot Snapshot (contract A.2)
 * @param {object[]|Object<string,object>} reservations Reservation list/record (any rooms)
 * @param {string} [roomName] required when the snapshot has several rooms
 * @returns {object} LedgerView
 */
function createLedgerView(snapshot, reservations, roomName) {
    const room = pickRoom(snapshot, roomName);
    if (!room || !snapshot.rooms[room]) throw new TypeError('createLedgerView: unknown room ' + String(roomName));
    const rs = snapshot.rooms[room];
    const pool = spawnPoolNodeId(room);
    const nodes = {};
    for (let i = 0; i < rs.energyNodes.length; i++) {
        const n = rs.energyNodes[i];
        nodes[n.nodeId] = { nodeId: n.nodeId, observed: n.amount, reserved: 0, disputed: 0, nodeClass: n.nodeClass };
    }
    nodes[pool] = { nodeId: pool, observed: rs.energyAvailable, reserved: 0, disputed: 0, nodeClass: 'SPAWN_POOL' };
    const list = toReservationList(reservations);
    for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.roomName !== room || r.resourceType !== ENERGY) continue;
        if (r.kind === E.ReservationKind.CAPACITY) continue;
        const held = outstandingAmount(r);
        const disputed = isDisputedReservation(r) ? r.unknownAmount : 0;
        if (held === 0 && disputed === 0) continue;
        if (!nodes[r.nodeId]) nodes[r.nodeId] = { nodeId: r.nodeId, observed: unknownMeasure('MISSING_FIELD'), reserved: 0, disputed: 0, nodeClass: null };
        nodes[r.nodeId].reserved += held;
        nodes[r.nodeId].disputed += disputed;
        if (nodes[r.nodeId].nodeClass === 'SPAWN_EXTENSION') {
            nodes[pool].reserved += held;
            nodes[pool].disputed += disputed;
        }
    }
    const ids = Object.keys(nodes).sort();
    const out = [];
    for (let i = 0; i < ids.length; i++) {
        const n = nodes[ids[i]];
        const free = n.observed.value === null
            ? unknownMeasure(n.observed.reason || 'MISSING_FIELD')
            : measured(n.observed.value - n.reserved - n.disputed, n.reserved + n.disputed > 0 ? E.Quality.DERIVED : n.observed.quality);
        out.push({ nodeId: n.nodeId, observed: n.observed, reserved: n.reserved, disputed: n.disputed, free: free });
    }
    return { roomName: room, tick: snapshot.tick, nodes: out };
}

/**
 * Liquid energy of a room, each unit once: spawn pool + storage/container/link/
 * terminal + cargo + piles of the room (individual spawn/extension nodes are
 * inside the pool; REMOTE nodes excluded).
 * @param {object} snapshot
 * @param {object} ledgerView LedgerView of the same room
 * @returns {{observed: object, free: object, reserved: number, disputed: number}} observed/free Measured
 */
function liquidity(snapshot, ledgerView) {
    const classes = nodeClasses(snapshot.rooms[ledgerView.roomName]);
    let observed = 0;
    let free = 0;
    let reserved = 0;
    let disputed = 0;
    const qualities = [];
    let unknownReason = null;
    for (let i = 0; i < ledgerView.nodes.length; i++) {
        const n = ledgerView.nodes[i];
        const cls = classes[n.nodeId];
        if (cls === 'SPAWN_EXTENSION' || cls === 'REMOTE' || cls === 'TOWER') continue;
        if (cls === undefined && n.reserved + n.disputed === 0) continue;
        reserved += n.reserved;
        disputed += n.disputed;
        if (n.observed.value === null) { unknownReason = unknownReason || n.observed.reason || 'MISSING_FIELD'; continue; }
        observed += n.observed.value;
        free += n.free.value;
        qualities.push(n.free.quality, n.observed.quality);
    }
    if (unknownReason) return { observed: unknownMeasure(unknownReason), free: unknownMeasure(unknownReason), reserved: reserved, disputed: disputed };
    return { observed: measured(observed, worstQuality(qualities)), free: measured(free, worstQuality(qualities.concat(reserved + disputed > 0 ? [E.Quality.DERIVED] : []))), reserved: reserved, disputed: disputed };
}

/**
 * Exposure of a mission: everything that is or may be spent under it —
 * settled + held + unknown, including the unknown upper bound of RETIRED.
 * @param {object[]|Object<string,object>} reservations
 * @param {string} missionId
 * @returns {number}
 */
function missionExposure(reservations, missionId) {
    const list = toReservationList(reservations);
    let total = 0;
    for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.missionId !== missionId || r.kind !== E.ReservationKind.SPEND) continue;
        total += r.settledAmount + r.unknownAmount + outstandingAmount(r);
    }
    return total;
}

function isEssential(context, proposal) {
    if (context && context.emergency === true) return true;
    for (let i = 0; i < proposal.demands.length; i++) if (proposal.demands[i].criticality === E.Criticality.CRITICAL) return true;
    return false;
}

/** Deterministic reservation id of request `index` of a proposal. */
function reservationIdFor(proposalId, index) {
    return 'res:' + proposalId + ':' + index;
}

/**
 * Demand paid by request `index`: the only demand of the proposal, or the
 * demand with the same index when requests and demands pair one-to-one.
 * @returns {object|null}
 */
function demandForRequest(proposal, index) {
    if (proposal.demands.length === 1) return proposal.demands[0];
    if (proposal.demands.length === proposal.reservationRequests.length) return proposal.demands[index];
    return null;
}

/**
 * operationKey of the payment a request funds: domain/ownerEpoch/demandStableKey/
 * generation/action/occurrence (spawn on the pool -> 'spawn', occurrence '0').
 * paymentKeyOfReservation() parses it back to '<demandStableKey>#g<generation>',
 * the key of the demand/replacement payment, so the calendar counts it once.
 */
function requestOperationKey(roomName, ownerEpoch, demand, req) {
    const action = req.kind === E.ReservationKind.SPEND ? (req.nodeId.indexOf('spawnPool:') === 0 ? 'spawn' : 'spend') : String(req.kind).toLowerCase();
    return buildOperationKey({ domain: roomName, ownerEpoch: ownerEpoch, demandStableKey: demand.stableKey, generation: demand.generation, action: action, occurrence: '0' });
}

/**
 * Class map of the room's nodes for admit(): lets a request on an individual
 * spawn/extension node be checked against the spawn pool as well.
 * @param {object} snapshot
 * @param {string} roomName
 * @returns {Object<string,string>} nodeId -> nodeClass ('SPAWN_POOL' for the pool)
 */
function ledgerNodeClasses(snapshot, roomName) {
    return nodeClasses(snapshot.rooms[roomName]);
}

function sameRequest(prior, req, roomName) {
    return prior.kind === req.kind && prior.nodeId === req.nodeId && prior.targetNodeId === req.targetNodeId &&
        prior.resourceType === req.resourceType && prior.amount === req.amount && prior.roomName === roomName;
}

/**
 * Hypothetical admission of a proposal's reservation requests (stage A: the
 * result is never executed). Requests are processed sequentially against a
 * running copy of node free values: nothing is funded by future income.
 *
 * Every energy SPEND must pay for an identifiable demand (one demand, or one
 * demand per request); its reservation carries the demand's operationKey so
 * the forecast never counts the reservation as a second payment. Without a
 * demand identity the proposal is REJECTED(INVALID_RECORD, NO_DEMAND_IDENTITY).
 *
 * @param {{tick:number, revision?:number|null, domainStatus?:string, emergency?:boolean, ownerEpoch?:number,
 *          existingReservations?:object[]|Object<string,object>, missionLimits?:Object<string,number>,
 *          nodeClasses?:Object<string,string>}} context
 *        missionLimits requires existingReservations (unknown exposure is never 0);
 *        nodeClasses (ledgerNodeClasses) enables the pool cross-check of spawn/extension requests
 * @param {object} proposal Proposal
 * @param {object} ledgerView LedgerView of proposal's room at context.tick
 * @returns {object} READY({reservations, expectedRevision}) | REJECTED(INSUFFICIENT_LIQUIDITY|STALE_INPUT|UNCERTAIN_FUNDING|INVALID_RECORD)
 */
function admit(context, proposal, ledgerView) {
    const revision = context.revision === undefined ? null : context.revision;
    if (proposal.expectedRevision !== null && revision !== null && proposal.expectedRevision !== revision) {
        return REJECTED('STALE_INPUT', { expectedRevision: proposal.expectedRevision, actualRevision: revision });
    }
    if (ledgerView.tick !== context.tick || (proposal.roomName !== null && proposal.roomName !== ledgerView.roomName)) {
        return REJECTED('STALE_INPUT', { ledgerTick: ledgerView.tick, tick: context.tick, ledgerRoom: ledgerView.roomName });
    }
    const essential = isEssential(context, proposal);
    if (context.domainStatus === E.DomainStatus.UNCERTAIN_FUNDING && !essential) {
        return REJECTED('UNCERTAIN_FUNDING', { roomName: ledgerView.roomName, reason: 'DOMAIN_UNCERTAIN' });
    }
    const hasLimit = proposal.missionId !== null && context.missionLimits && typeof context.missionLimits[proposal.missionId] === 'number';
    if (hasLimit && context.existingReservations === undefined) {
        return REJECTED('UNCERTAIN_FUNDING', { reason: 'EXPOSURE_UNKNOWN', missionId: proposal.missionId });
    }
    const ownerEpoch = context.ownerEpoch === undefined ? 0 : context.ownerEpoch;
    if (!(Number.isInteger(ownerEpoch) && ownerEpoch >= 0)) return REJECTED('INVALID_RECORD', { reason: 'OWNER_EPOCH' });

    // Idempotent re-admission: the same proposal is already reserved (and already
    // reflected in the ledger view) -> return those reservations, charge nothing.
    // Partial, released or changed priors are not a re-admission: STALE_INPUT.
    const existing = toReservationList(context.existingReservations || []);
    const byId = {};
    for (let i = 0; i < existing.length; i++) byId[existing[i].reservationId] = existing[i];
    if (proposal.reservationRequests.length > 0) {
        const again = [];
        for (let i = 0; i < proposal.reservationRequests.length; i++) {
            const prior = byId[reservationIdFor(proposal.proposalId, i)];
            if (!prior) continue;
            if (prior.state === E.ReservationState.RELEASED) return REJECTED('STALE_INPUT', { reason: 'PRIOR_RELEASED', reservationId: prior.reservationId });
            if (!sameRequest(prior, proposal.reservationRequests[i], ledgerView.roomName)) return REJECTED('STALE_INPUT', { reason: 'READMISSION_MISMATCH', reservationId: prior.reservationId });
            again.push(prior);
        }
        if (again.length === proposal.reservationRequests.length) return READY({ reservations: again, expectedRevision: revision }, fingerprint({ p: proposal.proposalId, v: ledgerView }));
        if (again.length > 0) return REJECTED('STALE_INPUT', { reason: 'PARTIAL_READMISSION', found: again.length });
    }
    const nodes = {};
    for (let i = 0; i < ledgerView.nodes.length; i++) nodes[ledgerView.nodes[i].nodeId] = ledgerView.nodes[i];
    const classes = context.nodeClasses || null;
    const pool = 'spawnPool:' + ledgerView.roomName;
    const running = {};
    function freeOf(id) { return running[id] === undefined ? nodes[id].free.value : running[id]; }
    let missionSpend = 0;
    const out = [];
    for (let i = 0; i < proposal.reservationRequests.length; i++) {
        const req = proposal.reservationRequests[i];
        const node = nodes[req.nodeId];
        const d = demandForRequest(proposal, i);
        const pays = req.kind === E.ReservationKind.SPEND && req.resourceType === ENERGY;
        if (pays && d === null) return REJECTED('INVALID_RECORD', { request: i, reason: 'NO_DEMAND_IDENTITY' });
        if (d !== null && d.roomName !== ledgerView.roomName) return REJECTED('INVALID_RECORD', { request: i, reason: 'DEMAND_ROOM_MISMATCH' });
        if (req.kind !== E.ReservationKind.CAPACITY && req.resourceType === ENERGY) {
            if (!node) return REJECTED('INSUFFICIENT_LIQUIDITY', { request: i, nodeId: req.nodeId, reason: 'UNKNOWN_NODE' });
            if (node.free.value === null) return REJECTED('UNCERTAIN_FUNDING', { request: i, nodeId: req.nodeId, reason: 'NODE_UNKNOWN' });
            if (node.disputed > 0 && !essential) return REJECTED('UNCERTAIN_FUNDING', { request: i, nodeId: req.nodeId, reason: 'NODE_DISPUTED', disputed: node.disputed });
            const free = freeOf(req.nodeId);
            if (req.amount > free) return REJECTED('INSUFFICIENT_LIQUIDITY', { request: i, nodeId: req.nodeId, free: free, amount: req.amount });
            // A spawn/extension draws on the same energy as the pool: check and charge both.
            const viaPool = classes !== null && classes[req.nodeId] === 'SPAWN_EXTENSION' && nodes[pool];
            if (viaPool) {
                if (nodes[pool].free.value === null) return REJECTED('UNCERTAIN_FUNDING', { request: i, nodeId: pool, reason: 'NODE_UNKNOWN' });
                if (nodes[pool].disputed > 0 && !essential) return REJECTED('UNCERTAIN_FUNDING', { request: i, nodeId: pool, reason: 'NODE_DISPUTED', disputed: nodes[pool].disputed });
                if (req.amount > freeOf(pool)) return REJECTED('INSUFFICIENT_LIQUIDITY', { request: i, nodeId: pool, free: freeOf(pool), amount: req.amount });
                running[pool] = freeOf(pool) - req.amount;
            }
            running[req.nodeId] = free - req.amount;
            if (req.kind === E.ReservationKind.SPEND) missionSpend += req.amount;
        }
        const reservation = {
            reservationId: reservationIdFor(proposal.proposalId, i), kind: req.kind, state: E.ReservationState.RESERVED,
            missionId: proposal.missionId, operationKey: d === null ? null : requestOperationKey(ledgerView.roomName, ownerEpoch, d, req),
            roomName: ledgerView.roomName, nodeId: req.nodeId,
            targetNodeId: req.targetNodeId, resourceType: req.resourceType, amount: req.amount,
            settledAmount: 0, releasedAmount: 0, unknownAmount: 0, dueAt: req.dueAt, createdAt: context.tick, updatedAt: context.tick,
        };
        const v = validateReservation(reservation);
        if (!v.ok) return REJECTED('INVALID_RECORD', { request: i, errors: v.errors });
        out.push(reservation);
    }
    if (hasLimit) {
        const exposure = missionExposure(existing, proposal.missionId);
        const limit = context.missionLimits[proposal.missionId];
        if (exposure + missionSpend > limit) return REJECTED('INSUFFICIENT_LIQUIDITY', { reason: 'MISSION_LIMIT', missionId: proposal.missionId, exposure: exposure, requested: missionSpend, limit: limit });
    }
    return READY({ reservations: out, expectedRevision: revision }, fingerprint({ p: proposal.proposalId, v: ledgerView }));
}

// ---------------------------------------------------------------- lifecycle (pure transitions)

function transition(r, to, tick, changes) {
    if (!E.canTransition(E.RESERVATION_TRANSITIONS, r.state, to)) return REJECTED('INVALID_RECORD', { reservationId: r.reservationId, from: r.state, to: to });
    const next = Object.assign({}, r, changes, { state: to, updatedAt: Math.max(r.updatedAt, tick) });
    const v = validateReservation(next);
    if (!v.ok) return REJECTED('INVALID_RECORD', { reservationId: r.reservationId, errors: v.errors });
    return READY(next, fingerprint(next));
}

/** RESERVED -> ISSUED (a command was handed over; ISSUED is not a spend). */
function issue(reservation, tick) {
    if (reservation.state === E.ReservationState.ISSUED) return READY(reservation, fingerprint(reservation));
    return transition(reservation, E.ReservationState.ISSUED, tick, {});
}

/** Release the held (not settled, not unknown) part; disputed part is never released silently. */
function release(reservation, tick) {
    if (reservation.unknownAmount > 0) return REJECTED('UNCERTAIN_FUNDING', { reservationId: reservation.reservationId, unknownAmount: reservation.unknownAmount });
    const held = outstandingAmount(reservation);
    return transition(reservation, E.ReservationState.RELEASED, tick, { releasedAmount: reservation.releasedAmount + held });
}

/** Mark `amount` of the held part as of unknown outcome (ISSUED/PARTIAL stay; becomes disputed). */
function markUnknown(reservation, amount, tick) {
    const held = outstandingAmount(reservation);
    const add = Math.min(held, Math.max(0, amount));
    return transition(reservation, reservation.state, tick, { unknownAmount: reservation.unknownAmount + add });
}

/**
 * UNKNOWN_RETIRED: the disputed part stops holding the node (the new observed
 * balance is the physical base) but stays in missionExposure; the held rest is released.
 * Preconditions of ARCHITECTURE §5 (full visibility, no continuation) are the caller's evidence.
 */
function retire(reservation, tick) {
    if (!(reservation.unknownAmount > 0)) return REJECTED('INVALID_RECORD', { reservationId: reservation.reservationId, reason: 'NOTHING_DISPUTED' });
    const held = outstandingAmount(reservation);
    return transition(reservation, E.ReservationState.RETIRED, tick, { releasedAmount: reservation.releasedAmount + held });
}

/** Canonical settlement key of a confirmed effect. */
function settlementKey(confirmation) {
    return canonicalJson([confirmation.tick, confirmation.actor, confirmation.action, confirmation.target === undefined ? null : confirmation.target]);
}

/**
 * Apply a confirmed effect to a reservation. Idempotent: a confirmation whose
 * (tick, actor, action, target) is already in `appliedKeys` charges nothing.
 * The confirmed amount first resolves the disputed part, then the held part.
 * The snapshot is never touched: settling only removes the promise.
 *
 * @param {object} reservation
 * @param {{tick:number, actor:string, action:string, target?:string|null, amount:number}} confirmation
 * @param {string[]} appliedKeys settlement keys already applied to this reservation (kept by the caller)
 * @param {number} tick
 * @returns {object} READY({reservation, appliedKeys, charged})
 */
function applySettlement(reservation, confirmation, appliedKeys, tick) {
    const key = settlementKey(confirmation);
    const keys = (appliedKeys || []).slice();
    if (keys.indexOf(key) !== -1) return READY({ reservation: reservation, appliedKeys: keys, charged: 0 }, fingerprint({ r: reservation, k: keys }));
    if (reservation.state === E.ReservationState.RESERVED) {
        const issued = issue(reservation, tick);
        if (issued.kind !== 'READY') return issued;
        reservation = issued.value;
    }
    const open = reservation.unknownAmount + outstandingAmount(reservation);
    const charged = Math.min(open, Math.max(0, confirmation.amount));
    const fromUnknown = Math.min(reservation.unknownAmount, charged);
    const settled = reservation.settledAmount + charged;
    const unknownLeft = reservation.unknownAmount - fromUnknown;
    const complete = settled + reservation.releasedAmount === reservation.amount && unknownLeft === 0;
    const to = complete ? E.ReservationState.SETTLED : settled > 0 ? E.ReservationState.PARTIAL : reservation.state;
    if (charged === 0) {
        keys.push(key);
        keys.sort();
        return READY({ reservation: reservation, appliedKeys: keys, charged: 0 }, fingerprint({ r: reservation, k: keys }));
    }
    const next = transition(reservation, to, tick, { settledAmount: settled, unknownAmount: unknownLeft });
    if (next.kind !== 'READY') return next;
    keys.push(key);
    keys.sort();
    return READY({ reservation: next.value, appliedKeys: keys, charged: charged }, fingerprint({ r: next.value, k: keys }));
}

/**
 * Stable payment key of a reservation for the forecast calendar: a reservation
 * that pays for a demand generation maps to '<demandStableKey>#g<generation>'
 * (the same key as the demand/replacement payment, so the payment is counted once).
 * @param {object} r Reservation
 * @returns {string}
 */
function paymentKeyOfReservation(r) {
    if (r.operationKey && isOperationKey(r.operationKey)) {
        const p = parseOperationKey(r.operationKey);
        return p.demandStableKey + '#g' + p.generation;
    }
    return 'reservation:' + r.reservationId;
}

// ---------------------------------------------------------------- patches (writer 'finance')

/**
 * @param {object} reservation
 * @param {string} patchId
 * @returns {object} StatePatch for strategyShadow.ledger.reservations.<id>
 */
function reservationPatch(reservation, patchId) {
    const patch = { patchId: patchId, writer: E.StateWriter.FINANCE, namespace: 'strategyShadow', path: ['ledger', 'reservations', reservation.reservationId], op: E.PatchOp.SET, value: reservation };
    const v = validateStatePatch(patch);
    if (!v.ok) throw new TypeError('invalid reservation patch: ' + JSON.stringify(v.errors));
    return patch;
}

/** @returns {{ok:boolean}} validation of a LedgerView (convenience re-export) */
function validateView(view) { return validateLedgerView(view); }

module.exports = {
    ENERGY,
    worstQuality,
    outstandingAmount,
    toReservationList,
    createLedgerView,
    liquidity,
    missionExposure,
    admit,
    ledgerNodeClasses,
    reservationIdFor,
    issue,
    release,
    markUnknown,
    retire,
    settlementKey,
    applySettlement,
    paymentKeyOfReservation,
    reservationPatch,
    validateView,
};
