// Shared inputs for presenter unit tests (STRAT-VIEW): a hand-made shadow room state in the
// persisted format (DecisionRecord inputs as written by ShadowGovernor, ForecastSummary,
// FlowWindow) and a RoomSnapshot-like room. Values only.

const ROOM = 'W1N1';

function m(value, quality) { return value === null ? { value: null, quality: 'UNKNOWN', reason: quality || 'NO_HISTORY' } : { value: value, quality: quality || 'OBSERVED', reason: null }; }

function flows(harvest) {
    return { harvest: m(harvest, 'OBSERVED'), externalIn: m(0), externalOut: m(0), spawnSpend: m(0), build: m(0), repair: m(0), upgrade: m(100), decayLoss: m(0), internalTransfer: m(300), unexplained: m(0) };
}

function fullRecord(tick, over) {
    const o = over || {};
    return {
        decisionId: 'dr:' + ROOM + ':' + tick + ':0', tick: tick, roomName: ROOM, mode: 'shadow', reasonCode: o.reasonCode || 'SHADOW_ONLY', inputFingerprint: 'fnv1a64:0000000000000001',
        inputs: {
            gov: { mode: o.mode || 'GROW', since: o.since === undefined ? 1000 : o.since, hold: null },
            raw: o.mode || 'GROW',
            threat: { threat: 'NONE', armed: 0, thieves: 0, scouts: 0 },
            maturity: 'BASIC',
            needs: o.needs || [],
            signals: [],
            unknown: o.unknown || [],
            legacy: o.legacy || { status: 'CONSISTENT', spawning: [], late: [] },
            balance: { window: null, forecast: null, reserve: o.reserve === undefined ? { lower: 200, target: 450, liquid: m(380), status: 'BELOW_TARGET' } : o.reserve },
            signature: 'fnv1a64:' + String(tick).padStart(16, '0'),
        },
        alternatives: o.alternatives || [{ label: 'optional-growth', proposalId: null, reasonCode: 'SHADOW_ONLY', accepted: true }],
        selectedProposalId: null, expectedNextFact: null, resultKind: (o.unknown || []).length > 0 ? 'UNKNOWN' : 'READY', executed: false,
    };
}

function interruptionRecord(tick, gov) {
    return {
        decisionId: 'dr:' + ROOM + ':' + tick + ':9', tick: tick, roomName: ROOM, mode: 'shadow', reasonCode: 'BUDGET_DEFERRED', inputFingerprint: 'fnv1a64:0000000000000002',
        inputs: { gov: gov, interruption: { kind: 'INTERRUPTED', component: 'forecast.shadow', result: 'DEFERRED' }, signature: 'x' },
        alternatives: [], selectedProposalId: null, expectedNextFact: null, resultKind: 'DEFERRED', executed: false,
    };
}

function forecast(tick, over) {
    const o = over || {};
    return {
        roomName: ROOM, computedAt: tick, horizon: 1500,
        freeEnergyNow: o.free === undefined ? m(380) : o.free,
        incomeLowerPerTick: o.income === undefined ? m(4, 'DERIVED') : o.income,
        committedPayments: m(0), nextDeficitTick: o.deficit === undefined ? null : o.deficit, calendarFingerprint: null,
        quality: o.quality || 'DERIVED', reasonCodes: [],
    };
}

function windowAt(start, harvest, complete) {
    return { roomName: ROOM, windowStart: start, windowEnd: start + 100, ticksCovered: complete === false ? 40 : 100, complete: complete !== false, topologyVersion: null, flows: flows(harvest), quality: 'OBSERVED', reasonCodes: [] };
}

function shadowRoom(over) {
    const o = over || {};
    return {
        eventCursor: null,
        flowWindows: o.flowWindows || [windowAt(900, 400)],
        observedBindings: {},
        forecast: o.forecast === undefined ? forecast(1040) : o.forecast,
        decisionRing: o.ring || [fullRecord(1000)],
    };
}

