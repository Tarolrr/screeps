// ShadowAdapter (STRAT-A5, contract A.4 §10): the stage-A shadow pipeline.
//
//   createShadowComponents({models?, recorder?, state: {observation, finance, planning},
//                           closeTick, buildInfo?, log?}) -> ComponentSpec[]
//
// Components (all budget class optional, after legacy EXECUTE):
//   RECONCILE reconcile.shadow  A3 Reconciler on the filtered snapshot T and the heap
//                               snapshot T-1 (null after a reset or a skipped tick ->
//                               gap, never zero flows); patch via the observation handle
//   FORECAST  forecast.shadow   A4 EconomyModel/ForecastCalendar/ReplacementForecast/
//                               BudgetLedger -> ForecastSummary per room via finance handle
//   PLAN      plan.shadow       planning/ShadowGovernor: mode, maturity, needs, Proposals
//   ADMIT     admit.shadow      hypothetical BudgetLedger.admit of due proposals (nothing
//                               reserved), DecisionRecord on significant change
//   CLOSE     close.shadow      interruption records (BUDGET_DEFERRED, faults), drain the
//                               recorder via planning handle, replay export, then
//                               closeTick(T) = StateStore.close(T): lastClosedTick, last write
//
// Only rooms whose router decision is newSystem SHADOW are processed (explicit per-room
// operator request Memory.strategy.control.rooms[room].requestedMode = 'shadow').
// Default (no control record / 'legacy') is legacy with NO shadow work; adaptive-v1 is
// rejected by the router (UNSUPPORTED_CAPABILITY) and only logged here.
//
// Components get values only: frame.result(...) and the writer-bound handles captured
// in this closure; each component applies ONLY through its own handle (observation:
// reconcile; finance: forecast; planning: close — ring, proposals, export). expectedRevision
// is the revision of the view read at the component's start, then the revision returned
// by its previous accepted batch. They never receive GameReadPort, MemoryPort, a gateway
// or legacy functions; nothing here issues intents.
// CPU: every component admits itself with a measured estimate (ESTIMATE_CPU priors) and
// defers with BUDGET_DEFERRED instead of reaching into the bucket.
//
// The step functions (stepReconcile, stepForecast, stepPlan, stepAdmit, drainAndClose)
// are shared verbatim with the replay pipeline (replayShadowFixture): a fixture exported
// from a live run is reproduced by `node tools/replay.js` (forecast + reason codes).

const { READY, DEFERRED, UNKNOWN, REJECTED } = require('../domain/results');
const { ReasonCode, isReasonCode } = require('../domain/reasonCodes');
const E = require('../domain/enums');
const { fingerprint } = require('../domain/fingerprint');
const { canonicalJson, canonicalClone } = require('../domain/canonical');
const { deepFreeze } = require('../domain/freeze');
const { snapshotFingerprint } = require('../domain/dtos');
const { emptyStrategyRoot, emptyShadowRoot, emptyShadowRoom, validateStatePatch, ReplayExportStatus, LIMITS } = require('../domain/stateLayout');
const { createContext } = require('../app/context');
const { DEFAULT_BUDGET_SETTINGS } = require('../app/WorkBudget');
const Reconciler = require('../app/Reconciler');
const Economy = require('../models/EconomyModel');
const Calendar = require('../models/ForecastCalendar');
const Replacement = require('../models/ReplacementForecast');
const Ledger = require('../scheduling/BudgetLedger');
const Governor = require('../planning/ShadowGovernor');
const Travel = require('../planning/TravelEstimate');
const { createDecisionRecorder } = require('../telemetry/DecisionRecorder');
const Exporter = require('../telemetry/ReplayExporter');
const { CONTRACT_VERSION, SCHEMA_VERSION } = require('../domain/version');

const DEFAULT_MODELS = Object.freeze({
    reconciler: Reconciler, economy: Economy, calendar: Calendar, replacement: Replacement,
    ledger: Ledger, governor: Governor, travel: Travel,
});

/** Commitment horizon (DESIGN §5/§12). */
const HORIZON = 1500;
/** Forecast recompute period (DESIGN §4: room needs every 25 ticks) unless a structural trigger fires. */
const FORECAST_REWRITE_TICKS = 25;
/** Upper bound of a replay fixture kept in Memory.strategyShadow.replayExport (canonical JSON chars). */
const MAX_EXPORT_CHARS = 98304;

const NAMES = Object.freeze({
    RECONCILE: 'reconcile.shadow', FORECAST: 'forecast.shadow', PLAN: 'plan.shadow', ADMIT: 'admit.shadow', CLOSE: 'close.shadow',
});
const CHAIN = Object.freeze([NAMES.RECONCILE, NAMES.FORECAST, NAMES.PLAN, NAMES.ADMIT]);

/**
 * Conservative CPU priors per component (>= the values measured in the Node loader,
 * docs/strategy/SHADOW-A.md §4; forecast = a recompute tick). Each component keeps a
 * measured estimate in heap: max(moving average, slowly decaying peak), starting at the
 * prior, and defers itself (DEFERRED BUDGET_DEFERRED) when used + estimate exceeds
 * min(limit, tickLimit) - hardMarginCpu - criticalReserveCpu (no bucket borrowing).
 */
const ESTIMATE_CPU = Object.freeze({ reconcile: 5, forecast: 10, plan: 1, admit: 1, close: 1 });
/** Static ComponentSpec.estimateCpu (TickRunner pre-check); the measured check is inside the component. */
const SPEC_ESTIMATE_CPU = 0.2;
const CPU_EMA_WEIGHT = 0.2;
const CPU_PEAK_DECAY = 0.98;
/** READY/FAILED replay exports become EXPIRED (fixture dropped) this many ticks after completion. */
const REPLAY_EXPORT_TTL = 1500;

// ---------------------------------------------------------------- helpers

function sortedUniqueCodes(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) if (isReasonCode(list[i]) && out.indexOf(list[i]) === -1) out.push(list[i]);
    return out.sort();
}

function reasonOf(result) {
    if (!result) return null;
    return result.kind === 'REJECTED' ? result.reasonCode : result.kind === 'READY' ? null : result.reason;
}

/**
 * Rooms whose router decision is SHADOW (sorted).
 * @param {object|null} routerResult frame.result('boot.router')
 * @returns {string[]}
 */
function shadowRoomsOf(routerResult) {
    if (!routerResult || routerResult.kind !== 'READY' || !routerResult.value || !routerResult.value.rooms) return [];
    const rooms = routerResult.value.rooms;
    return Object.keys(rooms).filter(function (r) { return rooms[r].newSystem === E.NewSystemStatus.SHADOW; }).sort();
}

/** Rooms with a non-READY route (adaptive-v1 request, invalid record, suspended state). */
function rejectedRoutesOf(routerResult) {
    if (!routerResult || routerResult.kind !== 'READY' || !routerResult.value || !routerResult.value.rooms) return [];
    const rooms = routerResult.value.rooms;
    return Object.keys(rooms).sort().filter(function (r) { return rooms[r].status.kind !== 'READY'; })
        .map(function (r) { return { room: r, reasonCode: rooms[r].status.reasonCode || null, newSystem: rooms[r].newSystem, requestedMode: rooms[r].requestedMode }; });
}

/** Shadow room that holds an observed binding for the creep (or null). */
function bindingRooms(view) {
    const out = {};
    const rooms = view && view.shadow ? view.shadow.rooms : {};
    for (const r in rooms) {
        const b = rooms[r].observedBindings || {};
        for (const name in b) out[name] = r;
    }
    return out;
}

/**
 * Restrict a Snapshot to the shadow rooms: rooms outside `rooms` and creeps that are
 * neither in a shadow room, nor homed there (envelope), nor already bound there are
 * dropped (no shadow work for legacy-only rooms). Returns the same object when nothing
 * is dropped; otherwise a new deep-frozen Snapshot with a recomputed fingerprint.
 * @param {object} snapshot Snapshot DTO
 * @param {string[]} rooms shadow rooms
 * @param {object|null} view StateView (observed bindings)
 */
