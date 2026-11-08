// StrategyApp: wires TickRunner, FaultBoundary, WorkBudget, OwnershipRouter and
// LegacyAdapter into one per-tick call. Created by main.js on the first loop
// after a global reset (never at require time).
//
// Stage-A pipeline (STAGE_A_PHASE_ORDER):
//   BOOT     boot.environment  dist2 prototype patch (exempt, never skipped)
//   BOOT     boot.router       OwnershipRouter over deps.openState (A2)
//   OBSERVE  observe.snapshot  deps.observe(frame, observationBudget) (A1 Reader);
//                              optional budget class + scoped ceiling observeCeilingCpu;
//                              default stub UNKNOWN(UNSUPPORTED_CAPABILITY)
//   EXECUTE  execute.legacy    LegacyAdapter.runTick (exempt, never skipped)
//   RECONCILE..ADMIT           extra shadow components (A3-A5), optional budget
//   CLOSE    extra components, then close.report (tick summary, heap only)
// Only these built-ins may run before EXECUTE: extra components registered in
// BOOT/OBSERVE/CRITICAL are rejected (legacy CPU baseline).
//
// Components get frame.services = {clock, cpu, log, state} — values-only ports
// and the StateStore API (deps.stateApi, A2). They never receive GameReadPort,
// MemoryPort or a gateway: the Reader gets GameReadPort inside deps.observe,
// the StateStore gets MemoryPorts inside its own construction.
//
// Guarantees:
//   - a shadow/extra component exception never prevents legacy (FaultBoundary per
//     component + a safety net that runs legacy if the runner itself failed);
//   - a legacy failure never prevents later components or CLOSE;
//   - legacy runs at most once per loop call (tickToken).

const { createTickRunner, STAGE_A_PHASE_ORDER } = require('./TickRunner');
const { createFaultBoundary } = require('./FaultBoundary');
const { createWorkBudget, createScopedBudget } = require('./WorkBudget');
const { routeRooms } = require('./OwnershipRouter');
const { READY, UNKNOWN } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { Phase, BudgetClass } = require('../domain/enums');
const { fingerprint } = require('../domain/fingerprint');

const MAX_STACK = 1000;

function errorText(error) {
    const stack = error && typeof error.stack === 'string' ? error.stack : String(error && error.message ? error.message : error);
    return stack.slice(0, MAX_STACK);
}

/**
 * @param {Object} deps
 * @param {{clock:object, cpu:object, log:object}} deps.ports values-only runtime ports (clock, cpu, log)
 * @param {{prepareEnvironment:function(), runTick:function(number):object}} deps.legacy LegacyAdapter
 * @param {function(): string[]} [deps.listRoomNames] room names to route in BOOT
 * @param {function(object): (object|null)} [deps.openState] StateStore.open hook (A2); null result = no store
 * @param {object|null} [deps.stateApi] StateStore API exposed to components as frame.services.state (A2)
 * @param {function(object, object): object} [deps.observe] OBSERVE hook (frame, observationBudget) -> Result<Snapshot> (A1 Reader)
 * @param {Array<import('./TickRunner').ComponentSpec>} [deps.components] stage-A shadow components (RECONCILE..CLOSE only)
 * @param {object} [deps.faultStore] FaultBoundary store (A2 may persist it)
 * @param {object} [deps.budgetSettings]
 * @param {string[]} [deps.phaseOrder] defaults to STAGE_A_PHASE_ORDER
 * @param {object} [deps.buildInfo] {buildId, contractVersion, schemaVersion}
 */
