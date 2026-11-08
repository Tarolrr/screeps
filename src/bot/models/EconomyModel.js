// EconomyModel (A4): income lower bound, room-mode inputs, 50/50 quotas and
// the persisted ForecastSummary (DESIGN §3, §4, §5, §12). Pure; stage A
// computes shadow values only.
//
// Income lower bound of the existing local flow (DESIGN §3):
//   - known failure of the flow          -> 0 (DERIVED);
//   - three last complete 100-tick windows with unchanged topologyVersion and
//     known harvest/externalIn            -> min of their income / 100 (DERIVED);
//   - otherwise, analytic limiter given   -> 0.8 × analytic (ESTIMATED, NO_HISTORY);
//   - otherwise                           -> UNKNOWN(NO_HISTORY), never 0.
// Income = harvest + externalIn. internalTransfer (transfer/withdraw/pickup/drop
// between own nodes) is never income.

'use strict';

const E = require('../domain/enums');
const { measured, unknownMeasure, validateForecastSummary, FLOW_WINDOW_TICKS } = require('../domain/dtos');
const { READY, UNKNOWN, REJECTED } = require('../domain/results');
const { fingerprint } = require('../domain/fingerprint');
const { validateStatePatch } = require('../domain/stateLayout');
const Ledger = require('../scheduling/BudgetLedger');
const Replacement = require('./ReplacementForecast');
const { isOperationKey, parseOperationKey } = require('../domain/keys');

/** DESIGN §3/§12 initial settings. */
const HISTORY_WINDOWS = 3;
const NO_HISTORY_FACTOR = 0.8;
const QUOTA_PERIOD = 25;
const INCOME_FIELDS = Object.freeze(['harvest', 'externalIn']);

/** @param {object} w FlowWindow @returns {number|null} income of the window */
function windowIncome(w) {
    if (w.quality === E.Quality.UNKNOWN) return null;
    let total = 0;
    for (let i = 0; i < INCOME_FIELDS.length; i++) {
        const m = w.flows[INCOME_FIELDS[i]];
        if (!m || m.value === null) return null;
        total += m.value;
    }
    return total;
}

/**
 * Lower bound of the existing local income flow.
 *
 * History counts only when the three windows are consecutive, complete, have
 * known income and end at the last closed window (floor(currentTick/100)×100,
 * or the newest window supplied when currentTick is absent). Equal non-null
 * topologyVersion is proof of unchanged topology; null is unproven: then the
 * 0.8 analytic fallback is used when available, otherwise the window minimum
 * with quality ESTIMATED and reason NO_HISTORY.
 *
 * @param {object[]} flowWindows FlowWindow[] of one room (any order)
 * @param {{analyticIncomePerTick?:number|null, knownFailure?:boolean, currentTick?:number}} [options]
 * @returns {{rate:object, reasonCode:string|null, windows:number[]}} rate = Measured energy/tick
 */
function incomeLowerBound(flowWindows, options) {
    const opts = options || {};
    if (opts.knownFailure === true) return { rate: measured(0, E.Quality.DERIVED), reasonCode: null, windows: [] };
    const hasAnalytic = typeof opts.analyticIncomePerTick === 'number' && isFinite(opts.analyticIncomePerTick) && opts.analyticIncomePerTick >= 0;
    const analytic = function () { return { rate: measured(NO_HISTORY_FACTOR * opts.analyticIncomePerTick, E.Quality.ESTIMATED), reasonCode: 'NO_HISTORY', windows: [] }; };
    let lastEnd = null;
    if (typeof opts.currentTick === 'number') lastEnd = Math.floor(opts.currentTick / FLOW_WINDOW_TICKS) * FLOW_WINDOW_TICKS;
    else for (let i = 0; i < flowWindows.length; i++) if (lastEnd === null || flowWindows[i].windowEnd > lastEnd) lastEnd = flowWindows[i].windowEnd;
    const byStart = {};
    for (let i = 0; i < flowWindows.length; i++) byStart[flowWindows[i].windowStart] = flowWindows[i];
    const last = [];
    if (lastEnd !== null) {
        for (let k = 1; k <= HISTORY_WINDOWS; k++) {
            const w = byStart[lastEnd - k * FLOW_WINDOW_TICKS];
            if (!w || !w.complete || windowIncome(w) === null) break;
            last.push(w);
        }
    }
    if (last.length === HISTORY_WINDOWS) {
        let min = Infinity;
        let same = true;
        let proven = true;
        for (let i = 0; i < last.length; i++) {
            min = Math.min(min, windowIncome(last[i]));
            if (last[i].topologyVersion === null) proven = false;
            else if (last[i].topologyVersion !== last[0].topologyVersion) same = false;
        }
        const starts = last.map(function (w) { return w.windowStart; });
        if (same && proven) return { rate: measured(min / FLOW_WINDOW_TICKS, E.Quality.DERIVED), reasonCode: null, windows: starts };
        if (same && !proven) {
            if (hasAnalytic) return analytic();
            return { rate: measured(min / FLOW_WINDOW_TICKS, E.Quality.ESTIMATED), reasonCode: 'NO_HISTORY', windows: starts };
        }
    }
    if (hasAnalytic) return analytic();
    return { rate: unknownMeasure('NO_HISTORY'), reasonCode: 'NO_HISTORY', windows: [] };
}