function filterSnapshot(snapshot, rooms, view) {
    const keepRoom = {};
    for (let i = 0; i < rooms.length; i++) keepRoom[rooms[i]] = true;
    const bound = bindingRooms(view);
    let changed = false;
    const outRooms = {};
    for (const r in snapshot.rooms) { if (keepRoom[r]) outRooms[r] = snapshot.rooms[r]; else changed = true; }
    const outCreeps = {};
    const keptCreep = {};
    for (const name in snapshot.ownCreeps) {
        const c = snapshot.ownCreeps[name];
        const keep = (c.roomName !== null && keepRoom[c.roomName]) || (c.strategyEnvelope && keepRoom[c.strategyEnvelope.homeRoom]) || (bound[name] && keepRoom[bound[name]]);
        if (keep) { outCreeps[name] = c; keptCreep[name] = true; } else changed = true;
    }
    if (!changed) return snapshot;
    const missing = snapshot.missingFields.filter(function (f) {
        const parts = f.split('.');
        if (parts[0] === 'rooms') return keepRoom[parts[1]] === true;
        if (parts[0] === 'ownCreeps') return keptCreep[parts[1]] === true;
        return true;
    });
    const out = {
        dtoType: snapshot.dtoType, contractVersion: snapshot.contractVersion, tick: snapshot.tick, shard: snapshot.shard,
        captureStage: snapshot.captureStage, cpu: snapshot.cpu, rooms: outRooms, ownCreeps: outCreeps, missingFields: missing,
        fingerprint: snapshot.fingerprint,
    };
    out.fingerprint = snapshotFingerprint(out);
    return deepFreeze(out);
}

function ringOf(view, room) {
    return view && view.shadow && view.shadow.rooms[room] ? view.shadow.rooms[room].decisionRing : [];
}

function proposalsOf(view) {
    return view && view.shadow ? view.shadow.proposals : {};
}

/** Proposal without per-tick fields: stored proposals are rewritten only when this changes. */
function proposalCore(p) {
    return canonicalJson({
        roomName: p.roomName, reasonCode: p.reasonCode, reservationRequests: p.reservationRequests, dependencies: p.dependencies,
        demands: p.demands.map(function (d) { const c = Object.assign({}, d); delete c.createdAt; return c; }),
    });
}

// ---------------------------------------------------------------- shared steps

/**
 * RECONCILE: A3 reduce + apply through the observation handle. expectedRevision is the
 * revision of the view read at the start of the step (no re-read: a concurrent change
 * is STALE_INPUT, never silently rebased).
 * @param {{view: function(): object, apply: function(number, object[]): object}} handle writer-bound (observation)
 */
function stepReconcile(handle, models, snapshot, previous) {
    const view = handle.view();
    if (!view || !view.strategy) return REJECTED(ReasonCode.STALE_INPUT, { cause: 'NO_STATE_VIEW' });
    if (!view.shadow) return REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, { namespace: 'strategyShadow' });
    const res = models.reconciler.reduce(snapshot, view, { previous: previous });
    if (res.kind !== 'READY') return res;
    const patches = res.value.patches;
    if (patches.length > 0) {
        const applied = handle.apply(view.strategy.revision, patches);
        if (applied.kind !== 'READY') return REJECTED(applied.reasonCode || ReasonCode.INVALID_RECORD, { stage: 'reconcile.apply', evidence: applied.evidence || null });
    }
    // rooms whose observation is not continuous this tick (event gap: deferred/lost ticks,
    // room absent from shadow, invisibility): the governor never counts such ticks as clear
    const gapRooms = [];
    for (let i = 0; i < res.value.gaps.length; i++) if (gapRooms.indexOf(res.value.gaps[i].roomName) === -1) gapRooms.push(res.value.gaps[i].roomName);
    gapRooms.sort();
    return READY({ tick: snapshot.tick, reasonCodes: res.value.reasonCodes, domainStatus: res.value.domainStatus, gaps: res.value.gaps.length, gapRooms: gapRooms, patches: patches.length }, res.inputFingerprint);
}

/**
 * Forecast of one room (pure): A4 models over the reconciled view.
 * @returns {{summary: object, reserves: object, replacement: object, liquidity: object, travel: object, analytic: object, signals: (object|null), unexplained: boolean}}
 */
function forecastRoom(models, snapshot, view, roomName) {
    const shadowRoom = view.shadow.rooms[roomName] || emptyShadowRoom();
    const bindings = shadowRoom.observedBindings;
    const reservations = view.shadow.ledger.reservations;
    const demands = view.strategy.demands;
    const travel = models.travel.estimateTravel(snapshot, roomName, { observedBindings: bindings, functionOf: models.replacement.functionOf });
    const analytic = models.economy.analyticIncome(snapshot, roomName, bindings);
    const analyticRate = analytic.value === null ? undefined : analytic.value;
    const summary = models.economy.evaluate(snapshot, view, HORIZON, { roomName: roomName, travelEstimates: travel, analyticIncomePerTick: analyticRate });
    const input = { snapshot: snapshot, roomName: roomName, flowWindows: shadowRoom.flowWindows, reservations: reservations, demands: demands, observedBindings: bindings, horizon: HORIZON, analyticIncomePerTick: analyticRate, travelEstimates: travel };
    const model = models.calendar.buildModel(input);
    const reserves = model.kind === 'READY' ? models.calendar.reservesOfModel(model.value, model.inputFingerprint) : model;
    const replacement = models.replacement.analyzeReplacements({ snapshot: snapshot, roomName: roomName, demands: demands, observedBindings: bindings, horizon: HORIZON, travelEstimates: travel });
    const room = snapshot.rooms[roomName];
    let liquidity = { observed: { value: null, quality: E.Quality.UNKNOWN, reason: ReasonCode.NO_VISIBILITY }, free: { value: null, quality: E.Quality.UNKNOWN, reason: ReasonCode.NO_VISIBILITY } };
    let signals = null;
    const windows = shadowRoom.flowWindows;
    const lastWindow = windows.length > 0 ? windows[windows.length - 1] : null;
    const unexplained = lastWindow !== null && lastWindow.reasonCodes.indexOf(ReasonCode.UNEXPLAINED_BALANCE) !== -1;
    if (room && room.visibility === E.Visibility.VISIBLE) {
        const lv = models.ledger.createLedgerView(snapshot, reservations, roomName);
        const liq = models.ledger.liquidity(snapshot, lv);
        liquidity = { observed: liq.observed, free: liq.free };
        signals = models.economy.modeSignals({
            snapshot: snapshot, roomName: roomName, observedBindings: bindings, liquidObserved: liq.observed,
            lowerReserve: reserves.kind === 'READY' ? reserves.value.lower : null,
            replacementPlan: replacement.kind === 'READY' ? replacement.value.plan : undefined,
            forecastQuality: summary.kind === 'READY' ? summary.value.quality : E.Quality.UNKNOWN,
            unexplained: unexplained,
        });
    }
    return { summary: summary, reserves: reserves, replacement: replacement, liquidity: liquidity, travel: travel, analytic: analytic, signals: signals, unexplained: unexplained };
}

/**
 * Structural trigger of a forecast recompute (DESIGN §4: room needs every 25 ticks plus
 * events — creep set/spawning, hostiles, RCL, capacity, a new flow window, binding life).
 */
