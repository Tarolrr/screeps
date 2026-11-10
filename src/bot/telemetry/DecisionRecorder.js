// DecisionRecorder (STRAT-A5, contract A.4 §10): bounded shadow decision log.
//
//   createDecisionRecorder({capacityPerRoom: 100, maxRingChars?, readRing?, readProposals?})
//     -> {append(record) -> Result, lastRecord(room), stageProposals(room, upserts, deleteIds),
//         pending(), drain(tick) -> StatePatch[] (writer 'planning')}
//
// Pure value logic (no ports): the shadow pipeline reads the persisted ring through
// `readRing(room)` (planning handle view) and applies the drained patches through
// its own writer-bound handle. What is recorded is decided by the caller
// (significant decisions only: mode change, new proposal/rejection, UNKNOWN causes,
// interruptions) — the recorder bounds and persists:
//   - Memory.strategyShadow.rooms.<room>.decisionRing: last `capacityPerRoom` (<= 100,
//     LIMITS.decisionRingPerRoom) records, additionally trimmed (oldest first) to
//     `maxRingChars` of JSON per room so a few shadow rooms cannot exhaust the
//     256 KiB StateStore budget; the newest record is always kept;
//   - Memory.strategyShadow.proposals.<id>: upserts/deletes staged per room;
//   drainRing()/drainProposals() return the two kinds as separate batches (a refused
//   proposal batch must never block the ring, which carries the hysteresis state).
// patchId = 'pl:<tick>:<hash of path/op/value>' (deterministic, never reused for
// different content). After drain() the pending buffer is empty: a record lost
// because the apply failed is re-derived next tick (significance is compared
// with the persisted ring), so the ring self-heals.

const { fingerprint } = require('../domain/fingerprint');
const { READY, REJECTED } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { validateDecisionRecord, validateProposal } = require('../domain/dtos');
const { LIMITS } = require('../domain/stateLayout');
const E = require('../domain/enums');

/** Default JSON budget of one room's ring (see header). */
const DEFAULT_MAX_RING_CHARS = 24000;

function patchId(tick, path, op, value) {
    return 'pl:' + tick + ':' + fingerprint({ p: path, o: op, v: value === undefined ? null : value }).slice(8);
}

/**
 * @param {{capacityPerRoom?: number, maxRingChars?: number,
 *          readRing?: function(string): object[], readProposals?: function(): Object<string, object>}} [options]
 */
