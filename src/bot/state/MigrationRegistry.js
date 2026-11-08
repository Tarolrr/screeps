// MigrationRegistry and migration runner of schema1 (ARCHITECTURE §6 "Версии").
//
// Registry: chain vN -> vN+1 of pure `migrate(draft) -> draft` functions.
// Stage A registers no production migration (schema1 is the first schema);
// the runner is exercised by a synthetic v0 -> v1 chain in tests.
// Adaptive cutover is NOT part of stage A.
//
// Runner contract (freeze of the source, not continuous application):
//   start(tick, safety)  only without unresolved operations, with >= 100 ticks to
//                        the nearest critical deadline and without threats; records
//                        sourceRevision + fingerprint of the serialized source and a
//                        draft copy in Memory.strategyMigration. Memory.strategy is
//                        never written while RUNNING (StateStore opens READ_ONLY).
//   step(tick, safety)   at most one vN -> vN+1 per call; then the final swap.
//                        Cancels the draft (source intact) on: tick >= startedAt+10
//                        (window of 10 ticks), new threat, near deadline, changed
//                        source revision/fingerprint, migrate fault, invalid draft.
//                        A cancelled migration may restart only after 100 ticks.
//   reset                the runner keeps no heap state: after a global reset a new
//                        runner continues ONLY a draft whose source fingerprint and
//                        revision still match; otherwise it cancels.
//   swap                 re-compares revision AND fingerprint, validates the draft,
//                        requires a fresh world snapshot (safety.snapshotFresh) and
//                        writes the draft as the new source.

const { READY, REJECTED, DEFERRED } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { fingerprint } = require('../domain/fingerprint');
const { isPlainObject, checkJsonSafe } = require('../domain/canonical');
const E = require('../domain/enums');
const { decode, NAMESPACES, DecodeStatus, MIGRATION_FORMAT_VERSION } = require('./StateCodec');
const { own, has, put, jsonClone } = require('./objects');

const MIGRATION_WINDOW_TICKS = 10;
const MIGRATION_RESTART_DELAY = 100;
const MIN_TICKS_TO_CRITICAL_DEADLINE = 100;

/** Local cancel causes (evidence.cancelReason) and their ReasonCode. */
const CancelReason = Object.freeze({
    WINDOW_EXPIRED: 'WINDOW_EXPIRED',
    THREAT: 'THREAT',
    DEADLINE: 'DEADLINE',
    SOURCE_CHANGED: 'SOURCE_CHANGED',
    MIGRATE_FAULT: 'MIGRATE_FAULT',
    DRAFT_INVALID: 'DRAFT_INVALID',
});
const CANCEL_CODE = Object.freeze({
    WINDOW_EXPIRED: ReasonCode.BUDGET_DEFERRED,
    THREAT: ReasonCode.CRITICAL_DEADLINE,
    DEADLINE: ReasonCode.CRITICAL_DEADLINE,
    SOURCE_CHANGED: ReasonCode.STALE_INPUT,
    MIGRATE_FAULT: ReasonCode.COMPONENT_FAULT,
    DRAFT_INVALID: ReasonCode.INVALID_RECORD,
});

/**
 * @returns {{register: function(number, function(object): object): void,
 *            plan: function(number, number): object, migrate: function(number, object): object, has: function(number): boolean}}
 */
