// ForecastCalendar (A4): dated balance of obligations over the commitment
// horizon (DESIGN §5, §12: 1500 ticks). Pure: values in, Result out; stage A
// computes shadow values only.
//
// Model: piecewise-constant income streams (INCOME = rate change, energy/tick)
// and unique payments (PAYMENT, one per stableKey). Deficit of a calendar =
// ceil(max prefix sum of (payments − income)), i.e. the starting liquid stock
// that keeps every prefix non-negative.
//
// Scenarios (DESIGN §5 "Расчёт v1"): normal; loss of every provider of the
// harvest function, of the feed function, of both — each applied now and at the
// nearest replacement deadline of the affected function. The lost executors'
// own future replacement payments are replaced by the emergency template
// payments (never both). Lower reserve = max deficit of these base scenarios.
// Target reserve = max(lower, same scenarios with all remote income set to 0
// during the first 300 ticks); payments stay unique by stableKey, nothing of
// the first 300 ticks is added twice, and a Reservation never duplicates the
// payment it funds.
//
// UNKNOWN propagates: an unknown income rate, payment date/amount or recovery
// time that matters makes the reserve UNKNOWN, never 0.

'use strict';

const E = require('../domain/enums');
const { measured, unknownMeasure, validateCalendar, validateSnapshot } = require('../domain/dtos');
const { READY, UNKNOWN, REJECTED } = require('../domain/results');
const { fingerprint } = require('../domain/fingerprint');
const { isOperationKey, parseOperationKey } = require('../domain/keys');
const Ledger = require('../scheduling/BudgetLedger');
const Replacement = require('./ReplacementForecast');
const Economy = require('./EconomyModel');

/** DESIGN §5/§12 constants (initial settings, not optimum). */
const COMMITMENT_HORIZON = 1500;
const REMOTE_OFF_TICKS = 300;

/** Emergency templates (DESIGN §7 / calculations.md: starter WORK+CARRY+MOVE = 200). */
const DEFAULT_EMERGENCY_TEMPLATES = Object.freeze({
    harvest: Object.freeze({ body: Object.freeze(['work', 'carry', 'move']) }),
    feed: Object.freeze({ body: Object.freeze(['carry', 'carry', 'move']) }),
});

const Q_RANK = { OBSERVED: 0, DERIVED: 1, ESTIMATED: 2, STALE: 3, UNKNOWN: 4 };
function worse(a, b) { return Q_RANK[a] >= Q_RANK[b] ? a : b; }

function addReason(list, code) {
    if (code && list.indexOf(code) === -1) list.push(code);
}

