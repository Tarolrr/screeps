// Persisted state layout of contract A.2 (ARCHITECTURE §6, CONTRACTS-A.md §5).
//
//   Memory.strategy        authoritative schema1 tree. In stage A only meta,
//                          control, faults and migrations carry data; rooms,
//                          missions, demands, bindings, assignments, ledger and
//                          operations exist and stay EMPTY (no adaptive owner).
//   Memory.strategyShadow  everything shadow computes (observation, finance,
//                          planning), with a declared layout and bounded sizes.
//
// Writes go through StateStore.apply(expectedRevision, patches) with StatePatch
// = {patchId, writer, namespace, path, op, value?}. PATCH_RULES assigns every
// writable path to exactly one writer; validateStatePatch checks writer,
// path and value. Meta fields (schemaVersion, policyVersion, buildId, revision,
// lastClosedTick, recentPatchIds) are maintained by StateStore internally and
// are not patchable.

const { S, validate } = require('./schema');
const E = require('./enums');
const { REASON_CODE_LIST } = require('./reasonCodes');
const { isRoomName, isOperationKey } = require('./keys');
const { SCHEMAS } = require('./dtos');
const { SCHEMA_VERSION } = require('./version');

const LIMITS = Object.freeze({
    flowWindowsPerRoom: 30,        // DESIGN §3
    decisionRingPerRoom: 100,      // DESIGN §3
    recentPatchIds: 256,
    shadowReservations: 512,
    observedOperations: 1024,
    proposals: 200,
    shadowRooms: 64,               // bounded; A2 compacts/evicts rooms not observed recently
    observedBindingsPerRoom: 256,
});

/** Path segments that must never be used as record keys (prototype pollution). */
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

const roomName = S.custom(isRoomName, 'BAD_ROOM_NAME');
const id = S.nonEmpty();
const tick = S.int({ min: 0 });
const reasonCode = S.enumOf((function () { const o = {}; REASON_CODE_LIST.forEach(function (c) { o[c] = c; }); return o; })());
const anyRecord = S.record(id, S.json());

const Migrations = S.object({
    version: S.int({ min: 0 }),
    cursor: S.nullable(S.json()),
    sourceRevision: S.nullable(S.int({ min: 0 })),
    status: S.enumOf(E.MigrationStatus),
});

const StrategyRoot = S.object({
    schemaVersion: S.literal(SCHEMA_VERSION),
    policyVersion: S.nullable(S.nonEmpty()),
    buildId: S.nullable(S.nonEmpty()),
    revision: S.int({ min: 0 }),
    lastClosedTick: S.nullable(tick),
    recentPatchIds: S.array(id, { maxLength: LIMITS.recentPatchIds }),
    control: S.object({ rooms: S.record(roomName, SCHEMAS.ControlRecord) }),
    rooms: S.record(roomName, S.json()),
    missions: anyRecord,
    demands: S.record(id, SCHEMAS.Demand),
    bindings: S.record(id, SCHEMAS.Binding),
    assignments: anyRecord,
    ledger: S.object({ reservations: S.record(id, SCHEMAS.Reservation), funds: anyRecord, missionExposure: anyRecord }),
    operations: S.record(S.custom(isOperationKey, 'BAD_OPERATION_KEY'), SCHEMAS.Operation),
    faults: S.record(id, SCHEMAS.FaultStatus),
    migrations: Migrations,
});

/** Keys of Memory.strategy that must be empty in stage A. */
const STAGE_A_EMPTY_STRATEGY_KEYS = Object.freeze(['rooms', 'missions', 'demands', 'bindings', 'assignments', 'operations', 'ledger.reservations', 'ledger.funds', 'ledger.missionExposure']);

const ShadowRoom = S.object({
    eventCursor: S.nullable(SCHEMAS.EventCursor),
    flowWindows: S.array(SCHEMAS.FlowWindow, { maxLength: LIMITS.flowWindowsPerRoom }),
    observedBindings: S.record(id, SCHEMAS.ObservedBinding, { maxKeys: LIMITS.observedBindingsPerRoom }),
    forecast: S.nullable(SCHEMAS.ForecastSummary),
    decisionRing: S.array(SCHEMAS.DecisionRecord, { maxLength: LIMITS.decisionRingPerRoom }),
});