function createMigrationRegistry() {
    const steps = {};
    function register(fromVersion, migrate) {
        if (!Number.isInteger(fromVersion) || fromVersion < 0) throw new TypeError('migration fromVersion must be an integer >= 0');
        if (typeof migrate !== 'function') throw new TypeError('migrate must be a function');
        if (has(steps, String(fromVersion))) throw new TypeError('migration v' + fromVersion + ' already registered');
        put(steps, String(fromVersion), migrate);
    }
    /** READY({steps:[{from,to}]}) | REJECTED(INCOMPATIBLE_SCHEMA, {fromVersion, toVersion, missing}) */
    function plan(fromVersion, toVersion) {
        if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion) || fromVersion > toVersion) {
            return REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, { fromVersion: Number.isInteger(fromVersion) ? fromVersion : null, toVersion: Number.isInteger(toVersion) ? toVersion : null, missing: null });
        }
        const list = [];
        for (let v = fromVersion; v < toVersion; v++) {
            if (!has(steps, String(v))) return REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, { fromVersion: fromVersion, toVersion: toVersion, missing: v });
            list.push({ from: v, to: v + 1 });
        }
        return READY({ steps: list }, fingerprint({ fromVersion: fromVersion, toVersion: toVersion }));
    }
    function migrate(fromVersion, draft) {
        const fn = own(steps, String(fromVersion));
        if (!fn) throw new TypeError('no migration from v' + fromVersion);
        return fn(draft);
    }
    return Object.freeze({ register: register, plan: plan, migrate: migrate, has: function (v) { return has(steps, String(v)); } });
}

function sourceIdentity(raw) {
    if (!isPlainObject(raw)) return null;
    const safe = checkJsonSafe(raw);
    if (!safe.ok) return null;
    const rev = own(raw, 'revision');
    return { fingerprint: fingerprint(raw), revision: typeof rev === 'number' && Number.isInteger(rev) && rev >= 0 ? rev : null };
}

function safetyProblem(safety) {
    const s = safety || {};
    if (s.threat !== false) return CancelReason.THREAT; // unknown threat status counts as a threat
    if (typeof s.ticksToCriticalDeadline !== 'number' || s.ticksToCriticalDeadline < MIN_TICKS_TO_CRITICAL_DEADLINE) return CancelReason.DEADLINE;
    return null;
}

/**
 * @param {Object} options
 * @param {{source: object, migration: object}} options.ports MemoryPorts of Memory.strategy and Memory.strategyMigration
 * @param {ReturnType<typeof createMigrationRegistry>} options.registry
 * @param {number} options.targetVersion
 * @param {function(object): {ok:boolean, errors?:Array}} options.validateTarget strict validator of the final draft
 * @param {function(object, object): object} [options.finalize] (draft, record) -> draft before swap
 * @param {function(): void} [options.onSwap] called after the source was replaced (StateStore drops its session)
 * @param {{warn: function(string, object): void}} [options.log]
 */