function forecastTrigger(snapshot, view, roomName) {
    const room = snapshot.rooms[roomName];
    const shadowRoom = view.shadow.rooms[roomName] || emptyShadowRoom();
    const creeps = [];
    for (const name in snapshot.ownCreeps) {
        const c = snapshot.ownCreeps[name];
        if (c.roomName === roomName || (shadowRoom.observedBindings[name])) creeps.push(name + (c.spawning ? '*' : '') + ':' + (c.legacyRole || ''));
    }
    creeps.sort();
    const life = [];
    for (const name in shadowRoom.observedBindings) life.push(name + ':' + shadowRoom.observedBindings[name].lifeState + ':' + shadowRoom.observedBindings[name].homeRoom);
    life.sort();
    const windows = shadowRoom.flowWindows.slice(-3).map(function (w) { return [w.windowStart, w.complete, w.quality]; });
    return fingerprint({
        v: room ? room.visibility : null, c: creeps, life: life, w: windows,
        sp: room ? room.spawns.map(function (x) { return x.spawning ? x.spawning.name : null; }) : null,
        h: room ? room.hostiles.length : null, l: room && room.controller ? room.controller.level : null,
        cap: room ? room.energyCapacityAvailable.value : null,
        res: Object.keys(view.shadow.ledger.reservations).length, d: Object.keys(view.strategy.demands).length,
    });
}

/**
 * Coarse liquidity band of the room against the cached reserves (BELOW_LOWER /
 * BELOW_TARGET / AT_TARGET / UNKNOWN): crossing a band recomputes the forecast at once
 * so STABILIZE entry is not delayed by the cache.
 */
function liquidityBand(models, snapshot, view, roomName, reserves) {
    const room = snapshot.rooms[roomName];
    if (!room || room.visibility !== E.Visibility.VISIBLE || !reserves || reserves.kind !== 'READY') return 'UNKNOWN';
    const liq = models.ledger.liquidity(snapshot, models.ledger.createLedgerView(snapshot, view.shadow.ledger.reservations, roomName));
    if (liq.observed.value === null) return 'UNKNOWN';
    if (liq.observed.value < reserves.value.lower) return 'BELOW_LOWER';
    return liq.observed.value < reserves.value.target ? 'BELOW_TARGET' : 'AT_TARGET';
}

/**
 * FORECAST: per shadow room, recomputed when the structural trigger or the liquidity
 * band changed, or the cached forecast is FORECAST_REWRITE_TICKS old or absent;
 * otherwise the cached result is reused (ForecastSummary.computedAt and the decision
 * record's balance.forecast.age show its age). Fresh summaries are persisted through
 * the finance handle (expectedRevision = revision of the view read at the step start).
 * @param {{view: function(): object, apply: function(number, object[]): object}} handle writer-bound (finance)
 * @param {{rooms: Object<string, {tick:number, trigger:string, band:string, fr:object}>}} cache heap cache (mutated)
 */
function stepForecast(handle, models, snapshot, rooms, cache) {
    const view = handle.view();
    if (!view || !view.shadow) return REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, { namespace: 'strategyShadow' });
    const perRoom = {};
    const fresh = {};
    const patches = [];
    for (let i = 0; i < rooms.length; i++) {
        const room = rooms[i];
        if (!snapshot.rooms[room]) continue;
        const trigger = forecastTrigger(snapshot, view, room);
        const cached = cache.rooms[room];
        if (cached && cached.trigger === trigger && snapshot.tick - cached.tick < FORECAST_REWRITE_TICKS && cached.tick < snapshot.tick &&
            liquidityBand(models, snapshot, view, room, cached.fr.reserves) === cached.band) {
            perRoom[room] = cached.fr;
            fresh[room] = false;
            continue;
        }
        const fr = forecastRoom(models, snapshot, view, room);
        cache.rooms[room] = { tick: snapshot.tick, trigger: trigger, band: liquidityBand(models, snapshot, view, room, fr.reserves), fr: fr };
        perRoom[room] = fr;
        fresh[room] = true;
        if (fr.summary.kind === 'READY') patches.push(models.economy.forecastPatch(fr.summary.value, 'fc:' + snapshot.tick + ':' + room));
    }
    if (patches.length > 0) {
        const applied = handle.apply(view.strategy.revision, patches);
        if (applied.kind !== 'READY') return REJECTED(applied.reasonCode || ReasonCode.INVALID_RECORD, { stage: 'forecast.apply', evidence: applied.evidence || null });
    }
    return READY({ rooms: perRoom, fresh: fresh }, fingerprint({ s: snapshot.fingerprint, r: rooms, t: snapshot.tick }));
}

/**
 * Seed a forecast cache as it was after `snapshot` (replay baseline): the observation
 * part of the view is the same before and after CLOSE, forecastRoom reads nothing else.
 */
function seedForecastCache(models, snapshot, view, rooms) {
    const cache = { rooms: {} };
    for (let i = 0; i < rooms.length; i++) {
        if (!snapshot.rooms[rooms[i]]) continue;
        const fr = forecastRoom(models, snapshot, view, rooms[i]);
        cache.rooms[rooms[i]] = { tick: snapshot.tick, trigger: forecastTrigger(snapshot, view, rooms[i]), band: liquidityBand(models, snapshot, view, rooms[i], fr.reserves), fr: fr };
    }
    return cache;
}

/** Spawning creeps of a room with their legacy role (explanation of legacy behaviour). */
function spawningOf(snapshot, roomName, bindings) {
    const room = snapshot.rooms[roomName];
    const out = [];
    if (!room) return out;
    for (let i = 0; i < room.spawns.length; i++) {
        const sp = room.spawns[i].spawning;
        if (!sp) continue;
        const c = snapshot.ownCreeps[sp.name];
        const b = bindings[sp.name];
        out.push({ name: sp.name, role: (c && c.legacyRole) || (b && b.legacyRole) || null });
    }
    out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    return out;
}

function selfSufficient(signals) {
    return !!signals && signals.reasons.indexOf('NO_SPAWN') === -1 && signals.reasons.indexOf('NO_HARVEST_CHAIN') === -1 && signals.reasons.indexOf('NO_FEED_CHAIN') === -1;
}

/**
 * PLAN: ShadowGovernor per room (pure).
 * @param {{lastRecord: function(string): (object|null)}} recorder
 */
function stepPlan(models, snapshot, view, rooms, forecastValue, recorder, versions, reconcileValue) {
    const tick = snapshot.tick;
    const context = createContext({
        mode: E.RoomMode.SHADOW, tick: tick, snapshot: null, stateView: null, stateRevision: view.strategy.revision,
        versions: versions, ownerTokens: {}, budget: null,
    });
    let selfRooms = 0;
    for (const r in forecastValue.rooms) if (selfSufficient(forecastValue.rooms[r].signals)) selfRooms++;
    const evaluations = {};
    for (let i = 0; i < rooms.length; i++) {
        const room = rooms[i];
        const fr = forecastValue.rooms[room];
        if (!fr) continue;
        const shadowRoom = view.shadow.rooms[room] || emptyShadowRoom();
        const roomState = {
            roomName: room, tick: tick, room: snapshot.rooms[room], revision: view.strategy.revision,
            lastClosedTick: view.strategy.lastClosedTick, snapshotFingerprint: snapshot.fingerprint,
            roomContinuous: !(reconcileValue && reconcileValue.gapRooms && reconcileValue.gapRooms.indexOf(room) !== -1),
            signals: fr.signals, summary: fr.summary, reserves: fr.reserves, replacement: fr.replacement, liquidity: fr.liquidity,
            travel: fr.travel, flowWindows: shadowRoom.flowWindows, spawning: spawningOf(snapshot, room, shadowRoom.observedBindings),
            lastRecord: recorder.lastRecord(room), empire: { selfSufficientRooms: selfRooms },
        };
        evaluations[room] = models.governor.evaluateRoom(context, roomState, { functionOf: models.replacement.functionOf });
    }
    return READY({ rooms: evaluations }, fingerprint({ s: snapshot.fingerprint, t: tick, r: rooms }));
}

const CRITICALITY_RANK = Object.freeze({ CRITICAL: 0, REQUIRED: 1, OPTIONAL: 2 });