function roomSnapshot(over) {
    const o = over || {};
    return {
        roomName: ROOM, tick: 1050, visibility: 'VISIBLE', controller: null,
        energyAvailable: m(300), energyCapacityAvailable: m(400), energyNodes: [],
        spawns: [{ id: 'spawn1', name: 'Spawn1', roomName: ROOM, pos: { roomName: ROOM, x: 25, y: 25 }, spawning: o.spawning || null }],
        sources: [{ id: 'src1', pos: { roomName: ROOM, x: 10, y: 10 }, energy: m(3000), energyCapacity: m(3000), ticksToRegeneration: m(300) }],
        hostiles: [], constructionSites: [], eventLog: { status: 'CAPTURED' }, missingFields: [],
    };
}

function creep(name, role, ttl, x, y) {
    return { name: name, id: 'c_' + name, roomName: ROOM, pos: { roomName: ROOM, x: x, y: y }, spawning: false, body: [], ticksToLive: ttl === null ? m(null, 'MISSING_FIELD') : m(ttl), store: { energy: m(0), capacity: m(50) }, legacyRole: role, strategyEnvelope: null };
}

/** View with one shadow room (StateView-shaped enough for the presenter). */
function view(shadow, proposals, extra) {
    const v = {
        dtoType: 'StateView', status: 'OPEN', sessionTick: 1050, blockedReason: null, quarantine: [],
        strategy: { revision: 5, lastClosedTick: 1049, control: { rooms: { W1N1: { requestedMode: 'shadow' } } } },
        shadow: { schemaVersion: 1, rooms: { W1N1: shadow }, ledger: { reservations: {} }, observedOperations: {}, proposals: proposals || {} },
    };
    return Object.assign(v, extra || {});
}

function proposal(id, fn, cost, dueAt) {
    return { proposalId: id, mode: 'shadow', roomName: ROOM, missionId: null, tick: 1040, inputFingerprint: 'fnv1a64:0000000000000003', expectedRevision: 4, reasonCode: 'SHADOW_ONLY',
        demands: [{ stableKey: ROOM + '/legacy/x/' + fn, generation: 1, missionId: null, roomName: ROOM, capability: fn, measurementUnit: 'coverage', amount: 1, location: null, requiredBy: dueAt + 20, earliestStart: null, criticality: 'CRITICAL', options: [], createdAt: 1040 }],
        missionPatches: [], reservationRequests: [{ kind: 'SPEND', nodeId: 'spawnPool:' + ROOM, targetNodeId: null, resourceType: 'energy', amount: cost, dueAt: dueAt }], dependencies: [] };
}

/** Router result with the given shadow rooms. */
function router(rooms) {
    const out = {};
    for (const r of rooms) out[r] = { roomName: r, newSystem: 'SHADOW', status: { kind: 'READY' } };
    return { kind: 'READY', value: { rooms: out } };
}

/** Recording ports for the presenter. */
function recordingPorts(flagsValue) {
    const ops = [];
    const lines = [];
    const visual = { available: function () { return true; } };
    ['text', 'rect', 'line', 'circle', 'poly'].forEach(function (shape) { visual[shape] = function (room) { ops.push({ room: room, shape: shape, args: Array.prototype.slice.call(arguments, 1) }); return true; }; });
    let flagReads = 0;
    const flags = { read: function () { flagReads++; return typeof flagsValue === 'function' ? flagsValue() : flagsValue; } };
    const logs = [];
    return { visual: visual, console: { log: function (l) { lines.push(l); } }, flags: flags, log: { warn: function (c, f) { logs.push([c, f]); } }, ops: ops, lines: lines, logs: logs, flagReads: function () { return flagReads; } };
}

function cpuPort(reading) {
    return { read: function () { return Object.assign({ used: 1, limit: 20, tickLimit: 500, bucket: 10000, missingFields: [] }, typeof reading === 'function' ? reading() : reading || {}); } };
}

/** Frame for present.shadow. */
function frame(tick, results, stateView, cpu) {
    return {
        tick: tick, tickToken: tick, phase: 'CLOSE',
        services: { clock: { tick: function () { return tick; } }, cpu: cpu || cpuPort(), log: null, state: { view: function () { return stateView; }, apply: function () { throw new Error('read-only'); } } },
        result: function (name) { return Object.prototype.hasOwnProperty.call(results, name) ? results[name] : null; },
    };
}

module.exports = { ROOM, m, fullRecord, interruptionRecord, forecast, windowAt, shadowRoom, roomSnapshot, creep, view, proposal, router, recordingPorts, cpuPort, frame };
