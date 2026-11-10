// StateCodec of contract A.2 (ARCHITECTURE §6, CONTRACTS-A.md §5, §10 A2).
//
// decode(namespace, raw) validates untrusted Memory content per namespace and
// LOCALIZES damage:
//   - control class (meta, control, migrations of Memory.strategy; root and
//     schemaVersion of every namespace): any defect makes the whole namespace
//     INCOMPATIBLE (never an "empty world", never a blind legacy fallback);
//   - domain records (faults, operations, demands, bindings, ledger records,
//     shadow rooms/fields, observed operations, proposals, ...): an invalid
//     record is QUARANTINED (excluded from the view, raw value kept for
//     write-back) and the rest loads.
// Values in the view are fresh JSON copies (no alias to Memory objects).
//
// Result: {status, schemaVersion, value, quarantine, errors}
//   status: ABSENT (namespace missing -> empty schema1) | OK | OLDER (known older
//           schema, migration required) | INCOMPATIBLE (unknown newer / corrupt)
//   quarantine: [{namespace, path: string[], key, reasonCode, code, raw}]
//
// encode(namespace, value) -> canonical JSON text; rejects Game objects, Map,
// NaN, Infinity, undefined, cycles (domain/canonical).

const { validate, S } = require('../domain/schema');
const { SCHEMAS } = require('../domain/dtos');
const layout = require('../domain/stateLayout');
const { canonicalJson, isPlainObject } = require('../domain/canonical');
const { isRoomName } = require('../domain/keys');
const { isFingerprint } = require('../domain/fingerprint');
const { ReasonCode } = require('../domain/reasonCodes');
const E = require('../domain/enums');
const { SCHEMA_VERSION } = require('../domain/version');
const { own, has, put, isForbiddenKey, findForbiddenKey, jsonClone } = require('./objects');

const NAMESPACES = Object.freeze({ STRATEGY: 'strategy', SHADOW: 'strategyShadow', MIGRATION: 'strategyMigration' });
const DecodeStatus = Object.freeze({ ABSENT: 'ABSENT', OK: 'OK', OLDER: 'OLDER', INCOMPATIBLE: 'INCOMPATIBLE' });
/** Format version of Memory.strategyMigration (A2 internal, see MigrationRegistry). */
const MIGRATION_FORMAT_VERSION = 1;

const L = layout.LIMITS;
const ROOT_FIELDS = layout.LAYOUT_SCHEMAS.StrategyRoot.fields;
const SHADOW_ROOM_FIELDS = layout.LAYOUT_SCHEMAS.ShadowRoom.fields;
const SHADOW_ROOT_FIELDS = layout.LAYOUT_SCHEMAS.ShadowRoot.fields;
/** Optional root fields of Memory.strategyShadow (contract A.4); absent unless written. */
const SHADOW_OPTIONAL_FIELDS = Object.freeze(['exportRequest', 'replayExport']);
const json = S.json();

/** Control class of Memory.strategy: a defect here blocks the whole namespace. */
const CONTROL_FIELDS = Object.freeze(['schemaVersion', 'policyVersion', 'buildId', 'revision', 'lastClosedTick', 'recentPatchIds', 'control', 'migrations']);

/**
 * Record containers of Memory.strategy (path, value schema, key check).
 * keyField: value[keyField] must equal the record key.
 */
const STRATEGY_CONTAINERS = Object.freeze([
    { path: ['faults'], schema: SCHEMAS.FaultStatus, keyField: 'component' },
    { path: ['operations'], schema: SCHEMAS.Operation, keyField: 'operationKey' },
    { path: ['demands'], schema: SCHEMAS.Demand, keyField: 'stableKey' },
    { path: ['bindings'], schema: SCHEMAS.Binding },
    { path: ['rooms'], schema: json, roomKey: true },
    { path: ['missions'], schema: json },
    { path: ['assignments'], schema: json },
    { path: ['ledger', 'reservations'], schema: SCHEMAS.Reservation, keyField: 'reservationId' },
    { path: ['ledger', 'funds'], schema: json },
    { path: ['ledger', 'missionExposure'], schema: json },
]);