function growthAlternative(evaluation) {
    const mode = evaluation.gov.mode;
    if (mode === Governor.Mode.GROW) return { label: 'optional-growth', proposalId: null, reasonCode: ReasonCode.SHADOW_ONLY, accepted: true };
    let code = ReasonCode.CRITICAL_DEADLINE; // SIEGE/RECOVER/ALERT: critical work first
    if (mode === Governor.Mode.STABILIZE) {
        const s = evaluation.signals || [];
        if (evaluation.unknown.length > 0) code = evaluation.unknown[0];
        else if (s.indexOf('UNEXPLAINED_BALANCE') !== -1) code = ReasonCode.UNCERTAIN_FUNDING;
        else if (s.indexOf('BELOW_LOWER_RESERVE') !== -1) code = ReasonCode.INSUFFICIENT_LIQUIDITY;
        else if (s.indexOf('RESERVE_UNKNOWN') !== -1 || s.indexOf('FORECAST_UNKNOWN') !== -1) code = ReasonCode.MISSING_FIELD;
    }
    return { label: 'optional-growth', proposalId: null, reasonCode: code, accepted: false };
}

/**
 * ADMIT (hypothetical) + DecisionRecord on significant change + proposal staging.
 * Nothing is reserved: accepted reservations live only inside this call so two
 * proposals never count the same energy.
 * @param {function(number): string} gapCause reason for ticks lost since lastClosedTick
 */
function stepAdmit(models, snapshot, view, rooms, reconcileValue, planValue, recorder, gapCause) {
    const tick = snapshot.tick;
    const out = {};
    const lastClosed = view.strategy.lastClosedTick;
    const storedProposals = proposalsOf(view);
    for (let i = 0; i < rooms.length; i++) {
        const room = rooms[i];
        const ev = planValue.rooms[room];
        if (!ev) continue;
        let seq = 0;
        let recorded = 0;
        // ticks lost since the last CLOSE (deferred/aborted/reset): one interruption record
        if (lastClosed !== null && lastClosed < tick - 1) {
            const from = lastClosed + 1;
            const gap = models.governor.interruptionRecord({
                roomName: room, tick: tick, reasonCode: gapCause(from), resultKind: 'DEFERRED',
                detail: { kind: 'LOST_TICKS', from: from, to: tick - 1 }, lastRecord: recorder.lastRecord(room), inputFingerprint: ev.inputFingerprint,
            }, seq++);
            if (models.governor.isSignificant(gap, recorder.lastRecord(room)) && recorder.append(gap).kind === 'READY') recorded++;
        }
        const reservations = models.ledger.toReservationList(view.shadow.ledger.reservations);
        const held = [];
        const domainStatus = reconcileValue.domainStatus[room] || E.DomainStatus.OK;
        const context = {
            tick: tick, revision: view.strategy.revision, domainStatus: domainStatus, ownerEpoch: 0,
            nodeClasses: snapshot.rooms[room] ? models.ledger.ledgerNodeClasses(snapshot, room) : {}, emergency: ev.gov.mode === Governor.Mode.RECOVER,
        };
        const alternatives = [];
        const rejected = [];
        const variants = [];
        let selected = null;
        const order = ev.needs.map(function (n, k) { return { need: n, proposal: ev.proposals[k] }; });
        order.sort(function (a, b) {
            if (a.need.due !== b.need.due) return a.need.due ? -1 : 1;
            const ra = CRITICALITY_RANK[a.need.criticality];
            const rb = CRITICALITY_RANK[b.need.criticality];
            if (ra !== rb) return ra - rb;
            return a.need.key < b.need.key ? -1 : a.need.key > b.need.key ? 1 : 0;
        });
        const at = { roomName: room, tick: tick, revision: view.strategy.revision, inputFingerprint: ev.inputFingerprint };
        function tryAdmit(proposal) {
            if (!snapshot.rooms[room] || snapshot.rooms[room].visibility !== E.Visibility.VISIBLE) return REJECTED(ReasonCode.NO_VISIBILITY, { roomName: room });
            const lv = models.ledger.createLedgerView(snapshot, reservations.concat(held), room);
            return models.ledger.admit(context, proposal, lv);
        }
        for (let k = 0; k < order.length; k++) {
            const need = order[k].need;
            const proposal = order[k].proposal;
            if (!need.due) {
                alternatives.push({ label: 'schedule:' + need.key, proposalId: proposal.proposalId, reasonCode: proposal.reasonCode, accepted: true });
                continue;
            }
            const r = tryAdmit(proposal);
            if (r.kind === 'READY') {
                alternatives.push({ label: 'spawn:' + need.key, proposalId: proposal.proposalId, reasonCode: proposal.reasonCode, accepted: true });
                for (let j = 0; j < r.value.reservations.length; j++) held.push(r.value.reservations[j]);
                if (selected === null) selected = proposal.proposalId;
                continue;
            }
            const code = reasonOf(r);
            alternatives.push({ label: 'spawn:' + need.key, proposalId: proposal.proposalId, reasonCode: code, accepted: false });
            rejected.push(code);
            const template = models.governor.EMERGENCY[need.fn];
            if (need.kind === 'REPLACEMENT' && template && template.cost < need.cost) {
                const variant = models.governor.proposalFor(need, at, { body: template.body, cost: template.cost, label: 'emergency' });
                const r2 = tryAdmit(variant);
                const ok = r2.kind === 'READY';
                alternatives.push({ label: 'emergency:' + need.key, proposalId: variant.proposalId, reasonCode: ok ? variant.reasonCode : reasonOf(r2), accepted: ok });
                variants.push(variant);
                if (ok) {
                    for (let j = 0; j < r2.value.reservations.length; j++) held.push(r2.value.reservations[j]);
                    if (selected === null) selected = variant.proposalId;
                    continue;
                }
            }
            alternatives.push({ label: 'defer:' + need.key, proposalId: null, reasonCode: code, accepted: true });
        }
        alternatives.push(growthAlternative(ev));
        let reasonCode = ReasonCode.SHADOW_ONLY;
        const late = ev.needs.some(function (n) { return n.reasonCode === ReasonCode.CRITICAL_DEADLINE; });
        if (rejected.length > 0) reasonCode = rejected[0];
        else if (late || ev.gov.mode === Governor.Mode.RECOVER || ev.gov.mode === Governor.Mode.SIEGE) reasonCode = ReasonCode.CRITICAL_DEADLINE;
        else if (ev.unknown.length > 0) reasonCode = ev.unknown[0];
        const record = models.governor.composeRecord(ev, { alternatives: alternatives, selectedProposalId: selected, reasonCode: reasonCode }, seq++);
        if (models.governor.isSignificant(record, recorder.lastRecord(room))) {
            if (recorder.append(record).kind === 'READY') recorded++;
        }
        // proposals of this room: upsert changed/new ones, delete those no longer proposed
        const current = ev.proposals.concat(variants);
        const currentIds = {};
        const upserts = [];
        for (let k = 0; k < current.length; k++) {
            currentIds[current[k].proposalId] = true;
            const stored = storedProposals[current[k].proposalId];
            if (!stored || proposalCore(stored) !== proposalCore(current[k])) upserts.push(current[k]);
        }
        const deletes = [];
        for (const id in storedProposals) if (storedProposals[id].roomName === room && !currentIds[id]) deletes.push(id);
        deletes.sort();
        recorder.stageProposals(room, upserts, deletes);
        out[room] = { alternatives: alternatives, selectedProposalId: selected, reasonCode: reasonCode, recorded: recorded };
    }
    return READY({ rooms: out }, fingerprint({ s: snapshot.fingerprint, t: tick }));
}