function createStrategyApp(deps) {
    const ports = deps.ports;
    const log = ports.log;
    const legacy = deps.legacy;
    const faultBoundary = createFaultBoundary({ store: deps.faultStore, log: log });
    const workBudget = createWorkBudget(ports.cpu, deps.budgetSettings);
    const services = Object.freeze({ clock: ports.clock, cpu: ports.cpu, log: log, state: deps.stateApi || null });
    const phaseOrder = deps.phaseOrder || STAGE_A_PHASE_ORDER;
    const runner = createTickRunner({ faultBoundary: faultBoundary, workBudget: workBudget, log: log, phaseOrder: phaseOrder, services: services });
    const listRoomNames = deps.listRoomNames || function () { return []; };
    const openState = deps.openState || function () { return null; };
    const observe = deps.observe || function () {
        // Stub until A1's Reader is wired: snapshot capability absent in this build.
        return UNKNOWN(ReasonCode.UNSUPPORTED_CAPABILITY, ['snapshot']);
    };
    const buildInfo = deps.buildInfo || null;
    const preLegacyPhases = phaseOrder.slice(0, phaseOrder.indexOf(Phase.EXECUTE));

    let tickToken = 0;
    let lastReport = null;

    runner.register({
        name: 'boot.environment',
        phase: Phase.BOOT,
        budgetClass: BudgetClass.EXEMPT,
        bypassCooldown: true,
        run: function () {
            legacy.prepareEnvironment();
            return READY(null, fingerprint('boot.environment'));
        },
    });

    runner.register({
        name: 'boot.router',
        phase: Phase.BOOT,
        budgetClass: BudgetClass.CRITICAL,
        bypassCooldown: true,
        run: function (frame) {
            const state = openState(frame);
            const roomNames = listRoomNames();
            const table = routeRooms({ state: state, roomNames: roomNames });
            return READY(table, fingerprint({ state: state, roomNames: roomNames }));
        },
    });

    runner.register({
        name: 'observe.snapshot',
        phase: Phase.OBSERVE,
        budgetClass: BudgetClass.OPTIONAL,
        run: function (frame) {
            // Runs before execute.legacy in the same tick, under a stage-A CPU ceiling.
            return observe(frame, createScopedBudget(workBudget, ports.cpu, workBudget.settings.observeCeilingCpu));
        },
    });

    runner.register({
        name: 'execute.legacy',
        phase: Phase.EXECUTE,
        budgetClass: BudgetClass.EXEMPT,
        bypassCooldown: true,
        run: function (frame) {
            let outcome;
            try {
                outcome = legacy.runTick(frame.tickToken);
            } catch (error) {
                log.error('LEGACY_INIT_FAULT', { stack: errorText(error) });
                throw error;
            }
            return READY(outcome, fingerprint({ tickToken: frame.tickToken }));
        },
    });

    const extra = deps.components || [];
    for (let i = 0; i < extra.length; i++) {
        if (preLegacyPhases.indexOf(extra[i].phase) !== -1) {
            throw new TypeError('component ' + extra[i].name + ' may not run before legacy EXECUTE in stage A (phase ' + extra[i].phase + ')');
        }
        runner.register(extra[i]);
    }

    runner.register({
        name: 'close.report',
        phase: Phase.CLOSE,
        budgetClass: BudgetClass.CRITICAL,
        bypassCooldown: true,
        run: function (frame) {
            const legacyResult = frame.result('execute.legacy');
            const summary = { tick: frame.tick, legacy: legacyResult ? legacyResult.kind : null, buildId: buildInfo ? buildInfo.buildId : null };
            return READY(summary, fingerprint(summary));
        },
    });

    /**
     * @param {number} [externalToken] loop counter owned by main.js (shared with its fallback path)
     */
    function tick(externalToken) {
        tickToken = typeof externalToken === 'number' ? externalToken : tickToken + 1;
        const token = tickToken;
        let report = null;
        try {
            report = runner.runTick({ tick: ports.clock.tick(), tickToken: token });
        } catch (error) {
            log.error('TICK_RUNNER_FAULT', { stack: errorText(error) });
        }
        // Safety net: legacy must run once per loop even if the runner itself failed.
        try {
            legacy.runTick(token);
        } catch (error) {
            log.error('LEGACY_INIT_FAULT', { stack: errorText(error) });
        }
        lastReport = report;
        return report;
    }

    return Object.freeze({
        tick: tick,
        lastReport: function () { return lastReport; },
        plan: runner.plan,
        faultStatus: faultBoundary.status,
    });
}

module.exports = { createStrategyApp };
