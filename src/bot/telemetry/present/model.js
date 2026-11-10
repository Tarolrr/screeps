// Presenter model (STRAT-VIEW, contract A.5): pure facts of one shadow room for the
// overlay, the console events and the `strat.report` / `strat.why` commands.
//
//   buildRoomModel({tick, roomName, room, creeps, shadowRoom, proposals}) -> RoomModel
//
// Inputs are values only: the current Snapshot's RoomSnapshot and own creeps in the room,
// the persisted ShadowRoom of the StateView (decision ring, forecast, flow windows,
// observed bindings) and the room's stored proposals. Nothing is recomputed: the model
// only reads decisions already written by the shadow pipeline. UNKNOWN stays UNKNOWN
// (value null + reason), it is never shown as 0.

const { functionOf } = require('../../models/ReplacementForecast');

const MAX_CREEPS = 20;
const MAX_SPAWNS = 3;
const MAX_PROPOSALS = 6;
const GAP_WINDOWS = 3;

/** Newest record of the ring that carries hysteresis state (any record), newest full evaluation, newest record. */
function ringFacts(ring, beforeTick) {
    let gov = null;
    let full = null;
    let newest = null;
    for (let i = ring.length - 1; i >= 0; i--) {
        const r = ring[i];
        if (beforeTick !== undefined && r.tick >= beforeTick) continue;
        if (newest === null) newest = r;
        if (gov === null && r.inputs && r.inputs.gov) gov = r;
        if (full === null && r.inputs && Array.isArray(r.inputs.needs)) full = r;
        if (gov !== null && full !== null) break;
    }
    return { gov: gov, full: full, newest: newest };
}

/** Measured -> {value, quality, reason}; anything malformed is UNKNOWN. */
function measuredOf(m) {
    if (!m || typeof m !== 'object' || m.value === null || typeof m.value !== 'number') {
        return { value: null, quality: 'UNKNOWN', reason: m && typeof m.reason === 'string' ? m.reason : 'MISSING_FIELD' };
    }
    return { value: m.value, quality: typeof m.quality === 'string' ? m.quality : 'OBSERVED', reason: null };
}

/** Creep name of a legacy replacement slot key '<room>/legacy/<group>/<creep>#g<n>' (or null). */
function creepOfNeedKey(key) {
    if (typeof key !== 'string' || key.indexOf('/legacy/') === -1) return null;
    const hash = key.lastIndexOf('#g');
    const body = hash === -1 ? key : key.slice(0, hash);
    const slash = body.lastIndexOf('/');
    return slash === -1 ? null : body.slice(slash + 1) || null;
}

function needOf(record, key) {
    const needs = record && record.inputs && Array.isArray(record.inputs.needs) ? record.inputs.needs : [];
    for (let i = 0; i < needs.length; i++) if (needs[i].key === key) return needs[i];
    return null;
}

/** What shadow proposes now, from the newest full record's admission alternatives. */
function shadowPlanOf(record, tick) {
    if (record === null) return { kind: 'unknown', fn: null, text: 'no decision yet', at: null, cost: null, reason: null };
    const alts = Array.isArray(record.alternatives) ? record.alternatives : [];
    const firstOf = function (prefix, accepted) {
        for (let i = 0; i < alts.length; i++) if (alts[i].label.indexOf(prefix) === 0 && (accepted === undefined || alts[i].accepted === accepted)) return alts[i];
        return null;
    };
    const keyOf = function (alt, prefix) { return alt.label.slice(prefix.length); };
    let alt = firstOf('spawn:', true);
    let prefix = 'spawn:';
    if (alt === null) { alt = firstOf('emergency:', true); prefix = 'emergency:'; }
    if (alt !== null) {
        const need = needOf(record, keyOf(alt, prefix));
        const fn = need ? need.fn : null;
        const cost = need ? need.cost : null;
        return { kind: 'spawn', fn: fn, at: need ? need.startBy : null, cost: cost, reason: alt.reasonCode, emergency: prefix === 'emergency:',
            text: (prefix === 'emergency:' ? 'emergency ' : 'spawn ') + (fn || '?') + (cost !== null ? ' ' + cost + 'e' : '') };
    }
    alt = firstOf('defer:');
    if (alt !== null) {
        const need = needOf(record, keyOf(alt, 'defer:'));
        const fn = need ? need.fn : null;
        return { kind: 'defer', fn: fn, at: need ? need.startBy : null, cost: need ? need.cost : null, reason: alt.reasonCode, text: 'defer ' + (fn || '?') + ': ' + alt.reasonCode };
    }
    alt = firstOf('schedule:');
    if (alt !== null) {
        const need = needOf(record, keyOf(alt, 'schedule:'));
        const fn = need ? need.fn : null;
        const at = need ? need.startBy : null;
        return { kind: 'schedule', fn: fn, at: at, cost: need ? need.cost : null, reason: alt.reasonCode, text: (fn || '?') + ' @' + (at === null ? '?' : at) + (at !== null && at >= tick ? ' (in ' + (at - tick) + ')' : '') };
    }
    return { kind: 'idle', fn: null, at: null, cost: null, reason: record.reasonCode, text: 'no spawn needed' };
}