const SHADOW_CONTAINERS = Object.freeze([
    { path: ['ledger', 'reservations'], schema: SCHEMAS.Reservation, keyField: 'reservationId', maxKeys: L.shadowReservations },
    { path: ['observedOperations'], schema: SCHEMAS.ObservedOperation, keyField: 'observationKey', maxKeys: L.observedOperations },
    { path: ['proposals'], schema: SCHEMAS.Proposal, keyField: 'proposalId', maxKeys: L.proposals },
]);

/** Shadow room fields whose items carry roomName (PATCH_RULES roomField). */
const SHADOW_ROOM_FIELD_ROOM_CHECK = Object.freeze({ eventCursor: true, flowWindows: true, forecast: true, decisionRing: true });

const MigrationRecord = S.object({
    formatVersion: S.literal(MIGRATION_FORMAT_VERSION),
    namespace: S.literal(NAMESPACES.STRATEGY),
    fromVersion: S.int({ min: 0 }),
    toVersion: S.int({ min: 0 }),
    draftVersion: S.int({ min: 0 }),
    status: S.enumOf(E.MigrationStatus),
    startedAt: S.nullable(S.int({ min: 0 })),
    deadlineTick: S.nullable(S.int({ min: 0 })),
    sourceRevision: S.nullable(S.int({ min: 0 })),
    sourceFingerprint: S.nullable(S.custom(isFingerprint, 'BAD_FINGERPRINT')),
    draft: S.json(),
    cancelReason: S.nullable(S.nonEmpty()),
    cancelledAt: S.nullable(S.int({ min: 0 })),
    notBefore: S.nullable(S.int({ min: 0 })),
    completedAt: S.nullable(S.int({ min: 0 })),
});

function quarantineEntry(namespace, path, code, raw) {
    return { namespace: namespace, path: path, key: path.join('.'), reasonCode: ReasonCode.INVALID_RECORD, code: code, raw: raw };
}

function incompatible(code, evidence, schemaVersion) {
    return { status: DecodeStatus.INCOMPATIBLE, schemaVersion: schemaVersion === undefined ? null : schemaVersion, value: null, quarantine: [], errors: [Object.assign({ code: code }, evidence || {})] };
}

function firstError(result) {
    return result.ok ? null : result.errors[0].path + ':' + result.errors[0].code;
}

function getPath(object, path) {
    let v = object;
    for (let i = 0; i < path.length; i++) v = own(v, path[i]);
    return v;
}

function ensurePath(object, path) {
    let v = object;
    for (let i = 0; i < path.length; i++) {
        if (!has(v, path[i])) put(v, path[i], {});
        v = own(v, path[i]);
    }
    return v;
}

/**
 * Validate one record container: per record schema + key checks; invalid
 * records and keys beyond maxKeys (sorted key order) are quarantined.
 */
function decodeContainer(namespace, spec, rawContainer, target, quarantine, basePath) {
    const path = basePath.concat(spec.path);
    if (rawContainer === undefined) return; // missing container: nothing to preserve, view gets {}
    if (!isPlainObject(rawContainer)) {
        quarantine.push(quarantineEntry(namespace, path, 'CONTAINER_NOT_OBJECT', rawContainer));
        return;
    }
    const keys = Object.keys(rawContainer).sort();
    let kept = 0;
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const raw = own(rawContainer, key);
        const recordPath = path.concat([key]);
        let code = null;
        if (isForbiddenKey(key) || key === '') code = 'FORBIDDEN_KEY';
        else if (spec.roomKey && !isRoomName(key)) code = 'BAD_ROOM_NAME';
        else {
            code = firstError(validate(spec.schema, raw));
            if (code === null && spec.keyField && own(raw, spec.keyField) !== key) code = '$/' + spec.keyField + ':KEY_MISMATCH';
            if (code === null && findForbiddenKey(raw) !== null) code = 'FORBIDDEN_KEY';
        }
        if (code === null && spec.maxKeys !== undefined && kept >= spec.maxKeys) code = 'TOO_MANY_KEYS';
        if (code !== null) { quarantine.push(quarantineEntry(namespace, recordPath, code, raw)); continue; }
        put(target, key, jsonClone(raw));
        kept++;
    }
}