/**
 * Analytic limiter of the local harvest flow from the snapshot: min(source
 * regeneration, 2 × active WORK of harvest-role creeps of the room). The
 * delivery limiter is not modelled in stage A (caller may pass a lower value).
 * @param {object} snapshot
 * @param {string} roomName
 * @param {object} [observedBindings]
 * @returns {object} Measured energy/tick (UNKNOWN when a source capacity is unknown)
 */
function analyticIncome(snapshot, roomName, observedBindings) {
    const room = snapshot.rooms[roomName];
    if (!room || room.visibility !== E.Visibility.VISIBLE) return unknownMeasure('NO_VISIBILITY');
    let regen = 0;
    for (let i = 0; i < room.sources.length; i++) {
        const cap = room.sources[i].energyCapacity;
        if (cap.value === null) return unknownMeasure(cap.reason || 'MISSING_FIELD');
        regen += cap.value / 300;
    }
    let work = 0;
    const bindings = observedBindings || {};
    for (const name in snapshot.ownCreeps) {
        const c = snapshot.ownCreeps[name];
        const b = bindings[name];
        const home = c.strategyEnvelope ? c.strategyEnvelope.homeRoom : b && b.homeRoom ? b.homeRoom : c.roomName;
        const role = c.legacyRole || (b && b.legacyRole) || null;
        if (home !== roomName || c.spawning || (role !== 'harvester' && role !== 'miner')) continue;
        for (let i = 0; i < c.body.length; i++) if (c.body[i].type === 'work' && c.body[i].hits > 0) work++;
    }
    return measured(Math.min(regen, 2 * work), E.Quality.ESTIMATED);
}

/**
 * Inputs of the room mode (DESIGN §4) that the finance model can supply.
 * SIEGE/ALERT (threat) are stage B and not computed here.
 * @param {{snapshot:object, roomName:string, observedBindings?:object, liquidObserved:object,
 *          lowerReserve:number|null, replacementPlan?:object, forecastQuality:string,
 *          unexplained?:boolean}} input
 * @returns {{mode:string, recover:boolean, stabilize:boolean, reasons:string[]}}
 */
function modeSignals(input) {
    const room = input.snapshot.rooms[input.roomName];
    const reasons = [];
    const bindings = input.observedBindings || {};
    let harvest = false;
    let feed = false;
    for (const name in input.snapshot.ownCreeps) {
        const c = input.snapshot.ownCreeps[name];
        const b = bindings[name];
        const home = c.strategyEnvelope ? c.strategyEnvelope.homeRoom : b && b.homeRoom ? b.homeRoom : c.roomName;
        if (home !== input.roomName) continue;
        // Function from the demand of the creation envelope or the legacy role, not from raw body parts.
        const fn = c.strategyEnvelope && isOperationKey(c.strategyEnvelope.operationKey)
            ? Replacement.functionOf(parseOperationKey(c.strategyEnvelope.operationKey).demandStableKey)
            : Replacement.functionOf(c.legacyRole || (b && b.legacyRole) || null);
        if (fn === 'harvest') harvest = true;
        else if (fn === 'feed') feed = true;
    }
    const noSpawn = !room || room.spawns.length === 0;
    if (noSpawn) reasons.push('NO_SPAWN');
    if (!harvest) reasons.push('NO_HARVEST_CHAIN');
    if (!feed) reasons.push('NO_FEED_CHAIN');
    const recover = noSpawn || !harvest || !feed;
    let stabilize = false;
    if (input.forecastQuality === E.Quality.UNKNOWN) { stabilize = true; reasons.push('FORECAST_UNKNOWN'); }
    if (input.unexplained === true) { stabilize = true; reasons.push('UNEXPLAINED_BALANCE'); }
    if (input.lowerReserve === null || input.liquidObserved.value === null) { stabilize = true; reasons.push('RESERVE_UNKNOWN'); } else if (input.liquidObserved.value < input.lowerReserve) { stabilize = true; reasons.push('BELOW_LOWER_RESERVE'); }
    if (input.replacementPlan) {
        for (let i = 0; i < input.replacementPlan.entries.length; i++) {
            const e = input.replacementPlan.entries[i];
            if (e.criticality === E.Criticality.CRITICAL && e.reasonCode === 'CRITICAL_DEADLINE') { stabilize = true; reasons.push('CRITICAL_REPLACEMENT_LATE'); break; }
        }
    }
    return { mode: recover ? 'RECOVER' : stabilize ? 'STABILIZE' : 'GROW', recover: recover, stabilize: stabilize, reasons: reasons };
}