/** Newest complete flow window and the recent gap count. */
function flowFacts(windows) {
    let complete = null;
    for (let i = windows.length - 1; i >= 0; i--) if (windows[i].complete) { complete = windows[i]; break; }
    const recent = windows.slice(-GAP_WINDOWS);
    let gaps = 0;
    for (let i = 0; i < recent.length; i++) {
        const w = recent[i];
        if (w.quality === 'UNKNOWN' || (Array.isArray(w.reasonCodes) && w.reasonCodes.indexOf('EVENT_GAP') !== -1)) gaps++;
    }
    let window = null;
    if (complete !== null) {
        const f = complete.flows;
        window = {
            start: complete.windowStart, quality: complete.quality,
            harvest: measuredOf(f.harvest), upgrade: measuredOf(f.upgrade), spawnSpend: measuredOf(f.spawnSpend),
            internal: measuredOf(f.internalTransfer), unexplained: measuredOf(f.unexplained),
        };
    }
    return { window: window, gaps: gaps, recent: recent.length };
}

/**
 * @param {{tick:number, roomName:string, room:(object|null), creeps:object[], shadowRoom:(object|null), proposals:object[]}} input
 * @returns {object} RoomModel
 */
function buildRoomModel(input) {
    const tick = input.tick;
    const room = input.room || null;
    const sr = input.shadowRoom || null;
    const ring = sr && Array.isArray(sr.decisionRing) ? sr.decisionRing : [];
    const facts = ringFacts(ring);
    const govRec = facts.gov;
    const full = facts.full;
    const newest = facts.newest;
    const gov = govRec ? govRec.inputs.gov : null;
    const interruption = newest && newest.inputs && newest.inputs.interruption ? { reason: newest.reasonCode, component: newest.inputs.interruption.component || newest.inputs.interruption.kind || null, tick: newest.tick } : null;

    const forecast = sr && sr.forecast ? sr.forecast : null;
    const reserve = full && full.inputs.balance && full.inputs.balance.reserve ? full.inputs.balance.reserve : null;
    const free = forecast ? measuredOf(forecast.freeEnergyNow) : { value: null, quality: 'UNKNOWN', reason: 'NO_HISTORY' };
    const lower = reserve && typeof reserve.lower === 'number' ? reserve.lower : null;
    const target = reserve && typeof reserve.target === 'number' ? reserve.target : null;
    let status = 'UNKNOWN';
    if (free.value !== null && lower !== null && target !== null) status = free.value < lower ? 'BELOW_LOWER' : free.value < target ? 'BELOW_TARGET' : 'AT_TARGET';
    const income = forecast ? measuredOf(forecast.incomeLowerPerTick) : { value: null, quality: 'UNKNOWN', reason: 'NO_HISTORY' };
    const flows = flowFacts(sr && Array.isArray(sr.flowWindows) ? sr.flowWindows : []);

    const unknown = full && Array.isArray(full.inputs.unknown) ? full.inputs.unknown.slice(0, 6) : [];
    const plan = shadowPlanOf(full, tick);
    const legacyCmp = full && full.inputs.legacy ? full.inputs.legacy : null;

    // replacement labels: needs of the newest full record mapped to legacy creeps
    const repl = {};
    const needs = full && Array.isArray(full.inputs.needs) ? full.inputs.needs : [];
    for (let i = 0; i < needs.length; i++) {
        const name = creepOfNeedKey(needs[i].key);
        if (name === null || repl[name]) continue;
        const at = typeof needs[i].startBy === 'number' ? needs[i].startBy : null;
        repl[name] = { at: at, late: needs[i].reason === 'CRITICAL_DEADLINE' || (at !== null && at < tick), fn: needs[i].fn };
    }

    const bindings = sr && sr.observedBindings ? sr.observedBindings : {};
    const creeps = [];
    const list = (input.creeps || []).slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    for (let i = 0; i < list.length && creeps.length < MAX_CREEPS; i++) {
        const c = list[i];
        if (!c.pos || c.spawning) continue;
        const role = c.legacyRole || (bindings[c.name] && bindings[c.name].legacyRole) || null;
        creeps.push({ name: c.name, x: c.pos.x, y: c.pos.y, role: role, ttl: measuredOf(c.ticksToLive), repl: repl[c.name] || null });
    }

    const creepRole = {};
    for (let i = 0; i < (input.creeps || []).length; i++) creepRole[input.creeps[i].name] = input.creeps[i].legacyRole || null;
    const spawns = [];
    const roomSpawns = room && Array.isArray(room.spawns) ? room.spawns.slice(0, MAX_SPAWNS) : [];
    for (let i = 0; i < roomSpawns.length; i++) {
        const s = roomSpawns[i];
        let legacy = null;
        if (s.spawning) {
            const role = creepRole[s.spawning.name] || (bindings[s.spawning.name] && bindings[s.spawning.name].legacyRole) || null;
            legacy = { name: s.spawning.name, role: role, fn: functionOf(role), remaining: s.spawning.remainingTime };
        }
        let diverge = false;
        if (plan.kind === 'spawn') diverge = legacy === null || legacy.fn !== plan.fn;
        else if (legacy !== null && plan.kind !== 'unknown') diverge = !(plan.fn !== null && plan.fn === legacy.fn);
        spawns.push({ name: s.name, x: s.pos ? s.pos.x : null, y: s.pos ? s.pos.y : null, legacy: legacy, diverge: diverge,
            legacyText: legacy ? 'legacy: ' + (legacy.role || '?') + ' ' + legacy.name : 'legacy: idle' });
    }

    const arrows = [];
    if (flows.window !== null && flows.window.harvest.value !== null && roomSpawns.length > 0 && roomSpawns[0].pos) {
        const sources = room && Array.isArray(room.sources) ? room.sources : [];
        for (let i = 0; i < sources.length && i < 4; i++) {
            if (!sources[i].pos) continue;
            arrows.push({ from: { x: sources[i].pos.x, y: sources[i].pos.y }, to: { x: roomSpawns[0].pos.x, y: roomSpawns[0].pos.y }, perTick: flows.window.harvest.value / 100 / Math.max(1, sources.length) });
        }
    }

    const proposals = (input.proposals || []).slice(0, MAX_PROPOSALS).map(function (p) {
        const d = p.demands && p.demands[0] ? p.demands[0] : null;
        const r = p.reservationRequests && p.reservationRequests[0] ? p.reservationRequests[0] : null;
        return { id: p.proposalId, fn: d ? d.capability : null, cost: r ? r.amount : null, dueAt: r ? r.dueAt : null, reason: p.reasonCode };
    });

    return {
        roomName: input.roomName,
        tick: tick,
        visible: !!room && room.visibility === 'VISIBLE',
        hasSnapshot: !!room,
        mode: gov ? { mode: gov.mode, since: gov.since, hold: gov.hold || null } : null,
        reason: newest ? newest.reasonCode : null,
        recordTick: newest ? newest.tick : null,
        maturity: full ? full.inputs.maturity || null : null,
        threat: full && full.inputs.threat ? full.inputs.threat.threat : null,
        interruption: interruption,
        energy: { free: free, lower: lower, target: target, status: status, capacity: room && room.energyCapacityAvailable ? measuredOf(room.energyCapacityAvailable) : null },
        income: { per100: income.value === null ? null : Math.round(income.value * 100), quality: income.quality, reason: income.reason },
        deficit: forecast ? { tick: typeof forecast.nextDeficitTick === 'number' ? forecast.nextDeficitTick : null, unknown: forecast.quality === 'UNKNOWN' } : { tick: null, unknown: true },
        quality: { forecast: forecast ? forecast.quality : 'UNKNOWN', age: forecast ? tick - forecast.computedAt : null, gaps: flows.gaps, windows: flows.recent, unknown: unknown },
        plan: plan,
        legacy: legacyCmp ? { status: legacyCmp.status, late: (legacyCmp.late || []).map(function (l) { return l.fn + '@' + l.startBy; }), spawning: (legacyCmp.spawning || []).map(function (s) { return s.name; }) } : null,
        creeps: creeps,
        spawns: spawns,
        flows: { window: flows.window, arrows: arrows },
        proposals: proposals,
        expectedNextFact: full ? full.expectedNextFact : null,
    };
}

module.exports = { MAX_CREEPS, MAX_SPAWNS, buildRoomModel, ringFacts, measuredOf, creepOfNeedKey, shadowPlanOf };