/** Reason codes of one fully processed tick (replay expectation). */
function tickReasonCodes(run) {
    const codes = [];
    if (run.reconcile) for (let i = 0; i < run.reconcile.reasonCodes.length; i++) codes.push(run.reconcile.reasonCodes[i]);
    if (run.forecast) {
        for (const room in run.forecast.rooms) {
            const fr = run.forecast.rooms[room];
            if (fr.summary.kind === 'READY') fr.summary.value.reasonCodes.forEach(function (c) { codes.push(c); });
            else codes.push(reasonOf(fr.summary));
            if (fr.reserves.kind !== 'READY') codes.push(reasonOf(fr.reserves));
            if (fr.replacement.kind !== 'READY') codes.push(reasonOf(fr.replacement));
        }
    }
    if (run.plan) for (const room in run.plan.rooms) run.plan.rooms[room].reasonCodes.forEach(function (c) { codes.push(c); });
    if (run.admit) {
        for (const room in run.admit.rooms) {
            const a = run.admit.rooms[room];
            codes.push(a.reasonCode);
            a.alternatives.forEach(function (x) { codes.push(x.reasonCode); });
        }
    }
    return sortedUniqueCodes(codes);
}

function forecastMapOf(run) {
    const out = {};
    if (!run.forecast) return out;
    const rooms = Object.keys(run.forecast.rooms).sort();
    for (let i = 0; i < rooms.length; i++) {
        const s = run.forecast.rooms[rooms[i]].summary;
        if (s.kind === 'READY') out[rooms[i]] = s.value;
    }
    return out;
}

/**
 * Persist the recorder through the planning handle as TWO batches: the decision ring
 * first (it carries the hysteresis state), then proposal upserts/deletes — a refused
 * proposal batch (e.g. the 200-proposal limit) never blocks the ring.
 * expectedRevision: revision read before the first batch, then the revision returned by
 * the previous accepted batch of this same step.
 * @returns {{ring: object|null, proposals: object|null, revision: number}}
 */
function persistRecorder(planning, recorder, tick) {
    let revision = planning.view().strategy.revision;
    const out = { ring: null, proposals: null, revision: revision };
    const ring = recorder.drainRing(tick);
    if (ring.length > 0) {
        out.ring = planning.apply(revision, ring);
        if (out.ring.kind === 'READY') revision = out.ring.value.revision;
    }
    const proposals = recorder.drainProposals(tick);
    if (proposals.length > 0) {
        out.proposals = planning.apply(revision, proposals);
        if (out.proposals.kind === 'READY') revision = out.proposals.value.revision;
    }
    out.revision = revision;
    return out;
}

/** CLOSE core shared with replay: persist the recorder, then the close hook (lastClosedTick). */
function drainAndClose(planning, recorder, tick, closeTick) {
    const persisted = persistRecorder(planning, recorder, tick);
    const closed = closeTick ? closeTick(tick) : null;
    return { persisted: persisted, closed: closed };
}

// ---------------------------------------------------------------- replay export

/**
 * State selection captured right after CLOSE of the baseline tick: everything the
 * pipeline reads (all shadow rooms of the view).
 */
function selectionOf(view) {
    const rooms = {};
    const names = Object.keys(view.shadow.rooms).sort();
    for (let i = 0; i < names.length; i++) {
        const r = view.shadow.rooms[names[i]];
        rooms[names[i]] = { eventCursor: r.eventCursor, flowWindows: r.flowWindows, observedBindings: r.observedBindings, decisionRing: r.decisionRing.slice(Math.max(0, r.decisionRing.length - 1)) };
    }
    return {
        revision: view.strategy.revision, control: view.strategy.control.rooms, lastClosedTick: view.strategy.lastClosedTick,
        observedOperations: view.shadow.observedOperations, rooms: rooms, ledgerEmpty: Object.keys(view.shadow.ledger.reservations).length === 0,
        demandsEmpty: Object.keys(view.strategy.demands).length === 0,
    };
}

/**
 * Build a shadow replay fixture (contract A.4 selection extension).
 * @param {{baseline: object, snapshots: object[], reasonCodes: string[], forecast: object, buildId: string}} input
 *   baseline: selectionOf(view after CLOSE of snapshots[0].tick)
 * @returns {object} ReplayFixture; throws TypeError/RangeError when invalid/too large
 */
function buildShadowFixture(input) {
    const b = input.baseline;
    const shadowRooms = {};
    for (const r in b.rooms) shadowRooms[r] = { eventCursor: b.rooms[r].eventCursor, flowWindows: b.rooms[r].flowWindows };
    const base = Exporter.exportFixture({
        snapshots: input.snapshots,
        stateView: { strategy: { revision: b.revision, control: { rooms: b.control } }, shadow: { rooms: shadowRooms } },
        events: [],
        expectedReasonCodes: input.reasonCodes,
        expectedForecast: input.forecast,
        buildId: input.buildId,
        policyVersion: Governor.POLICY_VERSION,
    });
    const body = canonicalClone(base.body);
    body.state.lastClosedTick = b.lastClosedTick;
    body.state.observedOperations = canonicalClone(b.observedOperations);
    for (const r in b.rooms) {
        body.state.shadowRooms[r].observedBindings = canonicalClone(b.rooms[r].observedBindings);
        body.state.shadowRooms[r].decisionRing = canonicalClone(b.rooms[r].decisionRing);
    }
    const header = Object.assign({}, base.header, { contentFingerprint: fingerprint(body) });
    const fixture = { header: header, body: body };
    const check = Exporter.validateFixture(fixture);
    if (!check.ok) {
        const error = new TypeError('buildShadowFixture: invalid fixture ' + JSON.stringify(check.errors.slice(0, 3)));
        error.errors = check.errors;
        throw error;
    }
    return fixture;
}

/** In-memory state + writer-bound handles for replay (mimics StateStore set/delete and revision semantics). */
function createMemoryState(selection, firstTick) {
    const strategy = emptyStrategyRoot(null);
    strategy.revision = selection.revision;
    strategy.control = { rooms: canonicalClone(selection.control.rooms) };
    strategy.lastClosedTick = selection.lastClosedTick === undefined ? firstTick : selection.lastClosedTick;
    const shadow = emptyShadowRoot();
    for (const r in selection.shadowRooms) {
        const s = selection.shadowRooms[r];
        const room = emptyShadowRoom();
        room.eventCursor = s.eventCursor === null ? null : canonicalClone(s.eventCursor);
        room.flowWindows = canonicalClone(s.flowWindows);
        room.observedBindings = s.observedBindings ? canonicalClone(s.observedBindings) : {};
        room.decisionRing = s.decisionRing ? canonicalClone(s.decisionRing) : [];
        shadow.rooms[r] = room;
    }
    shadow.observedOperations = selection.observedOperations ? canonicalClone(selection.observedOperations) : {};
    const state = { dtoType: 'StateView', status: E.StateStatus.OPEN, sessionTick: firstTick, blockedReason: null, quarantine: [], strategy: strategy, shadow: shadow };
    function applyOne(p) {
        const root = p.namespace === 'strategy' ? state.strategy : state.shadow;
        let node = root;
        for (let i = 0; i < p.path.length - 1; i++) {
            let child = node[p.path[i]];
            if (child === undefined || child === null) {
                child = p.namespace === 'strategyShadow' && i === 1 && p.path[0] === 'rooms' ? emptyShadowRoom() : {};
                node[p.path[i]] = child;
            }
            node = child;
        }
        const key = p.path[p.path.length - 1];
        if (p.op === E.PatchOp.SET) node[key] = canonicalClone(p.value);
        else delete node[key];
    }
    function forWriter(writer) {
        return {
            writer: writer,
            view: function () { return state; },
            apply: function (expectedRevision, patches) {
            if (expectedRevision !== state.strategy.revision) return REJECTED(ReasonCode.STALE_INPUT, { expectedRevision: expectedRevision, actualRevision: state.strategy.revision });
            for (let i = 0; i < patches.length; i++) {
                const stamped = Object.assign({}, patches[i], { writer: writer });
                const v = validateStatePatch(stamped);
                if (!v.ok) return REJECTED(ReasonCode.INVALID_RECORD, { patchId: stamped.patchId, errors: v.errors.slice(0, 3) });
            }
            for (let i = 0; i < patches.length; i++) applyOne(patches[i]);
            state.strategy.revision += 1;
            return READY({ revision: state.strategy.revision }, fingerprint({ revision: state.strategy.revision }));
            },
        };
    }
    return { state: state, observation: forWriter(E.StateWriter.OBSERVATION), finance: forWriter(E.StateWriter.FINANCE), planning: forWriter(E.StateWriter.PLANNING) };
}