function sortedReasons(list) {
    return list.slice().sort();
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/**
 * Build the internal finance model of one room.
 *
 * @param {object} input
 * @param {object} input.snapshot Snapshot
 * @param {string} [input.roomName] required for multi-room snapshots
 * @param {object[]} [input.flowWindows] FlowWindow[] of the room (A3)
 * @param {object[]|object} [input.reservations] Reservation list/record
 * @param {object[]|object} [input.demands] Demand list/record
 * @param {object} [input.observedBindings] {[creep]: ObservedBinding}
 * @param {number} [input.horizon] default 1500
 * @param {Array<{stableKey:string, ratePerTick:object, remote?:boolean, functions?:string[]}>} [input.incomeStreams]
 *        explicit income streams (Measured rates); default: one local stream from the flow lower bound
 * @param {number} [input.analyticIncomePerTick] analytic limiter for the no-history case (×0.8)
 * @param {boolean} [input.knownFailure] known failure of the local flow (=> 0)
 * @param {object} [input.travelEstimates] Measured upper travel per slot/role/function ('emergency:<fn>' for templates)
 * @param {object} [input.emergencyTemplates] {harvest|feed: {body, incomeRate?}}
 * @param {object} [input.constants]
 * @returns {object} READY(model) | UNKNOWN | REJECTED
 */
function buildModel(input) {
    const snapshot = input.snapshot;
    const sv = validateSnapshot(snapshot);
    if (!sv.ok) return REJECTED('INVALID_RECORD', { what: 'snapshot', errors: sv.errors });
    const names = Object.keys(snapshot.rooms);
    const roomName = input.roomName || (names.length === 1 ? names[0] : null);
    if (!roomName || !snapshot.rooms[roomName]) return UNKNOWN('MISSING_FIELD', ['roomName']);
    const horizon = input.horizon === undefined ? COMMITMENT_HORIZON : input.horizon;
    if (!(Number.isInteger(horizon) && horizon >= 1)) return REJECTED('INVALID_RECORD', { what: 'horizon' });
    const fromTick = snapshot.tick;
    const end = fromTick + horizon;
    const constants = input.constants || Replacement.DEFAULT_CONSTANTS;
    const reasons = [];

    // Income streams.
    const streams = [];
    if (Array.isArray(input.incomeStreams)) {
        for (let i = 0; i < input.incomeStreams.length; i++) {
            const s = input.incomeStreams[i];
            streams.push({ stableKey: s.stableKey, rate: s.ratePerTick, remote: s.remote === true, functions: (s.functions || []).slice() });
        }
    } else {
        const lower = Economy.incomeLowerBound(input.flowWindows || [], { analyticIncomePerTick: input.analyticIncomePerTick, knownFailure: input.knownFailure, currentTick: snapshot.tick });
        streams.push({ stableKey: roomName + '/income/local', rate: lower.rate, remote: false, functions: ['feed', 'harvest'] });
        addReason(reasons, lower.reasonCode);
    }
    streams.sort(function (a, b) { return cmp(a.stableKey, b.stableKey); });

    // Replacements.
    const rep = Replacement.analyzeReplacements({
        snapshot: snapshot, roomName: roomName, demands: input.demands, observedBindings: input.observedBindings,
        horizon: horizon, travelEstimates: input.travelEstimates, constants: constants,
    });
    if (rep.kind !== 'READY') return rep;
    const plan = rep.value.plan;
    const meta = rep.value.meta;

    const payments = {};
    const deadlines = [];
    const providers = { harvest: [], feed: [] };
    function putPayment(p) {
        const prev = payments[p.stableKey];
        if (!prev) { payments[p.stableKey] = p; return; }
        // Same obligation from two sources: keep one; conservative date and amount.
        if (p.amount !== null && (prev.amount === null || p.amount > prev.amount)) prev.amount = p.amount;
        if (p.tick !== null && (prev.tick === null || p.tick < prev.tick)) prev.tick = p.tick;
        prev.quality = worse(prev.quality, p.quality);
        if (p.latest !== null && (prev.latest === null || p.latest < prev.latest)) prev.latest = p.latest;
        prev.sources = prev.sources.concat(p.sources).sort();
    }
    for (let i = 0; i < plan.entries.length; i++) {
        const e = plan.entries[i];
        const m = meta[e.stableKey];
        if ((m.fn === 'harvest' || m.fn === 'feed') && providers[m.fn].indexOf(m.slotKey) === -1) providers[m.fn].push(m.slotKey);
        if (e.deadline !== null && e.deadline <= end) deadlines.push({ stableKey: e.stableKey, tick: Math.max(fromTick, e.deadline), fn: m.fn, slotKey: m.slotKey, amount: m.cost });
        if (e.criticality === E.Criticality.OPTIONAL) continue;
        const tick = m.paymentTick;
        if (tick !== null && tick > end) continue;
        putPayment({
            stableKey: e.stableKey, tick: tick, amount: m.cost, quality: e.quality, reason: e.reasonCode, pool: true,
            slotKey: m.slotKey, fn: m.fn, latest: e.deadline === null || e.travelTime.value === null ? null : e.deadline - e.travelTime.value - e.spawnTime,
            fallbackTick: e.deadline === null ? fromTick : Math.max(fromTick, Math.min(end, e.deadline)), sources: ['replacement'],
        });
    }

    // Demands (obligations only: CRITICAL/REQUIRED), keyed '<stableKey>#g<generation>'.
    const demandList = [];
    const rawDemands = Array.isArray(input.demands) ? input.demands : input.demands && typeof input.demands === 'object' ? Object.keys(input.demands).map(function (k) { return input.demands[k]; }) : [];
    for (let i = 0; i < rawDemands.length; i++) demandList.push(rawDemands[i]);
    demandList.sort(function (a, b) { return cmp(a.stableKey, b.stableKey); });
    // A generation already covered by a live/spawning executor (its envelope) is not owed again.
    const coveredGeneration = {};
    for (const name in snapshot.ownCreeps) {
        const env = snapshot.ownCreeps[name].strategyEnvelope;
        if (!env || !isOperationKey(env.operationKey)) continue;
        const parts = parseOperationKey(env.operationKey);
        if (coveredGeneration[parts.demandStableKey] === undefined || coveredGeneration[parts.demandStableKey] < parts.generation) coveredGeneration[parts.demandStableKey] = parts.generation;
    }
    for (let i = 0; i < demandList.length; i++) {
        const d = demandList[i];
        if (d.roomName !== roomName || d.criticality === E.Criticality.OPTIONAL || d.options.length === 0) continue;
        if (coveredGeneration[d.stableKey] !== undefined && d.generation <= coveredGeneration[d.stableKey]) continue;
        const o = d.options[0];
        if (o.cost === 0) continue;
        let tick = null;
        let latest = null;
        if (d.requiredBy === null) tick = fromTick;
        else if (o.travelTime.value !== null) {
            latest = d.requiredBy - o.travelTime.value - o.spawnTime;
            tick = Math.max(fromTick, latest, d.earliestStart === null ? 0 : d.earliestStart);
        }
        if (tick !== null && tick > end) continue;
        putPayment({
            stableKey: d.stableKey + '#g' + d.generation, tick: tick, amount: o.cost, quality: tick === null ? E.Quality.UNKNOWN : worse(E.Quality.ESTIMATED, o.travelTime.quality),
            reason: tick === null ? 'MISSING_FIELD' : null, pool: o.body.length > 0, slotKey: d.stableKey, fn: Replacement.functionOf(d.capability), latest: latest,
            fallbackTick: d.requiredBy === null ? fromTick : Math.max(fromTick, Math.min(end, d.requiredBy)), sources: ['demand'],
        });
    }

    // Reservations: an open SPEND promise is the funding of a payment, never a second payment.
    const resList = Ledger.toReservationList(input.reservations || []);
    const settledByKey = {};
    for (let i = 0; i < resList.length; i++) {
        const r = resList[i];
        if (r.roomName !== roomName || r.kind !== E.ReservationKind.SPEND || r.resourceType !== Ledger.ENERGY) continue;
        const key = Ledger.paymentKeyOfReservation(r);
        settledByKey[key] = (settledByKey[key] || 0) + r.settledAmount;
        if (E.RESERVATION_TRANSITIONS[r.state].length === 0) continue; // terminal: SETTLED/RELEASED/RETIRED hold nothing in the future
        const open = Ledger.outstandingAmount(r) + r.unknownAmount;
        if (open <= 0) continue;
        const tick = r.dueAt === null ? fromTick : Math.max(fromTick, r.dueAt);
        if (tick > end) continue;
        if (payments[key]) {
            // The obligation already exists (demand/replacement): the reservation funds it.
            if (payments[key].sources.indexOf('reservation') === -1) payments[key].sources = payments[key].sources.concat(['reservation']).sort();
            continue;
        }
        putPayment({
            stableKey: key, tick: tick, amount: open, quality: r.unknownAmount > 0 ? E.Quality.ESTIMATED : E.Quality.DERIVED,
            reason: r.unknownAmount > 0 ? 'UNCERTAIN_FUNDING' : null, pool: r.nodeId.indexOf('spawnPool:') === 0,
            slotKey: r.operationKey && isOperationKey(r.operationKey) ? parseOperationKey(r.operationKey).demandStableKey : null, fn: null, latest: null,
            fallbackTick: tick, sources: ['reservation'], reservationOpen: open,
        });
    }
    // Part of an obligation already settled left the snapshot: only the rest is still to pay.
    const keys = Object.keys(payments).sort();
    const paymentList = [];
    for (let i = 0; i < keys.length; i++) {
        const p = payments[keys[i]];
        if (p.reservationOpen === undefined && settledByKey[p.stableKey] && p.amount !== null) {
            p.amount = Math.max(0, p.amount - settledByKey[p.stableKey]);
        }
        if (p.amount === 0) continue;
        paymentList.push(p);
    }

    const room = snapshot.rooms[roomName];
    return READY({
        roomName: roomName, fromTick: fromTick, horizon: horizon, end: end, constants: constants,
        streams: streams, payments: paymentList, deadlines: deadlines.sort(function (a, b) { return a.tick - b.tick || cmp(a.stableKey, b.stableKey); }),
        providers: { harvest: providers.harvest.sort(), feed: providers.feed.sort() },
        capacity: room.energyCapacityAvailable, plan: plan, reasons: reasons,
        travelEstimates: input.travelEstimates || null,
        emergencyTemplates: input.emergencyTemplates || DEFAULT_EMERGENCY_TEMPLATES,
    }, fingerprint({ s: snapshot.fingerprint, f: input.flowWindows || null, r: input.reservations || null, d: input.demands || null, b: input.observedBindings || null, h: horizon, i: input.incomeStreams || null, a: input.analyticIncomePerTick === undefined ? null : input.analyticIncomePerTick, k: input.knownFailure === true, t: input.travelEstimates || null, e: input.emergencyTemplates || null, room: roomName }));
}

// ---------------------------------------------------------------- scenarios

/**
 * A scenario: stream segments + payments.
 * @returns {{name:string, failTick:number|null, remoteOff:boolean, streams:Array, payments:Array, unknown:string|null, notes:string[]}}
 */
function baseScenario(model) {
    const streams = [];
    for (let i = 0; i < model.streams.length; i++) {
        const s = model.streams[i];
        streams.push({ stableKey: s.stableKey, remote: s.remote, functions: s.functions, segments: [{ from: model.fromTick, rate: s.rate.value, quality: s.rate.quality, reason: s.rate.reason }] });
    }
    const payments = [];
    for (let i = 0; i < model.payments.length; i++) payments.push(Object.assign({}, model.payments[i]));
    return { name: 'normal', failTick: null, remoteOff: false, streams: streams, payments: payments, unknown: null };
}

/** Segment of a stream active at tick t (null before the first). */
function segmentAt(stream, t) {
    let found = null;
    for (let i = 0; i < stream.segments.length; i++) if (stream.segments[i].from <= t) found = stream.segments[i];
    return found;
}

/** Set a stream's rate to `rate` on [from, to) (to null = until the end); later segments are kept. */
function overrideSegment(stream, from, to, rate, quality, reason) {
    const restore = to === null ? null : segmentAt(stream, to);
    const out = [];
    let startsAtTo = false;
    for (let i = 0; i < stream.segments.length; i++) {
        const seg = stream.segments[i];
        if (seg.from < from) out.push(seg);
        else if (to !== null && seg.from >= to) { out.push(seg); if (seg.from === to) startsAtTo = true; }
    }
    out.push({ from: from, rate: rate, quality: quality, reason: reason });
    if (to !== null && !startsAtTo && restore !== null) out.push({ from: to, rate: restore.rate, quality: restore.quality, reason: restore.reason });
    out.sort(function (a, b) { return a.from - b.from; });
    stream.segments = out;
}

function templateFor(model, fn) {
    const t = model.emergencyTemplates[fn] || DEFAULT_EMERGENCY_TEMPLATES[fn];
    const body = t.body.slice();
    const cost = Replacement.bodyCost(body, model.constants);
    const spawnTime = Replacement.spawnTimeOf(body, model.constants);
    const est = model.travelEstimates || {};
    const travel = est['emergency:' + fn] || est[fn] || unknownMeasure('MISSING_FIELD');
    return { fn: fn, body: body, cost: cost, spawnTime: spawnTime, travel: travel, incomeRate: t.incomeRate === undefined ? null : t.incomeRate, lifetime: Replacement.lifetimeOf(body, model.constants) };
}

/**
 * Apply the loss of every current provider of `fns` at tick `s`.
 * @param {object} model
 * @param {string[]} fns subset of ['harvest','feed']
 * @param {number} s failure tick
 */
function lossScenario(model, fns, s) {
    const sc = baseScenario(model);
    sc.name = 'loss:' + fns.join('+');
    sc.failTick = s;
    const affected = {};
    for (let i = 0; i < fns.length; i++) for (let j = 0; j < model.providers[fns[i]].length; j++) affected[model.providers[fns[i]][j]] = true;
    // The lost executors' own replacements (payments from s on) are replaced by the emergency chain.
    sc.payments = sc.payments.filter(function (p) {
        if (!p.slotKey || !affected[p.slotKey]) return true;
        return p.tick !== null && p.tick < s;
    });
    let recovery = s;
    let recoveryKnown = true;
    for (let i = 0; i < fns.length; i++) {
        const t = templateFor(model, fns[i]);
        if (t.cost === null) return Object.assign(sc, { unknown: 'MISSING_FIELD' });
        const key = model.roomName + '/emergency/' + fns[i] + '@' + s;
        sc.payments.push({ stableKey: key, tick: s, amount: t.cost, quality: E.Quality.ESTIMATED, reason: null, pool: true, slotKey: key, fn: fns[i], latest: s, sources: ['emergency'] });
        if (t.travel.value === null) { recoveryKnown = false; continue; }
        const born = s + t.spawnTime;
        recovery = Math.max(recovery, born + t.travel.value);
        // Its own replacement inside the horizon (one more generation at most).
        const nextStart = born + t.lifetime - t.travel.value - t.spawnTime - Replacement.REPLACEMENT_MARGIN;
        if (nextStart <= model.end) sc.payments.push({ stableKey: key + '#g2', tick: Math.max(model.fromTick, nextStart), amount: t.cost, quality: E.Quality.ESTIMATED, reason: null, pool: true, slotKey: key, fn: fns[i], latest: born + t.lifetime - t.travel.value - t.spawnTime, sources: ['emergency'] });
    }
    for (let i = 0; i < sc.streams.length; i++) {
        const st = sc.streams[i];
        let hit = false;
        for (let j = 0; j < fns.length; j++) if (st.functions.indexOf(fns[j]) !== -1) hit = true;
        if (!hit) continue;
        const original = st.segments[0];
        if (!recoveryKnown) {
            if (original.rate === null || original.rate > 0) return Object.assign(sc, { unknown: 'MISSING_FIELD' });
            continue;
        }
        let resume = original.rate;
        for (let j = 0; j < fns.length; j++) {
            const t = templateFor(model, fns[j]);
            if (t.incomeRate !== null && resume !== null) resume = Math.min(resume, t.incomeRate);
        }
        overrideSegment(st, s, null, 0, E.Quality.DERIVED, null);
        if (recovery < model.end) st.segments.push({ from: recovery, rate: resume, quality: worse(E.Quality.ESTIMATED, original.quality), reason: original.reason });
        st.segments.sort(function (a, b) { return a.from - b.from; });
    }
    return sc;
}

/** Copy of a scenario with every remote stream at 0 during the first 300 ticks. */
function remoteOff(model, scenario) {
    const sc = { name: scenario.name, failTick: scenario.failTick, remoteOff: true, payments: scenario.payments, unknown: scenario.unknown, streams: [] };
    const to = model.fromTick + REMOTE_OFF_TICKS;
    for (let i = 0; i < scenario.streams.length; i++) {
        const st = scenario.streams[i];
        const copy = { stableKey: st.stableKey, remote: st.remote, functions: st.functions, segments: st.segments.slice() };
        if (st.remote) overrideSegment(copy, model.fromTick, Math.min(to, model.end), 0, E.Quality.DERIVED, null);
        sc.streams.push(copy);
    }
    return sc;
}

/** Income accumulated on [fromTick, t). @returns {number|null} */
function incomeUntil(scenario, fromTick, t) {
    let total = 0;
    for (let i = 0; i < scenario.streams.length; i++) {
        const segs = scenario.streams[i].segments;
        for (let j = 0; j < segs.length; j++) {
            const a = Math.max(segs[j].from, fromTick);
            const b = Math.min(j + 1 < segs.length ? segs[j + 1].from : Infinity, t);
            if (b <= a) continue;
            if (segs[j].rate === null) return null;
            total += segs[j].rate * (b - a);
        }
    }
    return total;
}

function unknownReasonOf(model, scenario) {
    if (scenario.unknown) return scenario.unknown;
    for (let i = 0; i < scenario.payments.length; i++) {
        const p = scenario.payments[i];
        if (p.tick === null || p.amount === null) return 'MISSING_FIELD';
    }
    for (let i = 0; i < scenario.streams.length; i++) {
        const segs = scenario.streams[i].segments;
        for (let j = 0; j < segs.length; j++) {
            const next = j + 1 < segs.length ? segs[j + 1].from : Infinity;
            if (segs[j].rate === null && next > segs[j].from && segs[j].from < model.end) return segs[j].reason || 'NO_HISTORY';
        }
    }
    return null;
}

/**
 * Deficit of a scenario: ceil(max prefix (payments − income)), >= 0.
 * @returns {{deficit:number|null, reason:string|null, peakTick:number|null}}
 */
function scenarioDeficit(model, scenario) {
    const unknownReason = unknownReasonOf(model, scenario);
    if (unknownReason) return { deficit: null, reason: unknownReason, peakTick: null };
    const pays = scenario.payments.slice().sort(function (a, b) { return a.tick - b.tick || cmp(a.stableKey, b.stableKey); });
    let paid = 0;
    let peak = 0;
    let peakTick = null;
    for (let i = 0; i < pays.length; i++) {
        paid += pays[i].amount;
        if (i + 1 < pays.length && pays[i + 1].tick === pays[i].tick) continue;
        const prefix = paid - incomeUntil(scenario, model.fromTick, pays[i].tick);
        if (prefix > peak + 1e-9) { peak = prefix; peakTick = pays[i].tick; }
    }
    return { deficit: Math.max(0, Math.ceil(peak - 1e-9)), reason: null, peakTick: peakTick };
}

function nearestDeadline(model, fns) {
    let best = null;
    for (let i = 0; i < model.deadlines.length; i++) {
        const d = model.deadlines[i];
        if (fns.indexOf(d.fn) === -1) continue;
        if (best === null || d.tick < best) best = d.tick;
    }
    return best;
}

/** All base scenarios of DESIGN §5 for the model. */
function baseScenarios(model) {
    const out = [baseScenario(model)];
    const sets = [['harvest'], ['feed'], ['feed', 'harvest']];
    for (let i = 0; i < sets.length; i++) {
        const fns = sets[i];
        let all = true;
        for (let j = 0; j < fns.length; j++) if (model.providers[fns[j]].length === 0) all = false;
        if (!all) continue; // nothing (or not both) to lose: the scenario is already covered by a smaller one
        const ticks = [model.fromTick];
        const next = nearestDeadline(model, fns);
        if (next !== null && next > model.fromTick && next <= model.end) ticks.push(next);
        for (let k = 0; k < ticks.length; k++) out.push(lossScenario(model, fns, ticks[k]));
    }
    return out;
}

/**
 * Lower and target reserve of a room (DESIGN §5).
 * @param {object} input same as buildModel
 * @returns {object} READY({lower, target, scenarios, capacityViolations}) | UNKNOWN(reason) | REJECTED
 */
function computeReserves(input) {
    const m = buildModel(input);
    if (m.kind !== 'READY') return m;
    return reservesOfModel(m.value, m.inputFingerprint);
}

function reservesOfModel(model, inputFp) {
    const scenarios = baseScenarios(model);
    const rows = [];
    let lower = 0;
    let target = 0;
    const missing = [];
    for (let i = 0; i < scenarios.length; i++) {
        const variants = [scenarios[i], remoteOff(model, scenarios[i])];
        for (let v = 0; v < variants.length; v++) {
            const sc = variants[v];
            const d = scenarioDeficit(model, sc);
            rows.push({ name: sc.name, failTick: sc.failTick, remoteOff: sc.remoteOff, deficit: d.deficit, peakTick: d.peakTick, reasonCode: d.reason });
            if (d.deficit === null) { addReason(missing, d.reason); continue; }
            if (!sc.remoteOff) lower = Math.max(lower, d.deficit);
            target = Math.max(target, d.deficit);
        }
    }
    if (missing.length > 0) return UNKNOWN(missing[0], ['reserve:' + missing.join(',')]);
    target = Math.max(target, lower);
    const violations = [];
    for (let i = 0; i < model.payments.length; i++) {
        const p = model.payments[i];
        if (p.pool && p.amount !== null && model.capacity.value !== null && p.amount > model.capacity.value) violations.push(p.stableKey);
    }
    return READY({ roomName: model.roomName, fromTick: model.fromTick, horizon: model.horizon, lower: lower, target: target, scenarios: rows, capacityViolations: violations }, inputFp);
}

// ---------------------------------------------------------------- calendar DTO

function renderCalendar(model, scenario) {
    const entries = [];
    const reasons = model.reasons.slice();
    let quality = E.Quality.DERIVED;
    for (let i = 0; i < scenario.streams.length; i++) {
        const st = scenario.streams[i];
        for (let j = 0; j < st.segments.length; j++) {
            const seg = st.segments[j];
            if (seg.from > model.end) continue;
            const amount = seg.rate === null ? unknownMeasure(seg.reason || 'NO_HISTORY') : measured(seg.rate, seg.quality === E.Quality.UNKNOWN ? E.Quality.ESTIMATED : seg.quality);
            if (seg.rate === null) { quality = E.Quality.UNKNOWN; addReason(reasons, seg.reason || 'NO_HISTORY'); } else quality = worse(quality, amount.quality);
            entries.push({ tick: Math.max(model.fromTick, seg.from), roomName: model.roomName, kind: E.CalendarEntryKind.INCOME, amount: amount, stableKey: st.stableKey, reasonCode: seg.rate === null ? seg.reason || 'NO_HISTORY' : seg.reason || null });
        }
    }
    for (let i = 0; i < scenario.payments.length; i++) {
        const p = scenario.payments[i];
        let reason = p.reason || null;
        if (p.tick === null) reason = 'MISSING_FIELD';
        else if (p.pool && p.amount !== null && model.capacity.value !== null && p.amount > model.capacity.value) reason = 'INSUFFICIENT_LIQUIDITY';
        const amount = p.amount === null ? unknownMeasure('MISSING_FIELD') : measured(p.amount, p.quality === E.Quality.UNKNOWN ? E.Quality.ESTIMATED : p.quality);
        if (p.tick === null || p.amount === null) quality = E.Quality.UNKNOWN; else quality = worse(quality, amount.quality);
        addReason(reasons, reason);
        entries.push({ tick: p.tick === null ? p.fallbackTick : p.tick, roomName: model.roomName, kind: E.CalendarEntryKind.PAYMENT, amount: amount, stableKey: p.stableKey, reasonCode: reason });
    }
    for (let i = 0; i < model.deadlines.length; i++) {
        const d = model.deadlines[i];
        entries.push({ tick: d.tick, roomName: model.roomName, kind: E.CalendarEntryKind.DEADLINE, amount: d.amount === null ? unknownMeasure('MISSING_FIELD') : measured(d.amount, E.Quality.ESTIMATED), stableKey: 'deadline:' + d.stableKey, reasonCode: null });
    }
    entries.sort(function (a, b) { return a.tick - b.tick || cmp(a.kind, b.kind) || cmp(a.stableKey, b.stableKey); });
    // (tick, kind, stableKey) unique: keep the last for identical keys (cannot happen for payments, which are unique by key)
    const unique = [];
    for (let i = 0; i < entries.length; i++) {
        const prev = unique[unique.length - 1];
        if (prev && prev.tick === entries[i].tick && prev.kind === entries[i].kind && prev.stableKey === entries[i].stableKey) unique[unique.length - 1] = entries[i];
        else unique.push(entries[i]);
    }
    const calendar = { roomName: model.roomName, fromTick: model.fromTick, horizon: model.horizon, entries: unique, quality: quality, reasonCodes: sortedReasons(reasons) };
    return calendar;
}

/**
 * Contract A.2 §10: calendar of the normal scenario.
 * @param {object} input see buildModel (contract fields: snapshot, flowWindows, reservations, demands, horizon)
 * @returns {object} READY(Calendar) | UNKNOWN | REJECTED
 */
function buildCalendar(input) {
    const m = buildModel(input);
    if (m.kind !== 'READY') return m;
    const calendar = renderCalendar(m.value, baseScenario(m.value));
    const v = validateCalendar(calendar);
    if (!v.ok) return REJECTED('INVALID_RECORD', { what: 'calendar', errors: v.errors });
    return READY(calendar, m.inputFingerprint);
}

/**
 * Calendars of every scenario (normal, losses, remote-off variants), for review/replay.
 * @returns {object} READY(Array<{name, failTick, remoteOff, calendar}>)
 */
function buildScenarioCalendars(input) {
    const m = buildModel(input);
    if (m.kind !== 'READY') return m;
    const out = [];
    const scenarios = baseScenarios(m.value);
    for (let i = 0; i < scenarios.length; i++) {
        const variants = [scenarios[i], remoteOff(m.value, scenarios[i])];
        for (let v = 0; v < variants.length; v++) out.push({ name: variants[v].name, failTick: variants[v].failTick, remoteOff: variants[v].remoteOff, calendar: renderCalendar(m.value, variants[v]) });
    }
    return READY(out, m.inputFingerprint);
}

/**
 * Check the normal schedule against a starting liquid stock. When a payment
 * cannot be funded on its date it is delayed to the first funded tick; at most
 * ONE such rebuild is made. Still infeasible (or the delay misses its latest
 * start) => UNKNOWN(CRITICAL_DEADLINE): optional missions must not start.
 *
 * @param {object} input see buildModel
 * @param {number} stock liquid energy available now
 * @returns {object} READY({feasible:true, rebuilds, delayed}) | UNKNOWN
 */
function checkSchedule(input, stock) {
    const m = buildModel(input);
    if (m.kind !== 'READY') return m;
    const model = m.value;
    const sc = baseScenario(model);
    const unknownReason = unknownReasonOf(model, sc);
    if (unknownReason) return UNKNOWN(unknownReason, ['schedule']);
    let delayed = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        const pays = sc.payments.slice().sort(function (a, b) { return a.tick - b.tick || cmp(a.stableKey, b.stableKey); });
        let paid = 0;
        let failure = null;
        for (let i = 0; i < pays.length; i++) {
            const balance = stock + incomeUntil(sc, model.fromTick, pays[i].tick) - paid;
            if (balance + 1e-9 < pays[i].amount) { failure = { index: i, payment: pays[i], paidBefore: paid }; break; }
            paid += pays[i].amount;
        }
        if (failure === null) return READY({ feasible: true, rebuilds: attempt, delayed: delayed }, m.inputFingerprint);
        if (attempt === 1) break;
        // one rebuild: delay the failing payment to the first tick where it is funded
        const p = failure.payment;
        let t = null;
        for (let tick = p.tick + 1; tick <= model.end; tick++) {
            if (stock + incomeUntil(sc, model.fromTick, tick) - failure.paidBefore + 1e-9 >= p.amount) { t = tick; break; }
        }
        if (t === null || p.latest === null || t > p.latest) return UNKNOWN('CRITICAL_DEADLINE', ['schedule:' + p.stableKey]);
        for (let i = 0; i < sc.payments.length; i++) if (sc.payments[i].stableKey === p.stableKey) sc.payments[i] = Object.assign({}, sc.payments[i], { tick: t });
        delayed = [{ stableKey: p.stableKey, from: p.tick, to: t }];
    }
    return UNKNOWN('CRITICAL_DEADLINE', ['schedule:rebuild']);
}

module.exports = {
    COMMITMENT_HORIZON,
    REMOTE_OFF_TICKS,
    DEFAULT_EMERGENCY_TEMPLATES,
    buildModel,
    buildCalendar,
    buildScenarioCalendars,
    computeReserves,
    reservesOfModel,
    scenarioDeficit,
    baseScenario,
    checkSchedule,
};