function createDecisionRecorder(options) {
    const o = options || {};
    const capacity = Math.max(1, Math.min(LIMITS.decisionRingPerRoom, o.capacityPerRoom === undefined ? LIMITS.decisionRingPerRoom : o.capacityPerRoom));
    const maxChars = o.maxRingChars === undefined ? DEFAULT_MAX_RING_CHARS : o.maxRingChars;
    const readRing = o.readRing || function () { return []; };
    const readProposals = o.readProposals || function () { return {}; };
    let records = {};      // room -> DecisionRecord[] (pending)
    let proposalSets = {}; // id -> Proposal (pending upserts)
    let proposalDeletes = {};

    /**
     * @param {object} record DecisionRecord with roomName
     * @returns {object} READY({decisionId}) | REJECTED(INVALID_RECORD)
     */
    function append(record) {
        const v = validateDecisionRecord(record);
        if (!v.ok) return REJECTED(ReasonCode.INVALID_RECORD, { what: 'DecisionRecord', errors: v.errors.slice(0, 5) });
        if (record.roomName === null) return REJECTED(ReasonCode.INVALID_RECORD, { what: 'DecisionRecord', errors: [{ path: '$/roomName', code: 'REQUIRED' }] });
        if (record.mode === E.RoomMode.SHADOW && record.executed !== false) return REJECTED(ReasonCode.INVALID_RECORD, { what: 'DecisionRecord', errors: [{ path: '$/executed', code: 'SHADOW_EXECUTED' }] });
        (records[record.roomName] = records[record.roomName] || []).push(record);
        return READY({ decisionId: record.decisionId }, fingerprint({ decisionId: record.decisionId }));
    }

    /** Newest record of the room: pending first, then the persisted ring. */
    function lastRecord(roomName) {
        const p = records[roomName];
        if (p && p.length > 0) return p[p.length - 1];
        const ring = readRing(roomName) || [];
        return ring.length > 0 ? ring[ring.length - 1] : null;
    }

    /**
     * Stage proposal upserts/deletes (writer planning). Invalid proposals are refused.
     * roomName may be null for deletes only (proposals of rooms no longer in shadow).
     * @returns {object} READY({upserts, deletes}) | REJECTED(INVALID_RECORD)
     */
    function stageProposals(roomName, upserts, deleteIds) {
        for (let i = 0; i < upserts.length; i++) {
            const v = validateProposal(upserts[i]);
            if (!v.ok) return REJECTED(ReasonCode.INVALID_RECORD, { what: 'Proposal', proposalId: upserts[i] && upserts[i].proposalId, errors: v.errors.slice(0, 5) });
            if (upserts[i].roomName !== roomName) return REJECTED(ReasonCode.INVALID_RECORD, { what: 'Proposal', errors: [{ path: '$/roomName', code: 'ROOM_MISMATCH' }] });
        }
        for (let i = 0; i < upserts.length; i++) { proposalSets[upserts[i].proposalId] = upserts[i]; delete proposalDeletes[upserts[i].proposalId]; }
        for (let i = 0; i < deleteIds.length; i++) { if (!proposalSets[deleteIds[i]]) proposalDeletes[deleteIds[i]] = true; }
        return READY({ upserts: upserts.length, deletes: deleteIds.length }, fingerprint({ r: roomName, u: upserts.map(function (p) { return p.proposalId; }), d: deleteIds }));
    }

    function trimRing(ring) {
        let list = ring.slice(Math.max(0, ring.length - capacity));
        let size = JSON.stringify(list).length;
        while (list.length > 1 && size > maxChars) {
            size -= JSON.stringify(list[0]).length + 1;
            list = list.slice(1);
        }
        return list;
    }

    /**
     * Ring patches only (writer 'planning'); clears the pending records. Persist them in
     * their own batch: the ring carries the hysteresis state and must not depend on the
     * proposal batch.
     * @param {number} tick current tick (patch ids)
     */
    function drainRing(tick) {
        const patches = [];
        const rooms = Object.keys(records).sort();
        for (let i = 0; i < rooms.length; i++) {
            const room = rooms[i];
            const ring = trimRing((readRing(room) || []).concat(records[room]));
            const path = ['rooms', room, 'decisionRing'];
            patches.push({ patchId: patchId(tick, path, 'set', ring), writer: E.StateWriter.PLANNING, namespace: 'strategyShadow', path: path, op: E.PatchOp.SET, value: ring });
        }
        records = {};
        return patches;
    }

    /** Proposal upserts/deletes (writer 'planning'); clears the pending proposal changes. */
    function drainProposals(tick) {
        const patches = [];
        const stored = readProposals() || {};
        const ids = Object.keys(proposalSets).sort();
        for (let i = 0; i < ids.length; i++) {
            const path = ['proposals', ids[i]];
            patches.push({ patchId: patchId(tick, path, 'set', proposalSets[ids[i]]), writer: E.StateWriter.PLANNING, namespace: 'strategyShadow', path: path, op: E.PatchOp.SET, value: proposalSets[ids[i]] });
        }
        const dels = Object.keys(proposalDeletes).sort();
        for (let i = 0; i < dels.length; i++) {
            if (!Object.prototype.hasOwnProperty.call(stored, dels[i])) continue;
            const path = ['proposals', dels[i]];
            patches.push({ patchId: patchId(tick, path, 'delete'), writer: E.StateWriter.PLANNING, namespace: 'strategyShadow', path: path, op: E.PatchOp.DELETE });
        }
        proposalSets = {};
        proposalDeletes = {};
        return patches;
    }

    /** All pending patches (ring + proposals, contract §10 drain()); callers should prefer the two batches. */
    function drain(tick) {
        return drainRing(tick).concat(drainProposals(tick));
    }

    return Object.freeze({
        capacityPerRoom: capacity,
        append: append,
        lastRecord: lastRecord,
        stageProposals: stageProposals,
        /** @returns {{records: number, proposals: number}} pending counts */
        pending: function () {
            let n = 0;
            for (const r in records) n += records[r].length;
            return { records: n, proposals: Object.keys(proposalSets).length + Object.keys(proposalDeletes).length };
        },
        drain: drain,
        drainRing: drainRing,
        drainProposals: drainProposals,
    });
}

module.exports = { DEFAULT_MAX_RING_CHARS, createDecisionRecorder };