function decodeStrategy(raw, meta) {
    const ns = NAMESPACES.STRATEGY;
    if (raw === undefined) return { status: DecodeStatus.ABSENT, schemaVersion: null, value: layout.emptyStrategyRoot(meta), quarantine: [], errors: [] };
    if (!isPlainObject(raw)) return incompatible('ROOT_NOT_OBJECT');
    const version = own(raw, 'schemaVersion');
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return incompatible('BAD_SCHEMA_VERSION');
    if (version > SCHEMA_VERSION) return incompatible('NEWER_SCHEMA', { supported: SCHEMA_VERSION }, version);
    if (version < SCHEMA_VERSION) return { status: DecodeStatus.OLDER, schemaVersion: version, value: null, quarantine: [], errors: [{ code: 'OLDER_SCHEMA', supported: SCHEMA_VERSION }] };

    const value = {};
    for (let i = 0; i < CONTROL_FIELDS.length; i++) {
        const name = CONTROL_FIELDS[i];
        const fieldValue = own(raw, name);
        const error = firstError(validate(ROOT_FIELDS[name], fieldValue));
        if (error !== null) return incompatible('CORRUPT_CONTROL', { field: name, error: error }, version);
        if (findForbiddenKey(fieldValue) !== null) return incompatible('CORRUPT_CONTROL', { field: name, error: 'FORBIDDEN_KEY' }, version);
        put(value, name, jsonClone(fieldValue));
    }
    const quarantine = [];
    const empty = layout.emptyStrategyRoot(null);
    for (let i = 0; i < STRATEGY_CONTAINERS.length; i++) {
        const spec = STRATEGY_CONTAINERS[i];
        const target = ensurePath(value, spec.path);
        if (spec.path.length === 2) {
            const parent = own(raw, spec.path[0]);
            if (parent !== undefined && !isPlainObject(parent)) {
                // quarantine the parent container once
                if (!quarantine.some(function (q) { return q.key === spec.path[0]; })) quarantine.push(quarantineEntry(ns, [spec.path[0]], 'CONTAINER_NOT_OBJECT', parent));
                continue;
            }
        }
        decodeContainer(ns, spec, getPath(raw, spec.path), target, quarantine, []);
    }
    // unknown keys (top level and inside ledger) are preserved but not loaded
    const known = Object.keys(empty);
    Object.keys(raw).forEach(function (key) {
        if (known.indexOf(key) === -1) quarantine.push(quarantineEntry(ns, [key], 'UNKNOWN_FIELD', own(raw, key)));
    });
    const rawLedger = own(raw, 'ledger');
    if (isPlainObject(rawLedger)) {
        Object.keys(rawLedger).forEach(function (key) {
            if (!has(empty.ledger, key)) quarantine.push(quarantineEntry(ns, ['ledger', key], 'UNKNOWN_FIELD', own(rawLedger, key)));
        });
    }
    return { status: DecodeStatus.OK, schemaVersion: version, value: value, quarantine: quarantine, errors: [] };
}

