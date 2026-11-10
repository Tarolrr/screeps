// ShadowGovernor (STRAT-A5): RoomGovernor.propose(context, roomState) -> Proposal[]
// for stage A shadow mode (contract A.4 §10). Pure: values in, values out
// (domain only); it never executes anything, Proposal.missionPatches is always [].
//
// Inputs (roomState, prepared by the shadow pipeline from A3/A4 results):
//   {roomName, tick, room: RoomSnapshot, revision, lastClosedTick,
//    signals: EconomyModel.modeSignals(...)          (RECOVER/STABILIZE inputs, A4),
//    summary: Result<ForecastSummary>, reserves: Result<{lower, target}>,
//    replacement: Result<{plan, meta}>, liquidity: {observed, free},
//    travel: {key: Measured}, flowWindows: FlowWindow[], spawning: [{name, role}],
//    lastRecord: DecisionRecord|null, empire: {selfSufficientRooms}}
//
// Room mode (DESIGN §4, checked top-down, entry immediate):
//   SIEGE     armed hostile in the room (active ATTACK/RANGED_ATTACK/WORK/CLAIM, or
//             unknown body: unknown force counts as armed until inspected);
//   RECOVER   no spawn / no harvest or feed chain (A4 modeSignals);
//   ALERT     unarmed hostile CARRY within range 1 of open storage/container/pile;
//   STABILIZE lower reserve not covered, forecast/reserve UNKNOWN, unexplained
//             balance, late critical replacement (A4 modeSignals);
//   GROW      otherwise.
// Exit from SIEGE/ALERT: only after 100 consecutive visible ticks without a
// confirmed threat (the 100th clear tick is the fresh re-inspection). The count
// is per room and per evaluation: it restarts when a tick was not closed
// (lastClosedTick != T-1: lost tick, reset before CLOSE), when the room's observation
// has an event gap this tick (deferred reconcile, room absent from shadow and
// re-enabled, invisibility), and every interruption record (deferral/fault of any shadow
// stage) persists clearSince = null: absence of evidence never clears a threat. Hysteresis state {mode, since, hold: {mode, clearSince}} is carried by
// every DecisionRecord (inputs.gov), so it is derived from the persisted ring and
// survives a global reset.
//
// Maturity (DESIGN §4): BOOTSTRAP (no closed harvest+feed contour), BASIC
// (contour), BUFFERED (RCL>=4, storage, controlled balance), NETWORKED (BUFFERED and
// >= 2 self-sufficient shadow rooms).
//
// Mandatory needs: non-optional replacements whose start is due within
// LOOKAHEAD_TICKS (or late/unknown), and the missing harvest/feed chain (emergency
// template). Each need becomes one hypothetical Proposal (SPEND on spawnPool:<room>);
// admission is a separate, hypothetical step (ShadowAdapter, A4 BudgetLedger).

const { fingerprint } = require('../domain/fingerprint');
const { canonicalJson } = require('../domain/canonical');
const { ReasonCode, isReasonCode } = require('../domain/reasonCodes');
const E = require('../domain/enums');
const { spawnPoolNodeId } = require('../domain/keys');
const { unknownMeasure } = require('../domain/dtos');

/** DESIGN §4/§12: exit from SIEGE/ALERT after this many consecutive clear ticks. */
const EXIT_HOLD_TICKS = 100;
/** A replacement becomes a proposal this many ticks before its start. */
const LOOKAHEAD_TICKS = 150;
/** At most this many proposals per room and evaluation. */
const MAX_PROPOSALS = 6;
/** Policy identity of this governor (header.policyVersion of exported fixtures). */
const POLICY_VERSION = 'shadow-a5.1';

const Mode = Object.freeze({ SIEGE: 'SIEGE', RECOVER: 'RECOVER', ALERT: 'ALERT', STABILIZE: 'STABILIZE', GROW: 'GROW' });
const SEVERITY = Object.freeze({ GROW: 1, STABILIZE: 2, ALERT: 3, RECOVER: 4, SIEGE: 5 });
const Maturity = Object.freeze({ BOOTSTRAP: 'BOOTSTRAP', BASIC: 'BASIC', BUFFERED: 'BUFFERED', NETWORKED: 'NETWORKED' });

const ARMED_PARTS = Object.freeze({ attack: true, ranged_attack: true, work: true, claim: true });