/**
 * Replay pipeline 'shadow-a5' (pure; tools/replay.js): re-runs RECONCILE..CLOSE over
 * snapshots[1..n] starting from the fixture state (captured after CLOSE of
 * snapshots[0]) and returns the union of reason codes and the forecast of the last tick.
 * @param {object} fixture deep-frozen ReplayFixture
 * @returns {{reasonCodes: string[], forecast: object, summary: object}}
 */
function replayShadowFixture(fixture, options) {
    const models = Object.assign({}, DEFAULT_MODELS, (options && options.models) || {});
    const snaps = fixture.body.snapshots;
    const mem = createMemoryState(fixture.body.state, snaps[0].tick);
    const recorder = createDecisionRecorder({
        capacityPerRoom: LIMITS.decisionRingPerRoom,
        readRing: function (room) { return ringOf(mem.state, room); },
        readProposals: function () { return proposalsOf(mem.state); },
    });
    const versions = { contractVersion: CONTRACT_VERSION, schemaVersion: SCHEMA_VERSION, buildId: fixture.header.buildId, policyVersion: fixture.header.policyVersion };
    const codes = [];
    const ticks = [];
    let forecast = {};
    let previous = snaps[0];
    const cache = seedForecastCache(models, snaps[0], mem.state, Object.keys(snaps[0].rooms).sort());
    for (let i = 1; i < snaps.length; i++) {
        const snapshot = snaps[i];
        const rooms = Object.keys(snapshot.rooms).sort();
        const run = { tick: snapshot.tick };
        const adjacent = previous !== null && previous.tick === snapshot.tick - 1 ? previous : null;
        const rec = stepReconcile(mem.observation, models, snapshot, adjacent);
        if (rec.kind !== 'READY') { codes.push(reasonOf(rec)); ticks.push({ tick: snapshot.tick, stopped: 'reconcile', reason: reasonOf(rec) }); previous = null; continue; }
        run.reconcile = rec.value;
        const fc = stepForecast(mem.finance, models, snapshot, rooms, cache);
        if (fc.kind !== 'READY') { codes.push(reasonOf(fc)); ticks.push({ tick: snapshot.tick, stopped: 'forecast', reason: reasonOf(fc) }); previous = snapshot; continue; }
        run.forecast = fc.value;
        run.plan = stepPlan(models, snapshot, mem.state, rooms, run.forecast, recorder, versions, run.reconcile).value;
        run.admit = stepAdmit(models, snapshot, mem.state, rooms, run.reconcile, run.plan, recorder, function () { return ReasonCode.EVENT_GAP; }).value;
        tickReasonCodes(run).forEach(function (c) { codes.push(c); });
        forecast = forecastMapOf(run);
        drainAndClose(mem.planning, recorder, snapshot.tick, function (t) { mem.state.strategy.lastClosedTick = t; return READY({ lastClosedTick: t }, fingerprint({ t: t })); });
        const modes = {};
        for (const r in run.plan.rooms) modes[r] = run.plan.rooms[r].gov.mode;
        ticks.push({ tick: snapshot.tick, modes: modes });
        previous = snapshot;
    }
    return { reasonCodes: sortedUniqueCodes(codes), forecast: forecast, summary: { ticks: ticks } };
}

// ---------------------------------------------------------------- components

function passThrough(result, what) {
    if (!result) return UNKNOWN(ReasonCode.MISSING_FIELD, [what]);
    if (result.kind === 'DEFERRED') return DEFERRED(null, result.reason);
    if (result.kind === 'UNKNOWN') return UNKNOWN(result.reason, result.missingFields);
    if (result.kind === 'REJECTED') return REJECTED(result.reasonCode, { dependsOn: what });
    return UNKNOWN(ReasonCode.MISSING_FIELD, [what]);
}

/**
 * @param {Object} deps
 * @param {{observation: object, finance: object, planning: object}} deps.state writer-bound handles (StateStore.api().forWriter)
 * @param {function(number): object} deps.closeTick StateStore.close bound by the composition root
 * @param {object} [deps.models] model overrides (tests)
 * @param {object} [deps.recorder] DecisionRecorder (default: 100 per room over the planning view)
 * @param {{buildId?: string}} [deps.buildInfo]
 * @param {{info: function, warn: function}} [deps.log]
 * @returns {Array<object>} ComponentSpec[]
 */
