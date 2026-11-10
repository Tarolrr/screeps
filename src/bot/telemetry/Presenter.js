// Presenter (STRAT-VIEW, contract A.5): component `present.shadow` (phase CLOSE, after
// close.shadow) — shows what the shadow strategy computed. Off by default.
//
//   createPresenter({visual, console, flags, log?, budgetSettings?, limits?, maxOps?})
//     -> {component: ComponentSpec, modelFor(room, view), lastSnapshotTick()}
//
// Inputs (read-only, nothing is recomputed): the current Snapshot (frame.result
// 'observe.snapshot'), the StateView (frame.services.state.view(): decision ring,
// forecast, flow windows, proposals) and the router result (shadow rooms). Narrow ports:
//   visual  VisualPort (RoomVisual drawing; not a game intent)
//   console ConsolePort (operator lines)
//   flags   OperatorFlagReader (copy of Memory.strategyView; never writes)
// No GameReadPort, MemoryPort, gateway or writer handle: the presenter writes no Memory.
//
// Overlay: only rooms whose router decision is SHADOW AND Memory.strategyView.rooms.<room>
// .overlay === true; bounded draw ops per room (present/layout.js). Console: event lines
// only on change (present/events.js), <= 5 lines per tick, deduped per room; the last
// emitted state per room lives in heap, after a reset it falls back to the decision
// records before this tick (no repeated lines). Budget class optional + a measured CPU
// estimate: under CPU shortage the component returns DEFERRED(BUDGET_DEFERRED) and draws
// nothing. Exceptions are contained by the FaultBoundary of TickRunner.

const { READY, DEFERRED, REJECTED } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const E = require('../domain/enums');
const { fingerprint } = require('../domain/fingerprint');
const { DEFAULT_BUDGET_SETTINGS } = require('../app/WorkBudget');
const { shadowRoomsOf } = require('../integration/ShadowAdapter');
const { buildRoomModel } = require('./present/model');
const { buildDrawOps } = require('./present/layout');
const Events = require('./present/events');
const { resolveFlags } = require('./present/flags');

const NAME = 'present.shadow';
/** Conservative prior CPU estimate (measured: well below, see docs/strategy/SHADOW-A.md §5). */
const ESTIMATE_CPU = 1.5;
const SPEC_ESTIMATE_CPU = 0.2;
const CPU_EMA_WEIGHT = 0.2;
const CPU_PEAK_DECAY = 0.98;
/** An unchanged invalid Memory.strategyView is logged again at most this often. */
const FLAG_PROBLEM_LOG_TICKS = 1000;

/** Own creeps located in the room. */
function creepsIn(snapshot, room) {
    const out = [];
    if (!snapshot) return out;
    for (const name in snapshot.ownCreeps) if (snapshot.ownCreeps[name].roomName === room) out.push(snapshot.ownCreeps[name]);
    return out;
}

function proposalsIn(view, room) {
    const out = [];
    const all = view && view.shadow ? view.shadow.proposals : {};
    const ids = Object.keys(all).sort();
    for (let i = 0; i < ids.length; i++) if (all[ids[i]].roomName === room) out.push(all[ids[i]]);
    return out;
}

/**
 * Pure model input of one room.
 * @param {string} room
 * @param {number} tick
 * @param {object|null} snapshot Snapshot DTO (or null)
 * @param {object} view StateView (shadow non-null)
 */
function roomInput(room, tick, snapshot, view) {
    return {
        tick: tick, roomName: room,
        room: snapshot && snapshot.rooms[room] ? snapshot.rooms[room] : null,
        creeps: creepsIn(snapshot, room),
        shadowRoom: view.shadow.rooms[room] || null,
        proposals: proposalsIn(view, room),
    };
}

/**
 * @param {Object} deps
 * @param {{text: function, rect: function, line: function, circle: function, poly: function, available: function(): boolean}} deps.visual VisualPort
 * @param {{log: function(string): void}} deps.console ConsolePort
 * @param {{read: function(): *}} deps.flags OperatorFlagReader
 * @param {{warn: function}} [deps.log]
 * @param {object} [deps.budgetSettings]
 * @param {object} [deps.limits] event limiter options
 * @param {number} [deps.maxOps] max draw ops per room
 */