/** Emergency templates (same bodies as ForecastCalendar.DEFAULT_EMERGENCY_TEMPLATES). */
const EMERGENCY = Object.freeze({
    harvest: Object.freeze({ body: Object.freeze(['work', 'carry', 'move']), cost: 200 }),
    feed: Object.freeze({ body: Object.freeze(['carry', 'carry', 'move']), cost: 150 }),
});

function maxMode(a, b) {
    if (!a) return b;
    if (!b) return a;
    return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Threat class of the room from the snapshot (DESIGN §4).
 * @returns {{threat: 'ARMED'|'THIEF'|'SCOUT'|'NONE'|'NOT_VISIBLE', armed: number, thieves: number, scouts: number}}
 */
function classifyThreat(room) {
    if (!room || room.visibility !== E.Visibility.VISIBLE) return { threat: 'NOT_VISIBLE', armed: 0, thieves: 0, scouts: 0 };
    let armed = 0;
    let thieves = 0;
    let scouts = 0;
    const open = room.energyNodes.filter(function (n) {
        return n.pos && (n.nodeClass === E.EnergyNodeClass.PILE || (n.nodeClass === E.EnergyNodeClass.STORAGE_CONTAINER && n.objectType !== 'tower'));
    });
    for (let i = 0; i < room.hostiles.length; i++) {
        const h = room.hostiles[i];
        let isArmed = h.body.length === 0; // unknown force: armed until inspected
        let carry = false;
        for (let p = 0; p < h.body.length; p++) {
            if (h.body[p].hits <= 0) continue;
            if (ARMED_PARTS[h.body[p].type]) isArmed = true;
            if (h.body[p].type === 'carry') carry = true;
        }
        if (isArmed) { armed++; continue; }
        let near = false;
        for (let n = 0; n < open.length && carry; n++) if (chebyshev(open[n].pos, h.pos) <= 1) near = true;
        if (carry && near) thieves++;
        else scouts++;
    }
    const threat = armed > 0 ? 'ARMED' : thieves > 0 ? 'THIEF' : scouts > 0 ? 'SCOUT' : 'NONE';
    return { threat: threat, armed: armed, thieves: thieves, scouts: scouts };
}

/**
 * Hysteresis state carried by the last record (or null).
 * @param {object|null} record DecisionRecord
 * @returns {{mode:string, since:number, hold:({mode:string, clearSince:(number|null)}|null)}|null}
 */
function govOf(record) {
    if (!record || !record.inputs || !record.inputs.gov) return null;
    const g = record.inputs.gov;
    if (!SEVERITY[g.mode] || typeof g.since !== 'number') return null;
    const hold = g.hold && SEVERITY[g.hold.mode] && (g.hold.clearSince === null || typeof g.hold.clearSince === 'number') ? { mode: g.hold.mode, clearSince: g.hold.clearSince } : null;
    return { mode: g.mode, since: g.since, hold: hold };
}

/**
 * Mode with exit hysteresis.
 * @param {{tick:number, lastClosedTick:(number|null), threat:object, signals:object, prev:(object|null)}} input
 * @returns {{mode:string, since:number, hold:(object|null), raw:string}}
 */
function decideMode(input) {
    const tick = input.tick;
    const prev = input.prev;
    // per room AND per evaluation: the previous tick was closed and this room's observation
    // is continuous (no event gap: deferred/lost tick, room absent from shadow, invisibility).
    // Interruptions in between are persisted by interruptionRecord (clearSince -> null).
    const continuous = input.lastClosedTick === tick - 1 && input.roomContinuous !== false;
    const visible = input.threat.threat !== 'NOT_VISIBLE';
    const threatMode = input.threat.threat === 'ARMED' ? Mode.SIEGE : input.threat.threat === 'THIEF' ? Mode.ALERT : null;
    let hold = prev ? prev.hold : null;
    if (threatMode !== null) {
        hold = { mode: maxMode(threatMode, hold ? hold.mode : null), clearSince: null };
    } else if (hold !== null) {
        if (!visible) {
            hold = { mode: hold.mode, clearSince: null };
        } else {
            const clearSince = hold.clearSince !== null && continuous ? hold.clearSince : tick;
            hold = tick - clearSince + 1 >= EXIT_HOLD_TICKS ? null : { mode: hold.mode, clearSince: clearSince };
        }
    }
    const s = input.signals;
    let econ = Mode.GROW;
    if (!s) econ = Mode.STABILIZE;
    else if (s.recover) econ = Mode.RECOVER;
    else if (s.stabilize) econ = Mode.STABILIZE;
    const raw = maxMode(threatMode, econ);
    const mode = maxMode(hold ? hold.mode : null, econ);
    const since = prev && prev.mode === mode ? prev.since : tick;
    return { mode: mode, since: since, hold: hold, raw: raw };
}

function lastCompleteWindow(windows) {
    let best = null;
    for (let i = 0; i < windows.length; i++) if (windows[i].complete && (best === null || windows[i].windowStart > best.windowStart)) best = windows[i];
    return best;
}

/**
 * @returns {{maturity:string, contour:boolean, rcl:(number|null), storage:boolean, towerFed:boolean, balanceControlled:boolean}}
 */
function decideMaturity(room, signals, windows, empire) {
    const reasons = signals ? signals.reasons : ['UNKNOWN'];
    const contour = !!signals && reasons.indexOf('NO_SPAWN') === -1 && reasons.indexOf('NO_HARVEST_CHAIN') === -1 && reasons.indexOf('NO_FEED_CHAIN') === -1;
    const rcl = room && room.controller && room.controller.my ? room.controller.level : null;
    let storage = false;
    let towerFed = false;
    const nodes = room ? room.energyNodes : [];
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].objectType === 'storage') storage = true;
        if (nodes[i].objectType === 'tower' && nodes[i].amount.value !== null && nodes[i].amount.value > 0) towerFed = true;
    }
    const w = lastCompleteWindow(windows || []);
    const balanceControlled = w !== null && w.quality !== E.Quality.UNKNOWN && w.flows.unexplained.value === 0;
    let maturity = Maturity.BOOTSTRAP;
    if (contour) maturity = Maturity.BASIC;
    if (contour && rcl !== null && rcl >= 4 && storage && balanceControlled) maturity = Maturity.BUFFERED;
    if (maturity === Maturity.BUFFERED && empire && empire.selfSufficientRooms >= 2) maturity = Maturity.NETWORKED;
    return { maturity: maturity, contour: contour, rcl: rcl, storage: storage, towerFed: towerFed, balanceControlled: balanceControlled };
}