const ShadowRoot = S.object({
    schemaVersion: S.literal(SCHEMA_VERSION),
    rooms: S.record(roomName, ShadowRoom, { maxKeys: LIMITS.shadowRooms }),
    ledger: S.object({ reservations: S.record(id, SCHEMAS.Reservation, { maxKeys: LIMITS.shadowReservations }) }),
    observedOperations: S.record(id, SCHEMAS.ObservedOperation, { maxKeys: LIMITS.observedOperations }),
    proposals: S.record(id, SCHEMAS.Proposal, { maxKeys: LIMITS.proposals }),
});

/** Read-only view returned by StateStore.open (A2); deep-frozen by the store. */
const StateView = S.object({
    dtoType: S.literal('StateView'),
    status: S.enumOf(E.StateStatus),
    sessionTick: tick,
    blockedReason: S.nullable(reasonCode),
    quarantine: S.array(S.object({ namespace: S.nonEmpty(), key: S.nonEmpty(), reasonCode: reasonCode })),
    strategy: StrategyRoot,
    shadow: S.nullable(ShadowRoot),
});

// ---------------------------------------------------------------- patch ownership

/**
 * Path pattern segments: literal strings, or '<room>' / '<key>' wildcards.
 * `keyField`: field of the value that must equal the wildcard key.
 * `deletable`: whether op 'delete' is allowed on the path.
 */
const PATCH_RULES = Object.freeze([
    // Memory.strategy (writer: state = A2)
    { namespace: 'strategy', pattern: ['control', 'rooms', '<room>'], writer: E.StateWriter.STATE, schema: SCHEMAS.ControlRecord, deletable: false },
    { namespace: 'strategy', pattern: ['faults', '<key>'], writer: E.StateWriter.STATE, schema: SCHEMAS.FaultStatus, keyField: 'component', deletable: true },
    { namespace: 'strategy', pattern: ['migrations'], writer: E.StateWriter.STATE, schema: Migrations, deletable: false },
    // Memory.strategyShadow — observation (A3)
    { namespace: 'strategyShadow', pattern: ['rooms', '<room>'], writer: E.StateWriter.STATE, schema: ShadowRoom, deletable: true },
    { namespace: 'strategyShadow', pattern: ['rooms', '<room>', 'eventCursor'], writer: E.StateWriter.OBSERVATION, schema: S.nullable(SCHEMAS.EventCursor), roomField: 'roomName', deletable: false },
    { namespace: 'strategyShadow', pattern: ['rooms', '<room>', 'flowWindows'], writer: E.StateWriter.OBSERVATION, schema: S.array(SCHEMAS.FlowWindow, { maxLength: LIMITS.flowWindowsPerRoom }), roomField: 'roomName', deletable: false },
    { namespace: 'strategyShadow', pattern: ['rooms', '<room>', 'observedBindings', '<key>'], writer: E.StateWriter.OBSERVATION, schema: SCHEMAS.ObservedBinding, deletable: true },
    { namespace: 'strategyShadow', pattern: ['observedOperations', '<key>'], writer: E.StateWriter.OBSERVATION, schema: SCHEMAS.ObservedOperation, keyField: 'observationKey', deletable: true },
    // Memory.strategyShadow — finance (A4)
    { namespace: 'strategyShadow', pattern: ['rooms', '<room>', 'forecast'], writer: E.StateWriter.FINANCE, schema: S.nullable(SCHEMAS.ForecastSummary), roomField: 'roomName', deletable: false },
    { namespace: 'strategyShadow', pattern: ['ledger', 'reservations', '<key>'], writer: E.StateWriter.FINANCE, schema: SCHEMAS.Reservation, keyField: 'reservationId', deletable: true },
    // Memory.strategyShadow — planning (A5)
    { namespace: 'strategyShadow', pattern: ['rooms', '<room>', 'decisionRing'], writer: E.StateWriter.PLANNING, schema: S.array(SCHEMAS.DecisionRecord, { maxLength: LIMITS.decisionRingPerRoom }), roomField: 'roomName', deletable: false },
    { namespace: 'strategyShadow', pattern: ['proposals', '<key>'], writer: E.StateWriter.PLANNING, schema: SCHEMAS.Proposal, keyField: 'proposalId', deletable: true },
]);

