// EventNormalizer (A3, contract A.2 §4.2, ARCHITECTURE §5, docs/strategy/RECONCILIATION.md).
//
// Pure: turns the raw event log captured in a RoomSnapshot into NormalizedEvent
// DTOs and keeps a per-room processed cursor. No Game/Memory/globals.
//
// Identity of an event is (roomName, effectTick = observedAt - 1,
// originalArrayIndex) of the unmodified getEventLog() array. Filtering by the
// reader never renumbers indices; identical entries at different indices stay
// distinct. Re-processing an already processed effectTick is a no-op. A skipped
// tick, lost visibility or an unavailable log becomes an EventGap: nothing is
// invented for the lost interval (no zero events).
//
// Engine facts (local @screeps/engine 4.3.0, to be re-checked in A6):
//   EVENT_* codes 1..12 (common/lib/constants.js);
//   transfer:  {event:12, objectId: creep,     data:{targetId: target, resourceType, amount}}
//   withdraw:  {event:12, objectId: structure, data:{targetId: creep,  resourceType, amount}}
//              -> objectId is always the source, data.targetId the receiver; the
//                 caller (creep) is not recorded, so actorId is null for TRANSFER;
//   harvest:   {event:5, objectId: creep, data:{targetId, amount}} (no resourceType;
//              energy iff the target is a source of the room);
//   build:     {event:4, data:{targetId, amount: boostedEffect, ...}} (no energySpent);
//   repair:    {event:7, data:{targetId, amount, energySpent}};
//   upgrade:   {event:9, data:{amount, energySpent}};
//   there is no EVENT_SPAWN and no pickup/drop event.

const { measured, unknownMeasure } = require('../domain/dtos');
const { eventKey, isRoomName } = require('../domain/keys');
const { fingerprint } = require('../domain/fingerprint');
const { READY, UNKNOWN, REJECTED } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { NormalizedEventType, EventLogStatus, Quality } = require('../domain/enums');

/** Raw EVENT_* code -> NormalizedEventType. Unmapped codes -> OTHER. */
const RAW_EVENT_TYPES = Object.freeze({
    1: NormalizedEventType.ATTACK,
    2: NormalizedEventType.OBJECT_DESTROYED,
    3: NormalizedEventType.ATTACK_CONTROLLER,
    4: NormalizedEventType.BUILD,
    5: NormalizedEventType.HARVEST,
    6: NormalizedEventType.HEAL,
    7: NormalizedEventType.REPAIR,
    8: NormalizedEventType.RESERVE_CONTROLLER,
    9: NormalizedEventType.UPGRADE_CONTROLLER,
    10: NormalizedEventType.EXIT,
    11: NormalizedEventType.POWER,
    12: NormalizedEventType.TRANSFER,
});

/** BUILD_POWER of the engine: one unboosted WORK part spends at most this much energy per build. */
const BUILD_POWER = 5;

function finiteNumber(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
}