function decodeShadowRoom(room, rawRoom, quarantine) {
    const ns = NAMESPACES.SHADOW;
    const out = layout.emptyShadowRoom();
    const fields = Object.keys(SHADOW_ROOM_FIELDS);
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        if (f === 'observedBindings') continue;
        if (!has(rawRoom, f)) continue;
        const v = own(rawRoom, f);
        let code = firstError(validate(SHADOW_ROOM_FIELDS[f], v));
        if (code === null && SHADOW_ROOM_FIELD_ROOM_CHECK[f] && v !== null) {
            const items = Array.isArray(v) ? v : [v];
            for (let j = 0; j < items.length && code === null; j++) if (items[j].roomName !== room) code = 'ROOM_MISMATCH';
        }
        if (code === null && findForbiddenKey(v) !== null) code = 'FORBIDDEN_KEY';
        if (code !== null) quarantine.push(quarantineEntry(ns, ['rooms', room, f], code, v));
        else put(out, f, jsonClone(v));
    }
    decodeContainer(ns, { path: ['observedBindings'], schema: SCHEMAS.ObservedBinding, maxKeys: L.observedBindingsPerRoom }, own(rawRoom, 'observedBindings'), out.observedBindings, quarantine, ['rooms', room]);
    Object.keys(rawRoom).forEach(function (key) {
        if (!has(SHADOW_ROOM_FIELDS, key)) quarantine.push(quarantineEntry(ns, ['rooms', room, key], 'UNKNOWN_FIELD', own(rawRoom, key)));
    });
    return out;
}

function decodeShadow(raw) {
    const ns = NAMESPACES.SHADOW;
    if (raw === undefined) return { status: DecodeStatus.ABSENT, schemaVersion: null, value: layout.emptyShadowRoot(), quarantine: [], errors: [] };
    if (!isPlainObject(raw)) return incompatible('ROOT_NOT_OBJECT');
    const version = own(raw, 'schemaVersion');
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return incompatible('BAD_SCHEMA_VERSION');
    // No shadow migrations exist: an older shadow schema is equally not understood.
    if (version !== SCHEMA_VERSION) return incompatible(version > SCHEMA_VERSION ? 'NEWER_SCHEMA' : 'OLDER_SCHEMA', { supported: SCHEMA_VERSION }, version);
    const value = layout.emptyShadowRoot();
    const quarantine = [];
    const rawRooms = own(raw, 'rooms');
    if (rawRooms !== undefined && !isPlainObject(rawRooms)) quarantine.push(quarantineEntry(ns, ['rooms'], 'CONTAINER_NOT_OBJECT', rawRooms));
    else if (rawRooms !== undefined) {
        const rooms = Object.keys(rawRooms).sort();
        let kept = 0;
        for (let i = 0; i < rooms.length; i++) {
            const room = rooms[i];
            const rawRoom = own(rawRooms, room);
            let code = null;
            if (!isRoomName(room)) code = 'BAD_ROOM_NAME';
            else if (!isPlainObject(rawRoom)) code = 'EXPECTED_OBJECT';
            else if (kept >= L.shadowRooms) code = 'TOO_MANY_KEYS';
            if (code !== null) { quarantine.push(quarantineEntry(ns, ['rooms', room], code, rawRoom)); continue; }
            put(value.rooms, room, decodeShadowRoom(room, rawRoom, quarantine));
            kept++;
        }
    }
    const rawLedger = own(raw, 'ledger');
    if (rawLedger !== undefined && !isPlainObject(rawLedger)) quarantine.push(quarantineEntry(ns, ['ledger'], 'CONTAINER_NOT_OBJECT', rawLedger));
    for (let i = 0; i < SHADOW_CONTAINERS.length; i++) {
        const spec = SHADOW_CONTAINERS[i];
        if (spec.path[0] === 'ledger' && rawLedger !== undefined && !isPlainObject(rawLedger)) continue;
        decodeContainer(ns, spec, getPath(raw, spec.path), getPath(value, spec.path), quarantine, []);
    }
    // contract A.4: optional singletons (operator export request, bounded replay export);
    // an invalid value is quarantined (raw kept), the rest of the namespace loads
    for (let i = 0; i < SHADOW_OPTIONAL_FIELDS.length; i++) {
        const f = SHADOW_OPTIONAL_FIELDS[i];
        if (!has(raw, f)) continue;
        const v = own(raw, f);
        let code = firstError(validate(SHADOW_ROOT_FIELDS[f], v));
        if (code === null && findForbiddenKey(v) !== null) code = 'FORBIDDEN_KEY';
        if (code !== null) quarantine.push(quarantineEntry(ns, [f], code, v));
        else put(value, f, jsonClone(v));
    }
    const known = ['schemaVersion', 'rooms', 'ledger', 'observedOperations', 'proposals'].concat(SHADOW_OPTIONAL_FIELDS);
    Object.keys(raw).forEach(function (key) {
        if (known.indexOf(key) === -1) quarantine.push(quarantineEntry(ns, [key], 'UNKNOWN_FIELD', own(raw, key)));
    });
    if (isPlainObject(rawLedger)) {
        Object.keys(rawLedger).forEach(function (key) {
            if (key !== 'reservations') quarantine.push(quarantineEntry(ns, ['ledger', key], 'UNKNOWN_FIELD', own(rawLedger, key)));
        });
    }
    return { status: DecodeStatus.OK, schemaVersion: version, value: value, quarantine: quarantine, errors: [] };
}