/**
 * Split one period's confirmed free inflow between the reserve and the
 * milestone/project account (DESIGN §5): below lower -> all to reserve; between
 * lower and target -> 50/50, odd unit to reserve; at/above target -> all to
 * the milestone. Integer accounts; nothing is created or duplicated.
 * @param {{reserve:number, milestone:number}} accounts
 * @param {number} freeInflow confirmed free inflow of the period (>= 0; floored)
 * @param {{reserveLevel:number|null, lower:number, target:number}} reserve current reserve and thresholds
 * @returns {{reserve:number, milestone:number, toReserve:number, toMilestone:number}}
 */
function allocateQuota(accounts, freeInflow, reserve) {
    const x = Math.max(0, Math.floor(freeInflow));
    let toReserve;
    if (reserve.reserveLevel === null || reserve.reserveLevel < reserve.lower) toReserve = x;
    else if (reserve.reserveLevel < reserve.target) toReserve = Math.min(x - Math.floor(x / 2), reserve.target - reserve.reserveLevel);
    else toReserve = 0;
    const toMilestone = x - toReserve;
    return { reserve: accounts.reserve + toReserve, milestone: accounts.milestone + toMilestone, toReserve: toReserve, toMilestone: toMilestone };
}

/**
 * SAVING fund step (DESIGN §13 regression): accumulate `credit` up to the
 * target; deadline and target are never rewritten (JSON-safe, survives reset).
 * @param {{fundId:string, target:number, balance:number, deadline:number, status:string}} fund
 * @param {number} credit
 * @returns {object} new fund (status 'SAVING' | 'READY'); surplus returned as `overflow`
 */
function advanceFund(fund, credit) {
    const add = Math.max(0, Math.floor(credit));
    const room = Math.max(0, fund.target - fund.balance);
    const taken = Math.min(add, room);
    const balance = fund.balance + taken;
    return { fund: { fundId: fund.fundId, target: fund.target, balance: balance, deadline: fund.deadline, status: balance >= fund.target ? 'READY' : 'SAVING' }, overflow: add - taken };
}

function roomOf(snapshot, roomName) {
    if (roomName) return roomName;
    const names = Object.keys(snapshot.rooms);
    return names.length === 1 ? names[0] : null;
}

/**
 * Contract A.2 §10: ForecastSummary of one room.
 *   freeEnergyNow     = liquid observed − active reservations (each unit once);
 *   incomeLowerPerTick = flow lower bound of the room's flowWindows;
 *   committedPayments  = calendar payments not already held by a reservation
 *                        (held ones are inside freeEnergyNow: no double count);
 *   nextDeficitTick   = first payment tick where liquid observed + lower income
 *                        − all payments < 0.
 * @param {object} snapshot
 * @param {object} stateView StateView (shadow ledger, flowWindows, observedBindings; strategy.demands)
 * @param {number} horizon
 * @param {{roomName?:string, analyticIncomePerTick?:number, knownFailure?:boolean, travelEstimates?:object, incomeStreams?:Array}} [options]
 * @returns {object} READY(ForecastSummary) | UNKNOWN | REJECTED
 */
