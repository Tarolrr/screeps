// Shared helpers of the A2 StateStore tests.
const { createMemoryPort } = require('../../../../src/bot/app/ports');
const { createTrapMemory } = require('../../support/trapRuntime');
const { createStateStore } = require('../../../../src/bot/state/StateStore');
const { buildOperationKey } = require('../../../../src/bot/domain/keys');
const F = require('../../support/fixtures');

const STRATEGY_KEYS = ['strategy', 'strategyShadow', 'strategyMigration'];
const LEGACY = { creeps: { h1: { role: 'harvester' } }, resourceManager: { resources: { a: { id: 1 } } }, rooms: { W5N8: { x: 1 } }, spawns: {}, flags: {}, loggerState: { currentLevel: 'trace' } };

/**
 * A Memory that behaves like the runtime between ticks: `nextTick()` re-parses the
 * serialized content into fresh objects (new trap). Writes outside the strategy
 * namespaces throw (TrapViolation).
 */
function createWorld(initial) {
    let trap = createTrapMemory(initial === undefined ? LEGACY : initial, { allowedRootKeys: STRATEGY_KEYS });
    let journal = { writes: [], violations: [] };
    let tick = F.TICK;
    const getMemory = function () { return trap.Memory; };
    const memory = {};
    STRATEGY_KEYS.forEach(function (ns) { memory[ns] = createMemoryPort(getMemory, ns); });
    const clock = { tick: function () { return tick; } };
    const logLines = [];
    const log = {
        debug: function (c, f) { logLines.push(['DEBUG', c, f]); },
        info: function (c, f) { logLines.push(['INFO', c, f]); },
        warn: function (c, f) { logLines.push(['WARN', c, f]); },
        error: function (c, f) { logLines.push(['ERROR', c, f]); },
    };
    function collect() {
        trap.journal.writes.forEach(function (w) { journal.writes.push(w); });
        trap.journal.violations.forEach(function (w) { journal.violations.push(w); });
        trap.journal.writes.length = 0;
        trap.journal.violations.length = 0;
    }
    return {
        memory: memory,
        clock: clock,
        log: log,
        logLines: logLines,
        get tick() { return tick; },
        raw: function () { return trap.raw; },
        serialize: function () { return trap.serialize(); },
        /** Writes/violations since the previous call (across tick boundaries). */
        journal: function () { collect(); const out = journal; journal = { writes: [], violations: [] }; return out; },
        /** Runtime tick boundary: Memory is serialized and re-parsed. */
        nextTick: function (by) {
            collect();
            const text = trap.serialize();
            trap = createTrapMemory(JSON.parse(text), { allowedRootKeys: STRATEGY_KEYS });
            tick += by === undefined ? 1 : by;
            return tick;
        },
        setTick: function (t) { tick = t; },
        /** Out-of-band edit (operator console / another build) between ticks. */
        edit: function (fn) { const data = JSON.parse(trap.serialize()); fn(data); trap = createTrapMemory(data, { allowedRootKeys: STRATEGY_KEYS }); },
        store: function (extra) { return createStateStore(Object.assign({ memory: memory, buildInfo: { buildId: 'b-test', contractVersion: 'A.2', schemaVersion: 1 }, log: log, clock: clock }, extra || {})); },
    };
}

function opKey(occurrence, generation) {
    return buildOperationKey({ domain: F.ROOM, ownerEpoch: 7, demandStableKey: F.ROOM + '/feeding/spawn1', generation: generation === undefined ? 2 : generation, action: 'spawn', occurrence: String(occurrence) });
}

function operation(occurrence, state, extra) {
    const key = opKey(occurrence);
    return Object.assign({
        operationKey: key, state: state || 'CONFIRMED', createdAt: F.TICK, updatedAt: F.TICK + 1, issuedAt: F.TICK, lastCommandId: 'cmd-' + occurrence,
        actorRef: 'Spawn1', targetRef: null, requestedAmount: 150, confirmedAmount: state === 'CONFIRMED' || state === undefined ? 150 : 0, reservationIds: [],
        lastReceipt: null,
        lastEffect: state === 'CONFIRMED' || state === undefined ? { kind: 'CONFIRMED', operationKey: key, commandId: 'cmd-' + occurrence, evaluatedAt: F.TICK + 1, confirmedAmount: 150, effect: { ok: true }, evidence: null, reason: null, eventKeys: [] } : null,
        reasonCode: state === 'UNKNOWN' || state === 'UNKNOWN_RETIRED' ? 'AMBIGUOUS_EFFECT' : null,
    }, extra || {});
}

/** A schema1 strategy root with adaptive-era data (ids, keys, generation, occurrence, watermark). */
function richStrategyRoot() {
    const root = F.sampleStrategyRoot();
    root.operations[opKey(0)] = operation(0, 'CONFIRMED');
    root.operations[opKey(1)] = operation(1, 'ISSUED');
    root.operations[opKey(2)] = operation(2, 'UNKNOWN');
    root.bindings.h1 = F.sampleBinding();
    root.demands[F.sampleDemand().stableKey] = F.sampleDemand();
    root.assignments['as-1'] = { assignmentId: 'as-1', watermarks: { [opKey(0).slice(0, opKey(0).lastIndexOf('/'))]: { closedThrough: 41, compactedCount: 42, confirmedAmount: 6300 } } };
    root.ledger.reservations.r1 = F.sampleReservation();
    root.faults['plan.room'] = { component: 'plan.room', consecutiveFailures: 1, totalFailures: 4, lastFailureTick: F.TICK - 3, lastInputFingerprint: null, lastErrorCode: 'TypeError', breakerUntil: null, halfOpen: false };
    return root;
}

module.exports = { STRATEGY_KEYS, LEGACY, createWorld, opKey, operation, richStrategyRoot };