function decodeMigration(raw) {
    if (raw === undefined) return { status: DecodeStatus.ABSENT, schemaVersion: null, value: null, quarantine: [], errors: [] };
    if (!isPlainObject(raw)) return incompatible('ROOT_NOT_OBJECT');
    const format = own(raw, 'formatVersion');
    if (typeof format === 'number' && Number.isInteger(format) && format > MIGRATION_FORMAT_VERSION) return incompatible('NEWER_SCHEMA', { supported: MIGRATION_FORMAT_VERSION }, format);
    const error = firstError(validate(MigrationRecord, raw));
    if (error !== null) return incompatible('CORRUPT_MIGRATION', { error: error }, typeof format === 'number' ? format : null);
    return { status: DecodeStatus.OK, schemaVersion: format, value: jsonClone(raw), quarantine: [], errors: [] };
}

/**
 * @param {'strategy'|'strategyShadow'|'strategyMigration'} namespace
 * @param {*} raw untrusted namespace content (undefined = absent)
 * @param {{meta?: {buildId?: string|null, policyVersion?: string|null}}} [options]
 */
function decode(namespace, raw, options) {
    switch (namespace) {
        case NAMESPACES.STRATEGY: return decodeStrategy(raw, options && options.meta ? options.meta : null);
        case NAMESPACES.SHADOW: return decodeShadow(raw);
        case NAMESPACES.MIGRATION: return decodeMigration(raw);
        default: throw new TypeError('StateCodec: unknown namespace ' + String(namespace));
    }
}

/**
 * Canonical JSON text of a namespace value. Throws CanonicalError for Game
 * objects, Map, NaN, Infinity, undefined, cycles.
 * @param {string} namespace
 * @param {*} value
 * @returns {string}
 */
function encode(namespace, value) {
    if (namespace !== NAMESPACES.STRATEGY && namespace !== NAMESPACES.SHADOW && namespace !== NAMESPACES.MIGRATION) throw new TypeError('StateCodec: unknown namespace ' + String(namespace));
    return canonicalJson(value);
}

/**
 * Strict validation of a whole namespace value (no quarantine allowed).
 * @returns {{ok:true}|{ok:false, errors:Array}}
 */
function validateNamespace(namespace, value) {
    if (namespace === NAMESPACES.STRATEGY) return layout.validateStrategyRoot(value);
    if (namespace === NAMESPACES.SHADOW) return layout.validateShadowRoot(value);
    if (namespace === NAMESPACES.MIGRATION) return validate(MigrationRecord, value);
    throw new TypeError('StateCodec: unknown namespace ' + String(namespace));
}

module.exports = {
    NAMESPACES,
    DecodeStatus,
    MIGRATION_FORMAT_VERSION,
    MigrationRecord,
    CONTROL_FIELDS,
    decode,
    encode,
    validateNamespace,
};