function createShadowComponents(deps) {
    const state = deps && deps.state;
    if (!state || !state.observation || !state.finance || !state.planning) throw new TypeError('createShadowComponents needs state handles {observation, finance, planning}');
    if (state.observation.writer !== E.StateWriter.OBSERVATION || state.finance.writer !== E.StateWriter.FINANCE || state.planning.writer !== E.StateWriter.PLANNING) {
        throw new TypeError('createShadowComponents: each handle must be bound to its own writer');
    }
    const models = Object.assign({}, DEFAULT_MODELS, deps.models || {});
    const closeTick = typeof deps.closeTick === 'function' ? deps.closeTick : null;
    const buildInfo = deps.buildInfo || {};
    const log = deps.log || null;
    const versions = { contractVersion: CONTRACT_VERSION, schemaVersion: SCHEMA_VERSION, buildId: buildInfo.buildId || 'unbundled', policyVersion: Governor.POLICY_VERSION };
    const recorder = deps.recorder || createDecisionRecorder({
        capacityPerRoom: LIMITS.decisionRingPerRoom,
        readRing: function (room) { return ringOf(state.planning.view(), room); },
        readProposals: function () { return proposalsOf(state.planning.view()); },
    });
    const budget = Object.assign({}, DEFAULT_BUDGET_SETTINGS, deps.budgetSettings || {});
    const heap = { previous: null, run: null, globalSince: null, recording: null, routeLog: null, exportRestarts: 0, forecastCache: { rooms: {} }, cpu: {} };
    for (const key in ESTIMATE_CPU) heap.cpu[key] = { ema: ESTIMATE_CPU[key], peak: ESTIMATE_CPU[key] };

    function estimateOf(key) { return Math.max(heap.cpu[key].ema, heap.cpu[key].peak); }

    /** Measured admission + measurement of one component run (see ESTIMATE_CPU). */
    function gated(key, frame, fn) {
        const cpu = frame.services && frame.services.cpu ? frame.services.cpu : null;
        const before = cpu ? cpu.read() : null;
        if (before && before.used !== null && before.limit !== null && before.tickLimit !== null) {
            const ceiling = Math.min(before.limit, before.tickLimit) - budget.hardMarginCpu - budget.criticalReserveCpu;
            if (before.used + estimateOf(key) > ceiling) return DEFERRED(null, ReasonCode.BUDGET_DEFERRED);
        }
        const result = fn();
        if (before && before.used !== null) {
            const after = cpu.read().used;
            if (after !== null) {
                const d = Math.max(0, after - before.used);
                const c = heap.cpu[key];
                c.ema = c.ema * (1 - CPU_EMA_WEIGHT) + d * CPU_EMA_WEIGHT;
                c.peak = Math.max(d, c.peak * CPU_PEAK_DECAY);
            }
        }
        return result;
    }

    function snapshotFp(frame) {
        const s = frame.result('observe.snapshot');
        return s && s.kind === 'READY' ? s.inputFingerprint : null;
    }

    function depend(frame, name) {
        const r = frame.result(name);
        if (heap.run === null || heap.run.tick !== frame.tick || !r || r.kind !== 'READY') return passThrough(r, name);
        return null;
    }

    const reconcile = {
        name: NAMES.RECONCILE, phase: E.Phase.RECONCILE, budgetClass: E.BudgetClass.OPTIONAL, estimateCpu: SPEC_ESTIMATE_CPU,
        inputFingerprint: snapshotFp,
        run: function (frame) {
            heap.run = null;
            const rooms = shadowRoomsOf(frame.result('boot.router'));
            if (rooms.length === 0) return REJECTED(ReasonCode.NOT_REQUESTED, { shadowRooms: 0 });
            if (heap.globalSince === null) heap.globalSince = frame.tick;
            const snap = frame.result('observe.snapshot');
            if (!snap || snap.kind !== 'READY') return passThrough(snap, 'observe.snapshot');
            return gated('reconcile', frame, function () { return reconcileRun(frame, rooms, snap); });
        },
    };

    function reconcileRun(frame, rooms, snap) {
            const view = state.observation.view();
            if (!view) return REJECTED(ReasonCode.STALE_INPUT, { cause: 'NO_STATE_VIEW' });
            if (view.status !== E.StateStatus.OPEN) return REJECTED(ReasonCode.STALE_INPUT, { cause: view.status });
            const snapshot = filterSnapshot(snap.value, rooms, view);
            const previous = heap.previous !== null && heap.previous.tick === frame.tick - 1 ? heap.previous : null;
            const r = stepReconcile(state.observation, models, snapshot, previous);
            if (r.kind === 'READY') {
                heap.previous = snapshot;
                heap.run = { tick: frame.tick, rooms: rooms, snapshot: snapshot, reconcile: r.value, forecast: null, plan: null, admit: null };
            }
            return r;
    }

    const forecast = {
        name: NAMES.FORECAST, phase: E.Phase.FORECAST, budgetClass: E.BudgetClass.OPTIONAL, estimateCpu: SPEC_ESTIMATE_CPU,
        inputFingerprint: snapshotFp,
        run: function (frame) {
            const blocked = depend(frame, NAMES.RECONCILE);
            if (blocked) return blocked;
            return gated('forecast', frame, function () {
                const r = stepForecast(state.finance, models, heap.run.snapshot, heap.run.rooms, heap.forecastCache);
                if (r.kind === 'READY') heap.run.forecast = r.value;
                return r;
            });
        },
    };

    const plan = {
        name: NAMES.PLAN, phase: E.Phase.PLAN, budgetClass: E.BudgetClass.OPTIONAL, estimateCpu: SPEC_ESTIMATE_CPU,
        inputFingerprint: snapshotFp,
        run: function (frame) {
            const blocked = depend(frame, NAMES.FORECAST);
            if (blocked) return blocked;
            return gated('plan', frame, function () {
                const r = stepPlan(models, heap.run.snapshot, state.planning.view(), heap.run.rooms, heap.run.forecast, recorder, versions, heap.run.reconcile);
                if (r.kind === 'READY') heap.run.plan = r.value;
                return r;
            });
        },
    };

    const admit = {
        name: NAMES.ADMIT, phase: E.Phase.ADMIT, budgetClass: E.BudgetClass.OPTIONAL, estimateCpu: SPEC_ESTIMATE_CPU,
        inputFingerprint: snapshotFp,
        run: function (frame) {
            const blocked = depend(frame, NAMES.PLAN);
            if (blocked) return blocked;
            return gated('admit', frame, function () {
                const gapCause = function (from) { return heap.globalSince !== null && from > heap.globalSince ? ReasonCode.BUDGET_DEFERRED : ReasonCode.EVENT_GAP; };
                const r = stepAdmit(models, heap.run.snapshot, state.planning.view(), heap.run.rooms, heap.run.reconcile, heap.run.plan, recorder, gapCause);
                if (r.kind === 'READY') heap.run.admit = r.value;
                return r;
            });
        },
    };

    function logRoutes(frame) {
        if (!log) return;
        const rejected = rejectedRoutesOf(frame.result('boot.router'));
        const key = canonicalJson(rejected);
        if (key === heap.routeLog) return;
        heap.routeLog = key;
        if (rejected.length > 0) log.warn('SHADOW_ROUTE_REJECTED', { rooms: rejected.slice(0, 10) });
    }

    /** First non-READY result of the shadow chain this tick (root cause). */
    function interruptionOf(frame) {
        for (let i = 0; i < CHAIN.length; i++) {
            const r = frame.result(CHAIN[i]);
            if (!r) return { component: CHAIN[i], kind: 'DEFERRED', reason: ReasonCode.BUDGET_DEFERRED };
            if (r.kind === 'READY') continue;
            if (r.kind === 'REJECTED' && r.evidence && CHAIN.indexOf(r.evidence.dependsOn) !== -1) continue; // consequence of an earlier interruption
            return { component: CHAIN[i], kind: r.kind, reason: reasonOf(r) || ReasonCode.MISSING_FIELD };
        }
        return null;
    }

    function exportStep(view, tick, tickOk) {
        const req = view.shadow.exportRequest === undefined ? null : view.shadow.exportRequest;
        if (req === null) { heap.recording = null; return null; }
        const decision = Exporter.evaluateExportRequest(req, tick);
        const reqFp = fingerprint(req);
        const existing = view.shadow.replayExport === undefined ? null : view.shadow.replayExport;
        if (existing !== null && existing.requestFingerprint === reqFp && existing.status !== ReplayExportStatus.RECORDING) { heap.recording = null; return null; }
        if (!decision.export) return null;
        let rec = heap.recording !== null && heap.recording.reqFp === reqFp ? heap.recording : null;
        if (rec !== null && (!tickOk || tick !== rec.lastTick + 1 || rec.baseline === null)) { rec = null; heap.recording = null; heap.exportRestarts++; }
        if (rec !== null) {
            rec.snapshots.push(heap.run.snapshot);
            tickReasonCodes(heap.run).forEach(function (c) { if (rec.reasons.indexOf(c) === -1) rec.reasons.push(c); });
            rec.forecast = forecastMapOf(heap.run);
            rec.lastTick = tick;
            if (rec.snapshots.length - 1 < rec.ticks) return null;
            heap.recording = null;
            return finalizeExport(rec, tick);
        }
        if (!tickOk) return null;
        // baseline only on a tick whose forecast is freshly computed in every shadow room
        // (the replay re-derives the forecast cache from the baseline snapshot)
        const fresh = heap.run.forecast.fresh;
        for (let i = 0; i < heap.run.rooms.length; i++) if (heap.run.snapshot.rooms[heap.run.rooms[i]] && fresh[heap.run.rooms[i]] !== true) return null;
        heap.recording = { reqFp: reqFp, ticks: Math.min(decision.ticks, LIMITS.replayExportTicks), snapshots: [heap.run.snapshot], reasons: [], forecast: {}, lastTick: tick, startedAt: tick, baseline: null };
        if (existing !== null && existing.requestFingerprint === reqFp && existing.status === ReplayExportStatus.RECORDING) return null;
        return exportValue(reqFp, ReplayExportStatus.RECORDING, tick, null, null, null, null);
    }

    function exportValue(reqFp, status, startedAt, completedAt, reasonCode, detail, fixture) {
        return { requestFingerprint: reqFp, status: status, startedAt: startedAt, completedAt: completedAt, reasonCode: reasonCode, detail: detail, fixture: fixture };
    }

    function finalizeExport(rec, tick) {
        let fixture;
        try {
            fixture = buildShadowFixture({ baseline: rec.baseline, snapshots: rec.snapshots, reasonCodes: rec.reasons, forecast: rec.forecast, buildId: versions.buildId });
        } catch (error) {
            const tooLarge = error instanceof RangeError;
            return exportValue(rec.reqFp, ReplayExportStatus.FAILED, rec.startedAt, tick, tooLarge ? ReasonCode.BUDGET_DEFERRED : ReasonCode.INVALID_RECORD, { message: String(error && error.message).slice(0, 200) }, null);
        }
        const size = canonicalJson(fixture).length;
        if (size > MAX_EXPORT_CHARS) return exportValue(rec.reqFp, ReplayExportStatus.FAILED, rec.startedAt, tick, ReasonCode.BUDGET_DEFERRED, { sizeChars: size, limitChars: MAX_EXPORT_CHARS }, null);
        if (!rec.baseline.ledgerEmpty || !rec.baseline.demandsEmpty) return exportValue(rec.reqFp, ReplayExportStatus.FAILED, rec.startedAt, tick, ReasonCode.UNSUPPORTED_CAPABILITY, { cause: 'LEDGER_OR_DEMANDS_NOT_EMPTY' }, null);
        return exportValue(rec.reqFp, ReplayExportStatus.READY, rec.startedAt, tick, null, { ticks: rec.snapshots.length - 1, sizeChars: size }, fixture);
    }

    const close = {
        name: NAMES.CLOSE, phase: E.Phase.CLOSE, budgetClass: E.BudgetClass.OPTIONAL, estimateCpu: SPEC_ESTIMATE_CPU,
        run: function (frame) {
            const tick = frame.tick;
            logRoutes(frame);
            const rooms = shadowRoomsOf(frame.result('boot.router'));
            const view0 = state.planning.view();
            const usable = !!view0 && !!view0.shadow && view0.status === E.StateStatus.OPEN;
            // proposals of rooms that are no longer shadow rooms: deleted by their owner (planning)
            if (usable) {
                const stale = [];
                const stored = view0.shadow.proposals;
                for (const id in stored) if (rooms.indexOf(stored[id].roomName) === -1) stale.push(id);
                if (stale.length > 0) recorder.stageProposals(null, [], stale.sort());
            }
            if (rooms.length === 0) {
                heap.recording = null;
                if (usable && recorder.pending().proposals > 0) persistRecorder(state.planning, recorder, tick);
                return REJECTED(ReasonCode.NOT_REQUESTED, { shadowRooms: 0 });
            }
            if (!usable) return REJECTED(view0 && !view0.shadow ? ReasonCode.INCOMPATIBLE_SCHEMA : ReasonCode.STALE_INPUT, { cause: view0 ? view0.status : 'NO_STATE_VIEW' });
            return gated('close', frame, function () { return closeRun(frame, tick, rooms); });
        },
    };

    function closeRun(frame, tick, rooms) {
            const interruption = interruptionOf(frame);
            if (interruption !== null) {
                for (let i = 0; i < rooms.length; i++) {
                    const last = recorder.lastRecord(rooms[i]);
                    const record = models.governor.interruptionRecord({
                        roomName: rooms[i], tick: tick, reasonCode: isReasonCode(interruption.reason) ? interruption.reason : ReasonCode.MISSING_FIELD,
                        resultKind: interruption.kind, detail: { kind: 'INTERRUPTED', component: interruption.component, result: interruption.kind },
                        lastRecord: last, inputFingerprint: fingerprint({ tick: tick, interruption: interruption }),
                    }, 9);
                    if (models.governor.isSignificant(record, last)) recorder.append(record);
                }
            }
            const run = heap.run !== null && heap.run.tick === tick ? heap.run : null;
            const complete = run !== null && run.admit !== null && interruption === null;
            // persist decisions of this tick (ring, then proposals), then the export status, then CLOSE.
            // expectedRevision chain: read once here, then the revision returned by each accepted batch.
            const persisted = persistRecorder(state.planning, recorder, tick);
            let revision = persisted.revision;
            const ok = persisted.ring === null || persisted.ring.kind === 'READY';
            if (!ok && log) log.warn('SHADOW_RECORD_REJECTED', { reason: reasonOf(persisted.ring), tick: tick });
            if (persisted.proposals !== null && persisted.proposals.kind !== 'READY' && log) log.warn('SHADOW_PROPOSALS_REJECTED', { reason: reasonOf(persisted.proposals), tick: tick });
            function writeExport(value) {
                const a = state.planning.apply(revision, [{ patchId: 'rx:' + tick + ':' + value.status, writer: E.StateWriter.PLANNING, namespace: 'strategyShadow', path: ['replayExport'], op: E.PatchOp.SET, value: value }]);
                if (a.kind === 'READY') revision = a.value.revision;
                return a;
            }
            // TTL: a finished export is dropped (EXPIRED keeps the request identity, so it is not re-run)
            const existingExport = state.planning.view().shadow.replayExport;
            if (existingExport && (existingExport.status === ReplayExportStatus.READY || existingExport.status === ReplayExportStatus.FAILED) &&
                existingExport.completedAt !== null && tick - existingExport.completedAt >= REPLAY_EXPORT_TTL) {
                const expired = writeExport(exportValue(existingExport.requestFingerprint, ReplayExportStatus.EXPIRED, existingExport.startedAt, existingExport.completedAt, null, { expiredAt: tick, was: existingExport.status }, null));
                if (expired.kind !== 'READY' && log) log.warn('SHADOW_EXPORT_REJECTED', { reason: reasonOf(expired) });
            }
            let exportStatus = null;
            let exportValueNow = null;
            if (complete) exportValueNow = exportStep(state.planning.view(), tick, ok);
            else heap.recording = null; // an incomplete tick breaks the recorded sequence (restart later)
            if (exportValueNow !== null) {
                const a = writeExport(exportValueNow);
                exportStatus = a.kind === 'READY' ? exportValueNow.status : 'WRITE_REJECTED:' + reasonOf(a);
                if (a.kind !== 'READY') { heap.recording = null; if (log) log.warn('SHADOW_EXPORT_REJECTED', { reason: reasonOf(a), evidence: a.evidence || null }); }
                else if (log && exportValueNow.status !== ReplayExportStatus.RECORDING) log.info('SHADOW_EXPORT', { status: exportValueNow.status, reason: exportValueNow.reasonCode, detail: exportValueNow.detail });
            }
            let closed = null;
            if (run !== null && closeTick) {
                closed = closeTick(tick);
                if (closed.kind !== 'READY') { heap.recording = null; if (log) log.warn('SHADOW_CLOSE_REJECTED', { reason: reasonOf(closed) }); }
            }
            if (heap.recording !== null && heap.recording.baseline === null) {
                heap.recording.baseline = closed !== null && closed.kind === 'READY' ? selectionOf(state.planning.view()) : null;
                if (heap.recording.baseline === null) heap.recording = null;
            }
            const cpu = {};
            for (const key in heap.cpu) cpu[key] = Math.round(estimateOf(key) * 100) / 100;
            const summary = { tick: tick, rooms: rooms.length, complete: complete, interrupted: interruption ? interruption.component : null, closed: closed ? closed.kind : null, export: exportStatus, cpuEstimates: cpu };
            return READY(summary, fingerprint(summary));
    }

    return [reconcile, forecast, plan, admit, close];
}

module.exports = {
    DEFAULT_MODELS,
    HORIZON,
    FORECAST_REWRITE_TICKS,
    MAX_EXPORT_CHARS,
    NAMES,
    ESTIMATE_CPU,
    REPLAY_EXPORT_TTL,
    PIPELINE_NAME: 'shadow-a5',
    shadowRoomsOf,
    rejectedRoutesOf,
    filterSnapshot,
    forecastRoom,
    forecastTrigger,
    seedForecastCache,
    stepReconcile,
    stepForecast,
    stepPlan,
    stepAdmit,
    drainAndClose,
    persistRecorder,
    liquidityBand,
    tickReasonCodes,
    selectionOf,
    buildShadowFixture,
    createMemoryState,
    replayShadowFixture,
    createShadowComponents,
};