function slotOf(stableKey) {
    const i = stableKey.lastIndexOf('#g');
    return i === -1 ? { slot: stableKey, generation: 0 } : { slot: stableKey.slice(0, i), generation: parseInt(stableKey.slice(i + 2), 10) || 0 };
}

function shortHash(value) {
    return fingerprint(value).slice(8, 20);
}

/**
 * Mandatory needs of the room: due replacements and the missing chain.
 * @returns {Array<object>} sorted by (start, key)
 */
function mandatoryNeeds(roomState) {
    const out = [];
    const tick = roomState.tick;
    const repl = roomState.replacement && roomState.replacement.kind === 'READY' ? roomState.replacement.value : null;
    if (repl) {
        for (let i = 0; i < repl.plan.entries.length; i++) {
            const e = repl.plan.entries[i];
            if (e.criticality === E.Criticality.OPTIONAL) continue;
            const meta = repl.meta[e.stableKey] || null;
            const late = e.reasonCode === ReasonCode.CRITICAL_DEADLINE;
            const unknown = e.startBy === null;
            if (!late && !unknown && e.startBy > tick + LOOKAHEAD_TICKS) continue;
            if (unknown && e.criticality !== E.Criticality.CRITICAL) continue;
            if (unknown && meta && meta.generation > 1) continue; // unknown chains are not extrapolated
            const s = slotOf(e.stableKey);
            out.push({
                key: e.stableKey, slot: s.slot, generation: s.generation, kind: 'REPLACEMENT', fn: meta ? meta.fn : 'other',
                criticality: e.criticality, body: e.body.slice(), cost: e.bodyCost, spawnTime: e.spawnTime, travelTime: e.travelTime,
                startBy: e.startBy, deadline: e.deadline, quality: e.quality, currentCreepName: e.currentCreepName,
                reasonCode: late ? ReasonCode.CRITICAL_DEADLINE : unknown ? ReasonCode.MISSING_FIELD : ReasonCode.SHADOW_ONLY,
                due: late || (e.startBy !== null && e.startBy <= tick),
            });
        }
    }
    const reasons = roomState.signals ? roomState.signals.reasons : [];
    const hasSpawn = reasons.indexOf('NO_SPAWN') === -1;
    const chain = [['NO_HARVEST_CHAIN', 'harvest'], ['NO_FEED_CHAIN', 'feed']];
    for (let i = 0; i < chain.length; i++) {
        if (!hasSpawn || reasons.indexOf(chain[i][0]) === -1) continue;
        const fn = chain[i][1];
        const t = EMERGENCY[fn];
        const travel = roomState.travel && roomState.travel['emergency:' + fn] ? roomState.travel['emergency:' + fn] : unknownMeasure(ReasonCode.MISSING_FIELD);
        out.push({
            key: roomState.roomName + '/emergency/' + fn + '#g1', slot: roomState.roomName + '/emergency/' + fn, generation: 1, kind: 'CHAIN', fn: fn,
            criticality: E.Criticality.CRITICAL, body: t.body.slice(), cost: t.cost, spawnTime: 3 * t.body.length, travelTime: travel,
            startBy: tick, deadline: tick, quality: E.Quality.ESTIMATED, currentCreepName: null, reasonCode: ReasonCode.CRITICAL_DEADLINE, due: true,
        });
    }
    out.sort(function (a, b) {
        const sa = a.startBy === null ? Infinity : a.startBy;
        const sb = b.startBy === null ? Infinity : b.startBy;
        if (sa !== sb) return sa < sb ? -1 : 1;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return out.slice(0, MAX_PROPOSALS);
}

/**
 * Hypothetical Proposal for one need (stage A: missionPatches [], never executed).
 * @param {object} need from mandatoryNeeds
 * @param {{roomName:string, tick:number, revision:(number|null), inputFingerprint:string}} at
 * @param {{body?:string[], cost?:number, label?:string}} [variant] cheaper alternative body
 */
function proposalFor(need, at, variant) {
    const body = variant && variant.body ? variant.body.slice() : need.body.slice();
    const cost = variant && typeof variant.cost === 'number' ? variant.cost : need.cost;
    const spawnTime = 3 * body.length;
    const tag = variant && variant.label ? variant.label : 'same';
    const proposalId = 'sp:' + at.roomName + ':' + shortHash({ key: need.key, body: body, tag: tag });
    const demand = {
        stableKey: need.slot,
        generation: need.generation,
        missionId: null,
        roomName: at.roomName,
        capability: need.fn,
        measurementUnit: E.MeasurementUnit.COVERAGE,
        amount: 1,
        location: null,
        requiredBy: need.deadline,
        earliestStart: null,
        criticality: need.criticality,
        options: [{ body: body, cost: cost, spawnTime: spawnTime, provides: 1, travelTime: need.travelTime }],
        createdAt: at.tick,
    };
    return {
        proposalId: proposalId,
        mode: E.RoomMode.SHADOW,
        roomName: at.roomName,
        missionId: null,
        tick: at.tick,
        inputFingerprint: at.inputFingerprint,
        expectedRevision: at.revision,
        reasonCode: need.reasonCode,
        demands: [demand],
        missionPatches: [],
        reservationRequests: [{ kind: E.ReservationKind.SPEND, nodeId: spawnPoolNodeId(at.roomName), targetNodeId: null, resourceType: 'energy', amount: cost, dueAt: need.startBy === null ? null : Math.max(at.tick, need.startBy) }],
        dependencies: [],
    };
}

function measuredView(m) {
    if (!m) return null;
    return m.value === null ? { value: null, reason: m.reason } : { value: m.value, quality: m.quality };
}

/** Balance explanation: last complete A3 flow window and the A4 forecast; UNKNOWN stays visible. */
function explainBalance(roomState) {
    const w = lastCompleteWindow(roomState.flowWindows || []);
    const out = { window: null, forecast: null, reserve: null };
    if (w !== null) {
        const f = w.flows;
        out.window = {
            start: w.windowStart, quality: w.quality, topology: w.topologyVersion === null ? null : 'known',
            income: f.harvest.value === null || f.externalIn.value === null ? null : f.harvest.value + f.externalIn.value,
            spend: [f.spawnSpend, f.build, f.repair, f.upgrade].some(function (m) { return m.value === null; }) ? null : f.spawnSpend.value + f.build.value + f.repair.value + f.upgrade.value,
            internal: f.internalTransfer.value, out: f.externalOut.value, decay: f.decayLoss.value, unexplained: f.unexplained.value,
            reasons: w.reasonCodes.slice(0, 4),
        };
    }
    const s = roomState.summary && roomState.summary.kind === 'READY' ? roomState.summary.value : null;
    if (s !== null) {
        out.forecast = { computedAt: s.computedAt, age: roomState.tick - s.computedAt, free: measuredView(s.freeEnergyNow), income: measuredView(s.incomeLowerPerTick), committed: measuredView(s.committedPayments), deficitAt: s.nextDeficitTick, quality: s.quality, reasons: s.reasonCodes.slice(0, 4) };
    } else if (roomState.summary) {
        out.forecast = { unknown: roomState.summary.kind === 'REJECTED' ? roomState.summary.reasonCode : roomState.summary.reason };
    }
    const r = roomState.reserves;
    const liquid = roomState.liquidity ? roomState.liquidity.observed : null;
    if (r && r.kind === 'READY') {
        let status = 'UNKNOWN';
        if (liquid && liquid.value !== null) status = liquid.value < r.value.lower ? 'BELOW_LOWER' : liquid.value < r.value.target ? 'BELOW_TARGET' : 'AT_TARGET';
        out.reserve = { lower: r.value.lower, target: r.value.target, liquid: measuredView(liquid), status: status };
    } else if (r) {
        out.reserve = { unknown: r.kind === 'REJECTED' ? r.reasonCode : r.reason, liquid: measuredView(liquid), status: 'UNKNOWN' };
    }
    return out;
}

/**
 * Compare the previous decision with what legacy actually does (shadow explanation):
 *   spawning legacy creeps: matched when the previous record listed a need of that role/function;
 *   late needs: due now and legacy has nothing spawning for that function.
 */
function compareLegacy(roomState, needs, functionOfRole) {
    const prevNeeds = roomState.lastRecord && roomState.lastRecord.inputs && Array.isArray(roomState.lastRecord.inputs.needs) ? roomState.lastRecord.inputs.needs : [];
    const prevFns = {};
    for (let i = 0; i < prevNeeds.length; i++) if (prevNeeds[i] && typeof prevNeeds[i].fn === 'string') prevFns[prevNeeds[i].fn] = true;
    const spawning = (roomState.spawning || []).map(function (s) {
        const fn = functionOfRole ? functionOfRole(s.role) : 'other';
        return { name: s.name, role: s.role, fn: fn, matched: prevFns[fn] === true };
    });
    const spawningFns = {};
    for (let i = 0; i < spawning.length; i++) spawningFns[spawning[i].fn] = true;
    const late = [];
    for (let i = 0; i < needs.length; i++) {
        if (needs[i].due && !spawningFns[needs[i].fn]) late.push({ key: needs[i].key, fn: needs[i].fn, startBy: needs[i].startBy });
    }
    let status = 'CONSISTENT';
    if (late.length > 0) status = 'LEGACY_BEHIND';
    else if (spawning.some(function (s) { return !s.matched; })) status = 'LEGACY_UNPLANNED_SPAWN';
    if (roomState.replacement && roomState.replacement.kind !== 'READY') status = 'UNKNOWN';
    return { status: status, spawning: spawning.slice(0, 4), late: late.slice(0, 4) };
}

function addCode(list, code) {
    if (isReasonCode(code) && list.indexOf(code) === -1) list.push(code);
}

/**
 * Full shadow evaluation of one room.
 * @param {object} context createContext({mode:'shadow', ...}) (no gateway; capabilities checked)
 * @param {object} roomState see file header
 * @param {{functionOf?: function(string|null): string}} [helpers]
 * @returns {object} {roomName, tick, gov, threat, maturity, needs, proposals, comparison, balance, unknown, reasonCodes, inputFingerprint}
 */
function evaluateRoom(context, roomState, helpers) {
    if (!context || context.mode !== E.RoomMode.SHADOW) throw new TypeError('ShadowGovernor runs only in shadow mode');
    if (context.capabilities && context.capabilities.ISSUE_INTENTS) throw new TypeError('ShadowGovernor never gets intent capability');
    const tick = roomState.tick;
    const room = roomState.room;
    const threat = classifyThreat(room);
    const prev = govOf(roomState.lastRecord);
    const decided = decideMode({ tick: tick, lastClosedTick: roomState.lastClosedTick, roomContinuous: roomState.roomContinuous, threat: threat, signals: roomState.signals, prev: prev });
    const maturity = decideMaturity(room, roomState.signals, roomState.flowWindows, roomState.empire);
    const summaryFp = roomState.summary && roomState.summary.kind === 'READY' ? roomState.summary.value.calendarFingerprint : null;
    const inputFingerprint = fingerprint({ s: roomState.snapshotFingerprint || null, r: roomState.roomName, t: tick, c: summaryFp, m: decided.mode });
    const needs = mandatoryNeeds(roomState);
    const at = { roomName: roomState.roomName, tick: tick, revision: roomState.revision === undefined ? null : roomState.revision, inputFingerprint: inputFingerprint };
    const proposals = needs.map(function (n) { return proposalFor(n, at); });
    const functionOfRole = helpers && helpers.functionOf ? helpers.functionOf : null;
    const comparison = compareLegacy(roomState, needs, functionOfRole);
    const balance = explainBalance(roomState);
    const unknown = [];
    if (roomState.summary && roomState.summary.kind !== 'READY') addCode(unknown, roomState.summary.kind === 'REJECTED' ? roomState.summary.reasonCode : roomState.summary.reason);
    if (roomState.summary && roomState.summary.kind === 'READY' && roomState.summary.value.quality === E.Quality.UNKNOWN) roomState.summary.value.reasonCodes.forEach(function (c) { addCode(unknown, c); });
    if (roomState.reserves && roomState.reserves.kind !== 'READY') addCode(unknown, roomState.reserves.kind === 'REJECTED' ? roomState.reserves.reasonCode : roomState.reserves.reason);
    if (roomState.replacement && roomState.replacement.kind !== 'READY') addCode(unknown, roomState.replacement.kind === 'REJECTED' ? roomState.replacement.reasonCode : roomState.replacement.reason);
    if (threat.threat === 'NOT_VISIBLE') addCode(unknown, ReasonCode.NO_VISIBILITY);
    unknown.sort();
    const reasonCodes = unknown.slice();
    for (let i = 0; i < proposals.length; i++) addCode(reasonCodes, proposals[i].reasonCode);
    reasonCodes.sort();
    return {
        roomName: roomState.roomName,
        tick: tick,
        gov: { mode: decided.mode, since: decided.since, hold: decided.hold },
        rawMode: decided.raw,
        threat: threat,
        maturity: maturity,
        needs: needs,
        proposals: proposals,
        comparison: comparison,
        balance: balance,
        unknown: unknown,
        reasonCodes: reasonCodes,
        inputFingerprint: inputFingerprint,
        signals: roomState.signals ? roomState.signals.reasons.slice() : null,
    };
}

/**
 * RoomGovernor.propose of contract A.4 §10.
 * @param {object} context shadow context (no gateway)
 * @param {object} roomState
 * @returns {object[]} Proposal[] (hypothetical; missionPatches [])
 */
function propose(context, roomState) {
    return evaluateRoom(context, roomState).proposals;
}

/** Compact need for the record (persisted: bounded size). */
function needView(n) {
    return { key: n.key, fn: n.fn, crit: n.criticality, startBy: n.startBy, deadline: n.deadline, cost: n.cost, q: n.quality, due: n.due, reason: n.reasonCode };
}

/**
 * Decision signature: the record is significant when it differs from the last one.
 * Mode/hold, maturity, proposals and their admission, UNKNOWN causes, legacy
 * comparison, a new complete flow window — not per-tick noise.
 */
function signatureOf(evaluation, alternatives, extra) {
    return fingerprint({
        gov: evaluation ? [evaluation.gov.mode, evaluation.gov.hold] : null,
        threat: evaluation ? evaluation.threat.threat : null,
        maturity: evaluation ? evaluation.maturity.maturity : null,
        needs: evaluation ? evaluation.needs.map(function (n) { return [n.key, n.due, n.reasonCode]; }) : null,
        alt: (alternatives || []).map(function (a) { return [a.label, a.accepted, a.reasonCode]; }),
        unknown: evaluation ? evaluation.unknown : null,
        cmp: evaluation ? [evaluation.comparison.status, evaluation.comparison.spawning.map(function (s) { return s.name; }), evaluation.comparison.late.map(function (l) { return l.key; })] : null,
        window: evaluation && evaluation.balance.window ? evaluation.balance.window.start : null,
        fq: evaluation && evaluation.balance.forecast ? evaluation.balance.forecast.quality || 'UNKNOWN' : null,
        extra: extra || null,
    });
}

/**
 * Compose the DecisionRecord of one room for this tick.
 * @param {object} evaluation evaluateRoom output
 * @param {{alternatives: object[], selectedProposalId: (string|null), reasonCode: string, rejected: object[]}} admission
 * @param {number} seq sequence number within the tick
 * @returns {object} DecisionRecord (mode 'shadow', executed false)
 */
function composeRecord(evaluation, admission, seq) {
    const alternatives = admission.alternatives;
    const signature = signatureOf(evaluation, alternatives, null);
    const selected = admission.selectedProposalId;
    let expectedNextFact = null;
    const first = evaluation.needs.length > 0 ? evaluation.needs[0] : null;
    if (first !== null) expectedNextFact = { kind: 'SPAWN_START', fn: first.fn, key: first.key, by: first.startBy, body: first.body.length };
    const resultKind = evaluation.unknown.length > 0 ? 'UNKNOWN' : 'READY';
    return {
        decisionId: 'dr:' + evaluation.roomName + ':' + evaluation.tick + ':' + seq,
        tick: evaluation.tick,
        roomName: evaluation.roomName,
        mode: E.RoomMode.SHADOW,
        reasonCode: admission.reasonCode,
        inputFingerprint: evaluation.inputFingerprint,
        inputs: {
            gov: evaluation.gov,
            raw: evaluation.rawMode,
            threat: evaluation.threat,
            maturity: evaluation.maturity.maturity,
            needs: evaluation.needs.map(needView),
            signals: evaluation.signals,
            unknown: evaluation.unknown,
            legacy: evaluation.comparison,
            balance: evaluation.balance,
            signature: signature,
        },
        alternatives: alternatives,
        selectedProposalId: selected,
        expectedNextFact: expectedNextFact,
        resultKind: resultKind,
        executed: false,
    };
}

/**
 * Record of a tick in which the shadow pipeline did not complete (budget deferral,
 * component fault, lost ticks). Carries the hysteresis state of the last record
 * so the persisted ring always holds it — with the clear streak of an active hold
 * reset (clearSince null): an unevaluated tick is never a clear tick.
 * @param {{roomName:string, tick:number, reasonCode:string, resultKind:string, detail:object, lastRecord:(object|null), inputFingerprint:string}} input
 */
function interruptionRecord(input, seq) {
    const prev = govOf(input.lastRecord);
    // a tick that was not evaluated breaks the clear streak of an active SIEGE/ALERT hold
    const hold = prev && prev.hold ? { mode: prev.hold.mode, clearSince: null } : null;
    const gov = prev ? { mode: prev.mode, since: prev.since, hold: hold } : null;
    const signature = fingerprint({ interruption: input.reasonCode, kind: input.resultKind, component: input.detail && input.detail.component ? input.detail.component : null, gov: gov });
    return {
        decisionId: 'dr:' + input.roomName + ':' + input.tick + ':' + seq,
        tick: input.tick,
        roomName: input.roomName,
        mode: E.RoomMode.SHADOW,
        reasonCode: input.reasonCode,
        inputFingerprint: input.inputFingerprint,
        inputs: { gov: gov, interruption: input.detail, signature: signature },
        alternatives: [],
        selectedProposalId: null,
        expectedNextFact: null,
        resultKind: input.resultKind,
        executed: false,
    };
}

/** True when `record` differs from `last` in its decision signature. */
function isSignificant(record, last) {
    if (!last || !last.inputs) return true;
    return canonicalJson(record.inputs.signature) !== canonicalJson(last.inputs.signature);
}

module.exports = {
    EXIT_HOLD_TICKS,
    LOOKAHEAD_TICKS,
    MAX_PROPOSALS,
    POLICY_VERSION,
    Mode,
    Maturity,
    EMERGENCY,
    classifyThreat,
    govOf,
    decideMode,
    decideMaturity,
    mandatoryNeeds,
    proposalFor,
    explainBalance,
    compareLegacy,
    evaluateRoom,
    propose,
    signatureOf,
    composeRecord,
    interruptionRecord,
    isSignificant,
};