function evaluate(snapshot, stateView, horizon, options) {
    const Calendar = require('./ForecastCalendar'); // lazy: ForecastCalendar requires this module
    const opts = options || {};
    const roomName = roomOf(snapshot, opts.roomName);
    if (!roomName || !snapshot.rooms[roomName]) return UNKNOWN('MISSING_FIELD', ['roomName']);
    const shadow = stateView && stateView.shadow ? stateView.shadow : null;
    const shadowRoom = shadow && shadow.rooms[roomName] ? shadow.rooms[roomName] : null;
    const reservations = shadow ? shadow.ledger.reservations : {};
    const flowWindows = shadowRoom ? shadowRoom.flowWindows : [];
    const bindings = shadowRoom ? shadowRoom.observedBindings : {};
    const demands = stateView && stateView.strategy ? stateView.strategy.demands : {};
    const input = {
        snapshot: snapshot, roomName: roomName, flowWindows: flowWindows, reservations: reservations, demands: demands,
        observedBindings: bindings, horizon: horizon, analyticIncomePerTick: opts.analyticIncomePerTick, knownFailure: opts.knownFailure,
        travelEstimates: opts.travelEstimates, incomeStreams: opts.incomeStreams,
    };
    const cal = Calendar.buildCalendar(input);
    if (cal.kind !== 'READY') return cal;
    const calendar = cal.value;
    const view = Ledger.createLedgerView(snapshot, reservations, roomName);
    const liquid = Ledger.liquidity(snapshot, view);
    const income = incomeLowerBound(flowWindows, { analyticIncomePerTick: opts.analyticIncomePerTick, knownFailure: opts.knownFailure, currentTick: snapshot.tick });
    const incomeRate = opts.incomeStreams ? sumStreams(opts.incomeStreams) : income.rate;

    const reasons = calendar.reasonCodes.slice();
    const heldKeys = {};
    const list = Ledger.toReservationList(reservations);
    for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.roomName === roomName && r.kind === E.ReservationKind.SPEND && Ledger.outstandingAmount(r) + (E.RESERVATION_TRANSITIONS[r.state].length > 0 ? r.unknownAmount : 0) > 0) heldKeys[Ledger.paymentKeyOfReservation(r)] = (heldKeys[Ledger.paymentKeyOfReservation(r)] || 0) + Ledger.outstandingAmount(r) + r.unknownAmount;
    }
    let committed = 0;
    let committedUnknown = null;
    const pays = [];
    for (let i = 0; i < calendar.entries.length; i++) {
        const e = calendar.entries[i];
        if (e.kind !== E.CalendarEntryKind.PAYMENT) continue;
        if (e.amount.value === null || e.reasonCode === 'MISSING_FIELD') { committedUnknown = 'MISSING_FIELD'; continue; }
        pays.push(e);
        committed += Math.max(0, e.amount.value - (heldKeys[e.stableKey] || 0));
    }
    let nextDeficitTick = null;
    if (liquid.observed.value !== null && incomeRate.value !== null && committedUnknown === null) {
        let paid = 0;
        for (let i = 0; i < pays.length; i++) {
            paid += pays[i].amount.value;
            if (liquid.observed.value + incomeRate.value * (pays[i].tick - snapshot.tick) - paid < 0) { nextDeficitTick = pays[i].tick; break; }
        }
    }
    if (liquid.free.value === null) reasons.push(liquid.free.reason);
    if (committedUnknown) reasons.push(committedUnknown);
    if (incomeRate.value === null) reasons.push(incomeRate.reason);
    let quality = calendar.quality;
    if (liquid.free.value === null || incomeRate.value === null || committedUnknown) quality = E.Quality.UNKNOWN;
    const unique = [];
    for (let i = 0; i < reasons.length; i++) if (reasons[i] && unique.indexOf(reasons[i]) === -1) unique.push(reasons[i]);
    unique.sort();
    const summary = {
        roomName: roomName, computedAt: snapshot.tick, horizon: horizon,
        freeEnergyNow: liquid.free, incomeLowerPerTick: incomeRate,
        committedPayments: committedUnknown ? unknownMeasure(committedUnknown) : measured(committed, E.Quality.DERIVED),
        nextDeficitTick: nextDeficitTick, calendarFingerprint: fingerprint(calendar), quality: quality, reasonCodes: unique,
    };
    const v = validateForecastSummary(summary);
    if (!v.ok) return REJECTED('INVALID_RECORD', { what: 'ForecastSummary', errors: v.errors });
    return READY(summary, cal.inputFingerprint);
}

function sumStreams(streams) {
    let total = 0;
    for (let i = 0; i < streams.length; i++) {
        if (streams[i].ratePerTick.value === null) return streams[i].ratePerTick;
        total += streams[i].ratePerTick.value;
    }
    return measured(total, E.Quality.ESTIMATED);
}

/**
 * StatePatch (writer 'finance') for strategyShadow.rooms.<room>.forecast.
 * @param {object} summary ForecastSummary
 * @param {string} patchId
 */
function forecastPatch(summary, patchId) {
    const patch = { patchId: patchId, writer: E.StateWriter.FINANCE, namespace: 'strategyShadow', path: ['rooms', summary.roomName, 'forecast'], op: E.PatchOp.SET, value: summary };
    const v = validateStatePatch(patch);
    if (!v.ok) throw new TypeError('invalid forecast patch: ' + JSON.stringify(v.errors));
    return patch;
}

module.exports = {
    HISTORY_WINDOWS,
    NO_HISTORY_FACTOR,
    QUOTA_PERIOD,
    INCOME_FIELDS,
    windowIncome,
    incomeLowerBound,
    analyticIncome,
    modeSignals,
    allocateQuota,
    advanceFund,
    evaluate,
    forecastPatch,
};