function createMigrationRunner(options) {
    const ports = options.ports;
    const registry = options.registry;
    const target = options.targetVersion;
    const log = options.log || null;

    function readRecord() {
        const decoded = decode(NAMESPACES.MIGRATION, ports.migration.read());
        if (decoded.status === DecodeStatus.INCOMPATIBLE) return { incompatible: decoded.errors[0] };
        return { record: decoded.value };
    }
    function statusView(record) {
        if (!record) return { status: E.MigrationStatus.NONE };
        return {
            status: record.status, fromVersion: record.fromVersion, toVersion: record.toVersion, draftVersion: record.draftVersion,
            startedAt: record.startedAt, deadlineTick: record.deadlineTick, sourceRevision: record.sourceRevision, sourceFingerprint: record.sourceFingerprint,
            cancelReason: record.cancelReason, cancelledAt: record.cancelledAt, notBefore: record.notBefore, completedAt: record.completedAt,
        };
    }
    function ready(record) {
        const view = statusView(record);
        return READY(view, fingerprint(view));
    }
    function cancel(record, tick, cause, extra) {
        const next = Object.assign({}, record, {
            status: E.MigrationStatus.CANCELLED, draft: null, cancelReason: cause, cancelledAt: tick, notBefore: tick + MIGRATION_RESTART_DELAY,
        });
        ports.migration.write(next);
        const evidence = Object.assign({ cancelReason: cause, notBefore: next.notBefore, sourceRevision: record.sourceRevision }, extra || {});
        if (log) log.warn('MIGRATION_CANCELLED', evidence);
        return REJECTED(CANCEL_CODE[cause], evidence);
    }

    function finalizedFingerprint(rec) {
        if (rec.draft === null) return null;
        try {
            let draft = jsonClone(rec.draft);
            if (options.finalize) draft = options.finalize(draft, rec);
            return fingerprint(draft);
        } catch (error) {
            return null;
        }
    }

    /**
     * Cancel a RUNNING draft whose window has passed (StateStore.open calls this so
     * that an abandoned migration never freezes the store). Source stays intact.
     * @param {number} tick
     * @returns {object|null} REJECTED(cancel) when cancelled, otherwise null
     */
    function expire(tick) {
        const current = readRecord();
        if (current.incompatible || !current.record) return null;
        const rec = current.record;
        if (rec.status !== E.MigrationStatus.RUNNING || rec.deadlineTick === null || tick < rec.deadlineTick) return null;
        return cancel(rec, tick, CancelReason.WINDOW_EXPIRED, { deadlineTick: rec.deadlineTick, detectedBy: 'open' });
    }

    /**
     * @param {number} tick
     * @param {{threat:boolean, ticksToCriticalDeadline:(number|null), unresolvedOperations:(number|null)}} safety
     */
    function start(tick, safety) {
        const current = readRecord();
        if (current.incompatible) return REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, { namespace: NAMESPACES.MIGRATION, code: current.incompatible.code });
        const rec = current.record;
        if (rec && rec.status === E.MigrationStatus.RUNNING) return REJECTED(ReasonCode.STALE_INPUT, { status: rec.status, startedAt: rec.startedAt });
        if (rec && rec.notBefore !== null && tick < rec.notBefore) return REJECTED(ReasonCode.RETRY_COOLDOWN, { notBefore: rec.notBefore });
        const s = safety || {};
        if (s.unresolvedOperations !== 0) return REJECTED(ReasonCode.AMBIGUOUS_EFFECT, { cause: 'UNRESOLVED_OPERATIONS', unresolvedOperations: typeof s.unresolvedOperations === 'number' ? s.unresolvedOperations : null });
        const problem = safetyProblem(s);
        if (problem !== null) return REJECTED(CANCEL_CODE[problem], { cause: problem });
        const raw = ports.source.read();
        const identity = sourceIdentity(raw);
        if (identity === null) return REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, { cause: 'SOURCE_NOT_JSON_OBJECT' });
        const from = own(raw, 'schemaVersion');
        if (!Number.isInteger(from) || from >= target) return REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, { cause: 'NOTHING_TO_MIGRATE', schemaVersion: Number.isInteger(from) ? from : null, target: target });
        const plan = registry.plan(from, target);
        if (plan.kind !== 'READY') return plan;
        const record = {
            formatVersion: MIGRATION_FORMAT_VERSION, namespace: NAMESPACES.STRATEGY,
            fromVersion: from, toVersion: target, draftVersion: from, status: E.MigrationStatus.RUNNING,
            startedAt: tick, deadlineTick: tick + MIGRATION_WINDOW_TICKS,
            sourceRevision: identity.revision, sourceFingerprint: identity.fingerprint,
            draft: jsonClone(raw), cancelReason: null, cancelledAt: null, notBefore: null, completedAt: null,
        };
        ports.migration.write(record);
        return ready(record);
    }

    /**
     * Advance one block (or swap). Also the resume path after a global reset.
     * @param {number} tick
     * @param {{threat:boolean, ticksToCriticalDeadline:(number|null), snapshotFresh?:boolean}} safety
     */
    function step(tick, safety) {
        const current = readRecord();
        if (current.incompatible) return REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, { namespace: NAMESPACES.MIGRATION, code: current.incompatible.code });
        const rec = current.record;
        if (!rec || rec.status !== E.MigrationStatus.RUNNING) return REJECTED(ReasonCode.STALE_INPUT, { status: rec ? rec.status : E.MigrationStatus.NONE });
        if (tick >= rec.deadlineTick) return cancel(rec, tick, CancelReason.WINDOW_EXPIRED, { deadlineTick: rec.deadlineTick });
        const problem = safetyProblem(safety);
        if (problem !== null) return cancel(rec, tick, problem);
        const identity = sourceIdentity(ports.source.read());
        if (identity === null || identity.fingerprint !== rec.sourceFingerprint || identity.revision !== rec.sourceRevision) {
            // Swap already written but DONE not recorded (e.g. interrupted between the two
            // writes): the source equals the finalized draft -> record DONE, do not cancel.
            if (identity !== null && rec.draftVersion === rec.toVersion && identity.fingerprint === finalizedFingerprint(rec)) {
                const done = Object.assign({}, rec, { status: E.MigrationStatus.DONE, draft: null, completedAt: tick });
                ports.migration.write(done);
                if (log) log.warn('MIGRATION_SWAP_RECOVERED', { sourceFingerprint: identity.fingerprint, completedAt: tick });
                if (options.onSwap) options.onSwap();
                return ready(done);
            }
            return cancel(rec, tick, CancelReason.SOURCE_CHANGED, {
                expectedRevision: rec.sourceRevision, actualRevision: identity ? identity.revision : null,
                expectedFingerprint: rec.sourceFingerprint, actualFingerprint: identity ? identity.fingerprint : null,
            });
        }
        if (rec.draftVersion < rec.toVersion) {
            let draft;
            try {
                draft = registry.migrate(rec.draftVersion, jsonClone(rec.draft));
            } catch (error) {
                return cancel(rec, tick, CancelReason.MIGRATE_FAULT, { message: String(error && error.message ? error.message : error).slice(0, 200) });
            }
            if (!isPlainObject(draft) || !checkJsonSafe(draft).ok || own(draft, 'schemaVersion') !== rec.draftVersion + 1) {
                return cancel(rec, tick, CancelReason.DRAFT_INVALID, { draftVersion: rec.draftVersion + 1 });
            }
            const next = Object.assign({}, rec, { draft: draft, draftVersion: rec.draftVersion + 1 });
            ports.migration.write(next);
            return ready(next);
        }
        // final swap
        if (!safety || safety.snapshotFresh !== true) return DEFERRED({ draftVersion: rec.draftVersion }, ReasonCode.STALE_INPUT);
        let draft = jsonClone(rec.draft);
        if (options.finalize) draft = options.finalize(draft, rec);
        const check = options.validateTarget(draft);
        if (!check.ok) return cancel(rec, tick, CancelReason.DRAFT_INVALID, { errors: check.errors.slice(0, 5) });
        ports.source.write(draft);
        const done = Object.assign({}, rec, { status: E.MigrationStatus.DONE, draft: null, completedAt: tick });
        ports.migration.write(done);
        if (options.onSwap) options.onSwap();
        return ready(done);
    }

    return Object.freeze({
        start: start,
        step: step,
        expire: expire,
        /** @returns {object} READY(status view) | REJECTED(INCOMPATIBLE_SCHEMA) */
        status: function () {
            const current = readRecord();
            if (current.incompatible) return REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, { namespace: NAMESPACES.MIGRATION, code: current.incompatible.code });
            return ready(current.record);
        },
    });
}

/**
 * Finalizer for schema1 targets: strategy.migrations records the completed run.
 */
function finalizeSchema1(draft, record) {
    if (isPlainObject(draft) && has(draft, 'migrations')) {
        put(draft, 'migrations', { version: record.toVersion, cursor: null, sourceRevision: record.sourceRevision, status: E.MigrationStatus.DONE });
    }
    return draft;
}

module.exports = {
    MIGRATION_WINDOW_TICKS,
    MIGRATION_RESTART_DELAY,
    MIN_TICKS_TO_CRITICAL_DEADLINE,
    CancelReason,
    createMigrationRegistry,
    createMigrationRunner,
    finalizeSchema1,
};