function str(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function dataOf(entry) {
    return entry.data !== null && typeof entry.data === 'object' && !Array.isArray(entry.data) ? entry.data : {};
}

/**
 * Energy spent by an unboosted BUILD: the engine spends buildEffect =
 * min(WORK*5, remaining, carried) and records amount = boostedEffect, which equals
 * buildEffect when no WORK part is boosted. With any boosted WORK part, or an
 * unknown body, the energy is UNKNOWN (amount is NOT energy).
 */
function buildEnergy(amount, actorBody) {
    if (amount === null) return unknownMeasure(ReasonCode.MISSING_FIELD);
    if (!Array.isArray(actorBody)) return unknownMeasure(ReasonCode.MISSING_FIELD);
    let work = 0;
    for (let i = 0; i < actorBody.length; i++) {
        const part = actorBody[i];
        if (part.type !== 'work') continue;
        if (part.boost !== null && part.boost !== undefined) return unknownMeasure(ReasonCode.MISSING_FIELD);
        work++;
    }
    if (work === 0 || amount > work * BUILD_POWER) return unknownMeasure(ReasonCode.MISSING_FIELD);
    return measured(amount, Quality.DERIVED);
}

/**
 * @param {object} entry RawEventEntry
 * @param {object} ctx {roomName, effectTick, observedAt, rawFingerprint, sourceIds, bodies}
 * @returns {object} NormalizedEvent
 */
function normalizeEntry(entry, ctx) {
    const type = Object.prototype.hasOwnProperty.call(RAW_EVENT_TYPES, entry.event) ? RAW_EVENT_TYPES[entry.event] : NormalizedEventType.OTHER;
    const data = dataOf(entry);
    const objectId = str(entry.objectId);
    const targetId = str(data.targetId);
    let actorId = objectId;
    let sourceId = null;
    let target = targetId;
    let resourceType = str(data.resourceType);
    let amountValue = finiteNumber(data.amount);
    let energy;

    switch (type) {
        case NormalizedEventType.TRANSFER:
            // transfer and withdraw share the code; objectId is the giver in both.
            actorId = null;
            sourceId = objectId;
            energy = resourceType === 'energy'
                ? (amountValue === null ? unknownMeasure(ReasonCode.MISSING_FIELD) : measured(amountValue))
                : (resourceType === null ? unknownMeasure(ReasonCode.MISSING_FIELD) : measured(0, Quality.DERIVED));
            break;
        case NormalizedEventType.HARVEST:
            sourceId = targetId;
            target = objectId;
            if (targetId !== null && ctx.sourceIds[targetId] === true) {
                resourceType = 'energy';
                energy = amountValue === null ? unknownMeasure(ReasonCode.MISSING_FIELD) : measured(amountValue);
            } else if (targetId !== null && ctx.knownTargets && !ctx.sourcesIncomplete) {
                energy = measured(0, Quality.DERIVED); // not a source of a complete source list: mineral/deposit
            } else {
                // a source may have been dropped from the snapshot (sources.* in missingFields): UNKNOWN, not 0
                energy = unknownMeasure(ReasonCode.MISSING_FIELD);
            }
            break;
        case NormalizedEventType.BUILD: {
            const spent = finiteNumber(data.energySpent);
            if (spent !== null) energy = measured(spent);
            else energy = buildEnergy(amountValue, objectId !== null && ctx.bodies[objectId] ? ctx.bodies[objectId] : null);
            resourceType = 'energy';
            break;
        }
        case NormalizedEventType.REPAIR:
        case NormalizedEventType.UPGRADE_CONTROLLER: {
            const spent = finiteNumber(data.energySpent);
            energy = spent !== null ? measured(spent) : unknownMeasure(ReasonCode.MISSING_FIELD);
            resourceType = 'energy';
            break;
        }
        case NormalizedEventType.ATTACK:
            amountValue = finiteNumber(data.damage);
            energy = measured(0, Quality.DERIVED);
            break;
        default:
            energy = measured(0, Quality.DERIVED);
            break;
    }
    return {
        eventKey: eventKey(ctx.roomName, ctx.effectTick, entry.originalArrayIndex),
        roomName: ctx.roomName,
        effectTick: ctx.effectTick,
        observedAt: ctx.observedAt,
        originalArrayIndex: entry.originalArrayIndex,
        type: type,
        rawEvent: entry.event,
        actorId: actorId,
        sourceId: sourceId,
        targetId: target,
        resourceType: resourceType,
        amount: amountValue === null ? unknownMeasure(ReasonCode.MISSING_FIELD) : measured(amountValue),
        energyAmount: energy,
        rawFingerprint: ctx.rawFingerprint,
    };
}

function sourcesIncomplete(roomSnapshot) {
    const missing = Array.isArray(roomSnapshot.missingFields) ? roomSnapshot.missingFields : [];
    for (let i = 0; i < missing.length; i++) if (missing[i] === 'sources' || /^sources\.[^.]+\.pos$/.test(missing[i])) return true; // A1 drops a source without pos
    return false;
}

function gapReason(status) {
    return status === EventLogStatus.NOT_VISIBLE ? ReasonCode.NO_VISIBILITY : ReasonCode.EVENT_GAP;
}

function pushGap(gaps, roomName, fromTick, toTick, reasonCode) {
    if (fromTick > toTick) return;
    const last = gaps.length > 0 ? gaps[gaps.length - 1] : null;
    if (last !== null && last.reasonCode === reasonCode && last.toTick + 1 === fromTick) {
        last.toTick = toTick;
        return;
    }
    gaps.push({ roomName: roomName, fromTick: fromTick, toTick: toTick, reasonCode: reasonCode });
}

/**
 * Check entries: integer indices < rawLength, no duplicates. Returns a sorted copy
 * (a reordered capture yields the same identities) or null when invalid.
 */
function orderedEntries(log) {
    const list = log.entries.slice();
    list.sort(function (a, b) { return a.originalArrayIndex - b.originalArrayIndex; });
    for (let i = 0; i < list.length; i++) {
        if (list[i].originalArrayIndex >= log.rawLength) return null;
        if (i > 0 && list[i - 1].originalArrayIndex === list[i].originalArrayIndex) return null;
    }
    return list;
}

/**
 * @param {object} roomSnapshot RoomSnapshot (contract A.2 §4.1)
 * @param {object|null} cursor EventCursor of the room or null (never observed)
 * @param {{creepBodies?: Object<string, Array>}} [options] creepBodies: object id -> BodyPart[]
 *        (own creeps of the same snapshot); used only to derive BUILD energy of unboosted bodies.
 * @returns {object} READY({events, gaps, cursor}) | UNKNOWN(AMBIGUOUS_EFFECT) on a conflicting
 *          re-capture of a processed tick | REJECTED(INVALID_RECORD) on malformed input
 */
function normalizeRoomEvents(roomSnapshot, cursor, options) {
    if (roomSnapshot === null || typeof roomSnapshot !== 'object' || !isRoomName(roomSnapshot.roomName) || !roomSnapshot.eventLog) {
        return REJECTED(ReasonCode.INVALID_RECORD, { what: 'roomSnapshot' });
    }
    const roomName = roomSnapshot.roomName;
    const log = roomSnapshot.eventLog;
    const effectTick = log.effectTick;
    const observedAt = log.observedAt;
    if (!(Number.isInteger(effectTick) && effectTick >= 0 && observedAt === effectTick + 1 && observedAt === roomSnapshot.tick)) {
        return REJECTED(ReasonCode.INVALID_RECORD, { what: 'eventLog.effectTick', roomName: roomName });
    }
    if (cursor !== null && cursor !== undefined) {
        if (cursor.roomName !== roomName || !(cursor.processedThroughTick < cursor.lastObservedAt)) {
            return REJECTED(ReasonCode.INVALID_RECORD, { what: 'cursor', roomName: roomName });
        }
    } else {
        cursor = null;
    }
    const captured = log.status === EventLogStatus.CAPTURED;
    if (captured && (!Array.isArray(log.entries) || !Number.isInteger(log.rawLength) || typeof log.rawFingerprint !== 'string')) {
        return REJECTED(ReasonCode.INVALID_RECORD, { what: 'eventLog', roomName: roomName });
    }
    const inputFp = fingerprint({ roomName: roomName, effectTick: effectTick, status: log.status, rawFingerprint: captured ? log.rawFingerprint : null, entries: captured ? log.entries : null, cursor: cursor });

    // Already processed: idempotent no-op; a different capture of the same tick is a conflict.
    if (cursor !== null && effectTick <= cursor.processedThroughTick) {
        if (effectTick === cursor.processedThroughTick && captured && cursor.lastRawFingerprint !== null && cursor.lastRawFingerprint !== log.rawFingerprint) {
            return UNKNOWN(ReasonCode.AMBIGUOUS_EFFECT, ['eventLog.rawFingerprint']);
        }
        return READY({ events: [], gaps: [], cursor: cursor }, inputFp);
    }

    const gaps = [];
    if (cursor !== null && effectTick > cursor.processedThroughTick + 1) {
        pushGap(gaps, roomName, cursor.processedThroughTick + 1, effectTick - 1, ReasonCode.EVENT_GAP);
    }
    const events = [];
    if (!captured) {
        pushGap(gaps, roomName, effectTick, effectTick, gapReason(log.status));
    } else {
        const entries = orderedEntries(log);
        if (entries === null) return REJECTED(ReasonCode.INVALID_RECORD, { what: 'eventLog.entries', roomName: roomName });
        const sourceIds = {};
        const sources = Array.isArray(roomSnapshot.sources) ? roomSnapshot.sources : [];
        for (let i = 0; i < sources.length; i++) sourceIds[sources[i].id] = true;
        const bodies = options && options.creepBodies ? options.creepBodies : {};
        const ctx = { roomName: roomName, effectTick: effectTick, observedAt: observedAt, rawFingerprint: log.rawFingerprint, sourceIds: sourceIds, knownTargets: roomSnapshot.visibility === 'VISIBLE', sourcesIncomplete: sourcesIncomplete(roomSnapshot), bodies: bodies };
        for (let i = 0; i < entries.length; i++) events.push(normalizeEntry(entries[i], ctx));
    }
    const nextCursor = {
        roomName: roomName,
        processedThroughTick: effectTick,
        lastObservedAt: observedAt,
        lastRawFingerprint: captured ? log.rawFingerprint : null,
    };
    return READY({ events: events, gaps: gaps, cursor: nextCursor }, inputFp);
}

/**
 * Whether the captured log of the room is complete (every raw entry kept).
 * A filtered capture cannot prove the absence of an event.
 * @param {object} roomSnapshot
 * @returns {boolean}
 */
function isCompleteLog(roomSnapshot) {
    const log = roomSnapshot && roomSnapshot.eventLog;
    return !!log && log.status === EventLogStatus.CAPTURED && Array.isArray(log.entries) && log.entries.length === log.rawLength;
}

/**
 * Object id -> body of own creeps of a Snapshot (for BUILD energy derivation).
 * @param {object} snapshot
 * @returns {Object<string, Array>}
 */
function creepBodiesById(snapshot) {
    const out = {};
    if (!snapshot || !snapshot.ownCreeps) return out;
    for (const name in snapshot.ownCreeps) {
        const c = snapshot.ownCreeps[name];
        if (c.id) out[c.id] = c.body;
    }
    return out;
}

module.exports = {
    RAW_EVENT_TYPES,
    BUILD_POWER,
    normalizeRoomEvents,
    isCompleteLog,
    creepBodiesById,
};
