// Retention and limits of schema1 v1 (ARCHITECTURE §6 "Ретенция v1").
// Pure functions: values in, values out; no Memory access.
//
//   - ring/window limits are domain LIMITS (30 flow windows, 100 decisions per room);
//   - <= 256 unfinished operations per room, 10 slots reserved for CRITICAL;
//   - completed sequential occurrences compact into a monotone closed-through
//     watermark per series (domain/ownerEpoch/demand/generation/action);
//     an unclosed gap is never skipped; completed one-off operations compact
//     into a dedup record by key;
//   - 256 KiB serialized-state threshold: optional writes are refused, disputed
//     data is never dropped for space (degradation is reported instead);
//   - shadow rooms (<= LIMITS.shadowRooms) are evicted by writer 'state' only
//     when stale and not holding disputed/quarantined data.

const { REJECTED, READY } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { fingerprint } = require('../domain/fingerprint');
const E = require('../domain/enums');
const { own, put, has } = require('./objects');

const OPERATION_LIMITS = Object.freeze({ unfinishedPerRoom: 256, criticalReserve: 10 });
const SIZE_LIMIT_BYTES = 256 * 1024;
/** Shadow rooms not observed for this many ticks may be evicted when a limit is near. */
const ROOM_EVICTION_MIN_AGE = 1500;
/** Shadow rooms not observed for this many ticks are evicted by compaction regardless of pressure (intel retention). */
const ROOM_RETENTION_TICKS = 30000;
/** Start evicting stale rooms when this close to LIMITS.shadowRooms. */
const ROOM_HEADROOM = 4;

const TERMINAL_OPERATION_STATES = Object.freeze([E.OperationState.CONFIRMED, E.OperationState.UNKNOWN_RETIRED]);
const OPEN_RESERVATION_STATES = Object.freeze([E.ReservationState.RESERVED, E.ReservationState.ISSUED, E.ReservationState.PARTIAL]);
const NUMERIC = /^(?:0|[1-9]\d{0,14})$/;

function isUnfinished(operation) {
    return TERMINAL_OPERATION_STATES.indexOf(operation.state) === -1;
}

/**
 * Admission of one more unfinished operation in a room.
 * @param {number} unfinishedInRoom current unfinished operations of the room
 * @param {string} criticality Criticality
 * @returns {object} READY({remaining}) | REJECTED(BUDGET_DEFERRED, {...})
 */
function admitOperation(unfinishedInRoom, criticality) {
    const limit = OPERATION_LIMITS.unfinishedPerRoom;
    const cap = criticality === E.Criticality.CRITICAL ? limit : limit - OPERATION_LIMITS.criticalReserve;
    if (unfinishedInRoom >= cap) {
        return REJECTED(ReasonCode.BUDGET_DEFERRED, { limit: 'UNFINISHED_OPERATIONS', unfinished: unfinishedInRoom, cap: cap, criticality: criticality });
    }
    return READY({ remaining: cap - unfinishedInRoom - 1 }, fingerprint({ unfinishedInRoom: unfinishedInRoom, criticality: criticality }));
}

/**
 * @param {Object<string, object>} operations Operation records by key
 * @param {function(object): (string|null)} roomOf room of an operation (actor/target lookup is the caller's)
 * @returns {Object<string, number>}
 */
function countUnfinishedByRoom(operations, roomOf) {
    const out = {};
    Object.keys(operations).forEach(function (key) {
        const op = own(operations, key);
        if (!isUnfinished(op)) return;
        const room = roomOf(op) || '?';
        out[room] = (own(out, room) || 0) + 1;
    });
    return out;
}

function seriesOf(operationKey) {
    const cut = operationKey.lastIndexOf('/');
    return { series: operationKey.slice(0, cut), occurrence: operationKey.slice(cut + 1) };
}

/**
 * Compact completed (CONFIRMED) operations.
 * Sequential (numeric) occurrences advance `closedThrough` only over a
 * contiguous CONFIRMED prefix: a missing or unfinished occurrence stops the
 * watermark (gaps are never skipped). Non-numeric (one-off) CONFIRMED
 * operations move to `dedup`. UNKNOWN / UNKNOWN_RETIRED / NO_EFFECT stay.
 * Inputs are not mutated.
 * @param {Object<string, object>} operations
 * @param {Object<string, {seriesKey:string, closedThrough:number, compactedCount:number, confirmedAmount:number, updatedAt:number}>} watermarks
 * @param {Object<string, {operationKey:string, confirmedAmount:number, updatedAt:number}>} dedup
 * @returns {{operations:Object, watermarks:Object, dedup:Object, compacted:string[], belowWatermark:string[]}}
 */