function matchRule(namespace, path) {
    for (let r = 0; r < PATCH_RULES.length; r++) {
        const rule = PATCH_RULES[r];
        if (rule.namespace !== namespace || rule.pattern.length !== path.length) continue;
        let ok = true;
        const bound = {};
        for (let i = 0; i < path.length && ok; i++) {
            const seg = rule.pattern[i];
            if (seg === '<room>') { ok = isRoomName(path[i]); bound.room = path[i]; } else if (seg === '<key>') { ok = typeof path[i] === 'string' && path[i] !== '' && FORBIDDEN_KEYS.indexOf(path[i]) === -1; bound.key = path[i]; } else ok = seg === path[i];
        }
        if (ok) return { rule: rule, bound: bound };
    }
    return null;
}

/**
 * Owner of a path, or null when the path is not patchable.
 * @param {string} namespace 'strategy' | 'strategyShadow'
 * @param {string[]} path
 * @returns {string|null} StateWriter
 */
function patchOwner(namespace, path) {
    const m = Array.isArray(path) ? matchRule(namespace, path) : null;
    return m ? m.rule.writer : null;
}

/**
 * Full StatePatch validation: shape, path ownership by `patch.writer`, value
 * schema and key/room consistency.
 * @param {*} patch
 * @returns {{ok:true} | {ok:false, errors:Array<{path:string, code:string}>}}
 */
function validateStatePatch(patch) {
    const shape = validate(SCHEMAS.StatePatchShape, patch);
    if (!shape.ok) return shape;
    const m = matchRule(patch.namespace, patch.path);
    if (m === null) return { ok: false, errors: [{ path: '$/path', code: 'PATH_NOT_PATCHABLE' }] };
    if (m.rule.writer !== patch.writer) return { ok: false, errors: [{ path: '$/writer', code: 'NOT_PATH_OWNER' }] };
    if (patch.op === E.PatchOp.DELETE) return m.rule.deletable ? { ok: true } : { ok: false, errors: [{ path: '$/op', code: 'NOT_DELETABLE' }] };
    const value = validate(m.rule.schema, patch.value);
    if (!value.ok) return { ok: false, errors: value.errors.map(function (e) { return { path: '$/value' + e.path.slice(1), code: e.code }; }) };
    const v = patch.value;
    if (m.rule.keyField && v[m.rule.keyField] !== m.bound.key) return { ok: false, errors: [{ path: '$/value/' + m.rule.keyField, code: 'KEY_MISMATCH' }] };
    if (m.rule.roomField && v !== null) {
        const items = Array.isArray(v) ? v : [v];
        for (let i = 0; i < items.length; i++) {
            if (items[i][m.rule.roomField] !== m.bound.room) return { ok: false, errors: [{ path: '$/value', code: 'ROOM_MISMATCH' }] };
        }
    }
    return { ok: true };
}

// ---------------------------------------------------------------- constructors and root validators

/**
 * @param {{buildId?: string|null, policyVersion?: string|null}} [meta]
 */
function emptyStrategyRoot(meta) {
    return {
        schemaVersion: SCHEMA_VERSION,
        policyVersion: meta && meta.policyVersion ? meta.policyVersion : null,
        buildId: meta && meta.buildId ? meta.buildId : null,
        revision: 0,
        lastClosedTick: null,
        recentPatchIds: [],
        control: { rooms: {} },
        rooms: {},
        missions: {},
        demands: {},
        bindings: {},
        assignments: {},
        ledger: { reservations: {}, funds: {}, missionExposure: {} },
        operations: {},
        faults: {},
        migrations: { version: SCHEMA_VERSION, cursor: null, sourceRevision: null, status: E.MigrationStatus.NONE },
    };
}