function createPresenter(deps) {
    if (!deps || !deps.visual || !deps.console || !deps.flags) throw new TypeError('createPresenter needs {visual, console, flags}');
    const visual = deps.visual;
    const consolePort = deps.console;
    const flagReader = deps.flags;
    const log = deps.log || null;
    const budget = Object.assign({}, DEFAULT_BUDGET_SETTINGS, deps.budgetSettings || {});
    const limiter = Events.createEventLimiter(deps.limits);
    const heap = { events: {}, snapshot: null, flagProblem: null, flagProblemTick: null, cpu: { ema: ESTIMATE_CPU, peak: ESTIMATE_CPU } };

    function estimate() { return Math.max(heap.cpu.ema, heap.cpu.peak); }

    function reportFlagProblem(problem, tick) {
        if (problem === null) { heap.flagProblem = null; return; }
        if (problem === heap.flagProblem && heap.flagProblemTick !== null && tick - heap.flagProblemTick < FLAG_PROBLEM_LOG_TICKS) return;
        heap.flagProblem = problem;
        heap.flagProblemTick = tick;
        if (log) log.warn('VIEW_FLAGS_INVALID', { namespace: 'strategyView', problem: problem, using: 'defaults (overlay off, console on)' });
    }

    function draw(room, ops) {
        let n = 0;
        for (let i = 0; i < ops.length; i++) {
            const fn = visual[ops[i].shape];
            if (typeof fn !== 'function') continue;
            if (fn.apply(null, [room].concat(ops[i].args)) !== false) n++;
        }
        return n;
    }

    function emitEvents(room, tick, model, input) {
        const next = Events.eventState(model);
        const prev = heap.events[room] !== undefined ? heap.events[room] : Events.baselineState(input.shadowRoom, input.proposals, tick);
        const events = Events.diffEvents(prev, next, model);
        let printed = 0;
        const capped = [];
        for (let i = 0; i < events.length; i++) {
            const line = Events.formatLine(room, tick, events[i]);
            const verdict = limiter.admit(room, tick, events[i].kind + '|' + events[i].text);
            if (verdict === 'PRINT') { consolePort.log(line); printed++; } else if (verdict === 'CAPPED') capped.push(events[i].kind);
        }
        // a capped event keeps its previous state, so it is retried on the next tick
        heap.events[room] = Events.mergeState(prev, next, capped);
        return printed;
    }

    function run(frame) {
        const tick = frame.tick;
        const rooms = shadowRoomsOf(frame.result('boot.router'));
        if (rooms.length === 0) { heap.snapshot = null; return REJECTED(ReasonCode.NOT_REQUESTED, { shadowRooms: 0 }); }
        if (typeof tick !== 'number') return REJECTED(ReasonCode.MISSING_FIELD, { field: 'tick' });
        const cpu = frame.services && frame.services.cpu ? frame.services.cpu : null;
        const before = cpu ? cpu.read() : null;
        if (!before || before.used === null || before.limit === null || before.tickLimit === null) return DEFERRED(null, ReasonCode.BUDGET_DEFERRED);
        const ceiling = Math.min(before.limit, before.tickLimit) - budget.hardMarginCpu - budget.criticalReserveCpu;
        if (before.used + estimate() > ceiling || (before.bucket !== null && before.bucket < budget.minShadowBucket)) return DEFERRED(null, ReasonCode.BUDGET_DEFERRED);

        const snap = frame.result('observe.snapshot');
        const snapshot = snap && snap.kind === 'READY' ? snap.value : null;
        if (snapshot !== null) heap.snapshot = snapshot;
        const flags = resolveFlags(flagReader.read(), rooms);
        reportFlagProblem(flags.problem, tick);
        const stateApi = frame.services ? frame.services.state : null;
        const view = stateApi && typeof stateApi.view === 'function' ? stateApi.view() : null;
        const summary = { tick: tick, rooms: rooms.length, overlayRooms: flags.overlayRooms.slice(), console: flags.console, ops: 0, lines: 0, flagProblem: flags.problem, state: view && view.shadow ? 'OPEN' : 'NO_STATE' };
        if (!view || !view.shadow || view.status === E.StateStatus.SUSPENDED) return READY(summary, fingerprint(summary));

        for (let i = 0; i < rooms.length; i++) {
            const room = rooms[i];
            const overlay = flags.overlayRooms.indexOf(room) !== -1;
            if (!overlay && !flags.console) continue;
            const input = roomInput(room, tick, snapshot, view);
            const model = buildRoomModel(input);
            if (overlay) summary.ops += draw(room, buildDrawOps(model, { maxOps: deps.maxOps }));
            if (flags.console) summary.lines += emitEvents(room, tick, model, input);
        }
        const after = cpu.read().used;
        if (after !== null) {
            const d = Math.max(0, after - before.used);
            heap.cpu.ema = heap.cpu.ema * (1 - CPU_EMA_WEIGHT) + d * CPU_EMA_WEIGHT;
            heap.cpu.peak = Math.max(d, heap.cpu.peak * CPU_PEAK_DECAY);
        }
        summary.cpuEstimate = Math.round(estimate() * 100) / 100;
        return READY(summary, fingerprint(summary));
    }

    const component = {
        name: NAME, phase: E.Phase.CLOSE, budgetClass: E.BudgetClass.OPTIONAL, estimateCpu: SPEC_ESTIMATE_CPU,
        run: run,
    };

    return {
        component: component,
        /**
         * RoomModel of a room from the last snapshot seen by the component and a StateView
         * (strat.report / strat.why, outside loop). null when there is no shadow state.
         */
        modelFor: function (room, view, tick) {
            if (!view || !view.shadow) return null;
            const t = typeof tick === 'number' ? tick : view.sessionTick;
            return buildRoomModel(roomInput(room, t, heap.snapshot, view));
        },
        lastSnapshotTick: function () { return heap.snapshot ? heap.snapshot.tick : null; },
    };
}

module.exports = { NAME, ESTIMATE_CPU, createPresenter, roomInput };