function compactOccurrences(operations, watermarks, dedup) {
    const ops = {};
    const marks = {};
    const dd = {};
    Object.keys(operations).forEach(function (k) { put(ops, k, own(operations, k)); });
    Object.keys(watermarks || {}).forEach(function (k) { put(marks, k, Object.assign({}, own(watermarks, k))); });
    Object.keys(dedup || {}).forEach(function (k) { put(dd, k, own(dedup, k)); });
    const compacted = [];
    const belowWatermark = [];
    const bySeries = {};
    Object.keys(ops).sort().forEach(function (key) {
        const op = own(ops, key);
        const s = seriesOf(key);
        if (!NUMERIC.test(s.occurrence)) {
            if (op.state === E.OperationState.CONFIRMED) {
                put(dd, key, { operationKey: key, confirmedAmount: op.confirmedAmount, updatedAt: op.updatedAt });
                delete ops[key];
                compacted.push(key);
            }
            return;
        }
        if (!has(bySeries, s.series)) put(bySeries, s.series, {});
        put(own(bySeries, s.series), s.occurrence, key);
    });
    Object.keys(bySeries).sort().forEach(function (series) {
        const existing = own(marks, series);
        const mark = existing || { seriesKey: series, closedThrough: -1, compactedCount: 0, confirmedAmount: 0, updatedAt: 0 };
        const occ = own(bySeries, series);
        Object.keys(occ).forEach(function (n) { if (Number(n) <= mark.closedThrough) belowWatermark.push(own(occ, n)); });
        let next = mark.closedThrough + 1;
        let advanced = false;
        while (has(occ, String(next)) && own(ops, own(occ, String(next))).state === E.OperationState.CONFIRMED) {
            const key = own(occ, String(next));
            const op = own(ops, key);
            mark.closedThrough = next;
            mark.compactedCount += 1;
            mark.confirmedAmount += op.confirmedAmount;
            if (op.updatedAt > mark.updatedAt) mark.updatedAt = op.updatedAt;
            compacted.push(key);
            delete ops[key];
            next++;
            advanced = true;
        }
        if (advanced || existing) put(marks, series, mark);
    });
    belowWatermark.sort();
    return { operations: ops, watermarks: marks, dedup: dd, compacted: compacted, belowWatermark: belowWatermark };
}

/** Last tick any shadow data of the room was observed/computed, or null. */
function roomLastSeen(room) {
    let last = null;
    function see(t) { if (typeof t === 'number' && (last === null || t > last)) last = t; }
    if (room.eventCursor) see(room.eventCursor.lastObservedAt);
    if (room.forecast) see(room.forecast.computedAt);
    for (let i = 0; i < room.flowWindows.length; i++) see(room.flowWindows[i].windowEnd);
    for (let i = 0; i < room.decisionRing.length; i++) see(room.decisionRing[i].tick);
    Object.keys(room.observedBindings).forEach(function (k) { see(own(room.observedBindings, k).lastSeen); });
    return last;
}

/**
 * Rooms holding data that must not be dropped for space: open (incl.
 * disputed) shadow reservations and observed operations with UNKNOWN effect.
 * @param {object} shadowRoot
 * @returns {Object<string, string>} room -> reason
 */
function roomsWithDisputedData(shadowRoot) {
    const out = {};
    const res = shadowRoot.ledger.reservations;
    Object.keys(res).forEach(function (k) {
        const r = own(res, k);
        if (OPEN_RESERVATION_STATES.indexOf(r.state) !== -1 || r.unknownAmount > 0) out[r.roomName] = 'OPEN_RESERVATION';
    });
    const obs = shadowRoot.observedOperations;
    Object.keys(obs).forEach(function (k) {
        const o = own(obs, k);
        if (o.effect === E.EffectKind.UNKNOWN && !out[o.roomName]) out[o.roomName] = 'UNKNOWN_EFFECT';
    });
    return out;
}

/**
 * Choose shadow rooms to evict (stalest first).
 * @param {object} shadowRoot
 * @param {{tick:number, need:number, minAge:number, protectedRooms:Object<string, string>}} options
 *   need: number of rooms that must go (0 = only rooms older than minAge, i.e. retention GC)
 *   protectedRooms: room -> reason (touched by the batch, quarantined data, ...)
 * @returns {{evict:string[], blocked:Array<{room:string, reason:string}>, satisfied:boolean}}
 */
function selectEvictableRooms(shadowRoot, options) {
    const disputed = roomsWithDisputedData(shadowRoot);
    const candidates = [];
    const blocked = [];
    Object.keys(shadowRoot.rooms).forEach(function (name) {
        const reason = own(options.protectedRooms || {}, name) || own(disputed, name);
        if (reason) { blocked.push({ room: name, reason: reason }); return; }
        const last = roomLastSeen(own(shadowRoot.rooms, name));
        const age = last === null ? Infinity : options.tick - last;
        if (age < options.minAge) { blocked.push({ room: name, reason: 'RECENTLY_OBSERVED' }); return; }
        candidates.push({ room: name, age: age });
    });
    candidates.sort(function (a, b) { return a.age !== b.age ? (a.age > b.age ? -1 : 1) : (a.room < b.room ? -1 : 1); });
    const count = options.need > 0 ? Math.min(options.need, candidates.length) : candidates.length;
    const evict = candidates.slice(0, count).map(function (c) { return c.room; }).sort();
    blocked.sort(function (a, b) { return a.room < b.room ? -1 : 1; });
    return { evict: evict, blocked: blocked, satisfied: evict.length >= options.need };
}

module.exports = {
    OPERATION_LIMITS,
    SIZE_LIMIT_BYTES,
    ROOM_EVICTION_MIN_AGE,
    ROOM_RETENTION_TICKS,
    ROOM_HEADROOM,
    admitOperation,
    countUnfinishedByRoom,
    compactOccurrences,
    roomLastSeen,
    roomsWithDisputedData,
    selectEvictableRooms,
};