function emptyShadowRoom() {
    return { eventCursor: null, flowWindows: [], observedBindings: {}, forecast: null, decisionRing: [] };
}

function emptyShadowRoot() {
    return { schemaVersion: SCHEMA_VERSION, rooms: {}, ledger: { reservations: {} }, observedOperations: {}, proposals: {} };
}

/**
 * @param {*} root Memory.strategy candidate
 * @param {{stage?: 'A'}} [options] stage 'A' additionally requires the adaptive keys to be empty
 */
function validateStrategyRoot(root, options) {
    const result = validate(StrategyRoot, root);
    if (!result.ok || !(options && options.stage === 'A')) return result;
    const errors = [];
    for (let i = 0; i < STAGE_A_EMPTY_STRATEGY_KEYS.length; i++) {
        const parts = STAGE_A_EMPTY_STRATEGY_KEYS[i].split('.');
        let v = root;
        for (let j = 0; j < parts.length; j++) v = v[parts[j]];
        if (Object.keys(v).length > 0) errors.push({ path: '$/' + parts.join('/'), code: 'STAGE_A_NOT_EMPTY' });
    }
    return errors.length === 0 ? result : { ok: false, errors: errors };
}

function validateShadowRoot(root) {
    const result = validate(ShadowRoot, root);
    if (!result.ok) return result;
    const errors = [];
    for (const room in root.rooms) {
        const r = root.rooms[room];
        if (r.eventCursor !== null && r.eventCursor.roomName !== room) errors.push({ path: '$/rooms/' + room + '/eventCursor', code: 'ROOM_MISMATCH' });
        if (r.forecast !== null && r.forecast.roomName !== room) errors.push({ path: '$/rooms/' + room + '/forecast', code: 'ROOM_MISMATCH' });
    }
    return errors.length === 0 ? result : { ok: false, errors: errors };
}

/**
 * Reconciler output (A3): patches are owned by writer 'observation'.
 */
const ReconciliationPatch = S.object({
    tick: tick,
    patches: S.array(SCHEMAS.StatePatchShape),
    gaps: S.array(SCHEMAS.EventGap),
    domainStatus: S.record(roomName, S.enumOf(E.DomainStatus)),
    reasonCodes: S.refine(S.array(reasonCode), function (l) {
        for (let i = 1; i < l.length; i++) if (!(l[i - 1] < l[i])) return [{ path: String(i), code: 'NOT_SORTED_UNIQUE' }];
        return [];
    }),
});

function validateReconciliationPatch(value) {
    const result = validate(ReconciliationPatch, value);
    if (!result.ok) return result;
    const errors = [];
    for (let i = 0; i < value.patches.length; i++) {
        const p = value.patches[i];
        if (p.writer !== E.StateWriter.OBSERVATION) { errors.push({ path: '$/patches/' + i + '/writer', code: 'NOT_PATH_OWNER' }); continue; }
        const check = validateStatePatch(p);
        if (!check.ok) errors.push({ path: '$/patches/' + i, code: check.errors[0].code });
    }
    return errors.length === 0 ? result : { ok: false, errors: errors };
}

module.exports = {
    LIMITS,
    STAGE_A_EMPTY_STRATEGY_KEYS,
    PATCH_RULES,
    LAYOUT_SCHEMAS: Object.freeze({ StrategyRoot: StrategyRoot, ShadowRoot: ShadowRoot, ShadowRoom: ShadowRoom, Migrations: Migrations, StateView: StateView, ReconciliationPatch: ReconciliationPatch }),
    patchOwner,
    validateStatePatch,
    emptyStrategyRoot,
    emptyShadowRoom,
    emptyShadowRoot,
    validateStrategyRoot,
    validateShadowRoot,
    validateStateView: function (value) { return validate(StateView, value); },
    validateReconciliationPatch,
};
