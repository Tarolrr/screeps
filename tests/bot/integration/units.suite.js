// STRAT-A5 pure-module checks (run natively and with dist2/mapPatch.js active):
// ShadowGovernor hysteresis/threats/proposals, DecisionRecorder bounds, StateStore.close,
// contract A.4 layout (exportRequest/replayExport), envelope mapping, travel estimate,
// snapshot filtering.

const test = require('node:test');
const assert = require('node:assert/strict');

const G = require('../../../src/bot/planning/ShadowGovernor');
const Travel = require('../../../src/bot/planning/TravelEstimate');
const { createDecisionRecorder } = require('../../../src/bot/telemetry/DecisionRecorder');
const { buildSnapshot } = require('../../../src/bot/observation/WorldSnapshotBuilder');
const { validateProposal, validateSnapshot, validateDecisionRecord } = require('../../../src/bot/domain/dtos');
const { validateStatePatch, emptyShadowRoot, validateShadowRoot } = require('../../../src/bot/domain/stateLayout');
const { createContext } = require('../../../src/bot/app/context');
const { buildOperationKey } = require('../../../src/bot/domain/keys');
const { fingerprint } = require('../../../src/bot/domain/fingerprint');
const Replacement = require('../../../src/bot/models/ReplacementForecast');
const SA = require('../../../src/bot/integration/ShadowAdapter');
const { filterSnapshot } = SA;
const H = require('../unit/state/helpers');

const ROOM = 'W1N1';
const P = function (x, y, r) { return { roomName: r || ROOM, x: x, y: y }; };

function observation(extra) {
    const e = extra || {};
    return {
        tick: 500, shard: 'shard0', captureStage: 'FULL', cpu: { used: 1, limit: 20, tickLimit: 500, bucket: 10000, missingFields: [] },
        rooms: {
            W1N1: {
                roomName: ROOM, tick: 500, visible: true, eventLog: { raw: [] },
                controller: { id: 'c', my: true, ownerName: 'me', reservationOwner: null, level: 3, progress: 1, progressTotal: 2, ticksToDowngrade: 100, safeModeTicks: undefined },
                energyAvailable: 300, energyCapacityAvailable: 300,
                structures: [{ id: 'sp', objectType: 'spawn', pos: P(25, 25), energy: 300, capacity: 300 }, { id: 'st', objectType: 'storage', pos: P(30, 30), energy: 5000, capacity: 1000000 }],
                spawns: [{ id: 'sp', name: 'Spawn1', pos: P(25, 25), spawning: null }],
                sources: [{ id: 's1', pos: P(10, 25), energy: 3000, energyCapacity: 3000, ticksToRegeneration: 100 }, { id: 's2', pos: P(25, 45), energy: 3000, energyCapacity: 3000, ticksToRegeneration: 100 }],
                hostiles: e.hostiles || [], constructionSites: [], piles: [], creeps: [],
            },
            W2N2: { roomName: 'W2N2', tick: 500, visible: false, eventLog: null, creeps: [] },
        },
        creeps: (e.creeps || [
            { name: 'h1', id: 'i1', roomName: ROOM, pos: P(11, 25), spawning: false, body: [{ type: 'work', hits: 100 }, { type: 'work', hits: 100 }, { type: 'carry', hits: 100 }, { type: 'move', hits: 100 }], ticksToLive: 900, energy: 0, capacity: 50, legacyRole: 'harvester' },
            { name: 'far', id: 'i2', roomName: 'W2N2', pos: P(5, 5, 'W2N2'), spawning: false, body: [{ type: 'move', hits: 100 }], ticksToLive: 900, energy: 0, capacity: 0, legacyRole: 'scout' },
        ]),
    };
}

function threat(kind) { return { threat: kind, armed: 0, thieves: 0, scouts: 0 }; }
const GROW_SIGNALS = { mode: 'GROW', recover: false, stabilize: false, reasons: [] };

function defineUnitTests(label) {
    test(label + ': SIEGE entry is immediate; exit only after 100 consecutive clear visible ticks', function () {
        let prev = null;
        let t = 1000;
        let d = G.decideMode({ tick: t, lastClosedTick: t - 1, threat: threat('ARMED'), signals: GROW_SIGNALS, prev: prev });
        assert.equal(d.mode, 'SIEGE');
        prev = d;
        for (t = 1001; t <= 1099; t++) {
            d = G.decideMode({ tick: t, lastClosedTick: t - 1, threat: threat('NONE'), signals: GROW_SIGNALS, prev: prev });
            assert.equal(d.mode, 'SIEGE', 'held at ' + t);
            prev = d;
        }
        assert.equal(prev.hold.clearSince, 1001);
        d = G.decideMode({ tick: 1100, lastClosedTick: 1099, threat: threat('NONE'), signals: GROW_SIGNALS, prev: prev });
        assert.equal(d.mode, 'GROW', '100th clear tick exits');
        assert.equal(d.hold, null);
    });

    test(label + ': a lost tick or invisibility restarts the exit count; the state survives via the record', function () {
        let prev = G.decideMode({ tick: 1000, lastClosedTick: 999, threat: threat('THIEF'), signals: GROW_SIGNALS, prev: null });
        assert.equal(prev.mode, 'ALERT');
        prev = G.decideMode({ tick: 1001, lastClosedTick: 1000, threat: threat('NONE'), signals: GROW_SIGNALS, prev: prev });
        assert.equal(prev.hold.clearSince, 1001);
        // persisted through a DecisionRecord (reset: heap lost)
        const ev = { roomName: ROOM, tick: 1050, gov: { mode: prev.mode, since: prev.since, hold: prev.hold }, rawMode: 'GROW', threat: threat('NONE'), maturity: { maturity: 'BASIC' }, needs: [], comparison: { status: 'CONSISTENT', spawning: [], late: [] }, balance: { window: null, forecast: null, reserve: null }, unknown: [], inputFingerprint: fingerprint(1), signals: [] };
        const record = G.composeRecord(ev, { alternatives: [], selectedProposalId: null, reasonCode: 'SHADOW_ONLY' }, 0);
        assert.equal(validateDecisionRecord(record).ok, true);
        const restored = G.govOf(JSON.parse(JSON.stringify(record)));
        let d = G.decideMode({ tick: 1060, lastClosedTick: 1058, threat: threat('NONE'), signals: GROW_SIGNALS, prev: restored });
        assert.equal(d.mode, 'ALERT');
        assert.equal(d.hold.clearSince, 1060, 'tick 1059 not closed: count restarts');
        d = G.decideMode({ tick: 1061, lastClosedTick: 1060, threat: threat('NOT_VISIBLE'), signals: GROW_SIGNALS, prev: d });
        assert.equal(d.hold.clearSince, null, 'not visible is not a clear tick');
        d = G.decideMode({ tick: 1062, lastClosedTick: 1061, threat: threat('NONE'), signals: { mode: 'RECOVER', recover: true, stabilize: false, reasons: ['NO_FEED_CHAIN'] }, prev: d });
        assert.equal(d.mode, 'RECOVER', 'higher-priority economic mode enters immediately');
        assert.equal(d.hold.mode, 'ALERT', 'the alert countdown is kept underneath');
    });

    test(label + ': threat classes (armed, unknown body, thief at open storage, scout)', function () {
        const snap = buildSnapshot(observation({ hostiles: [{ id: 'x', ownerName: 'e', pos: P(31, 31), body: [{ type: 'carry', hits: 100 }], hits: 100, hitsMax: 100 }] }));
        assert.equal(G.classifyThreat(snap.rooms[ROOM]).threat, 'THIEF');
        const far = buildSnapshot(observation({ hostiles: [{ id: 'x', ownerName: 'e', pos: P(5, 5), body: [{ type: 'carry', hits: 100 }], hits: 100, hitsMax: 100 }] }));
        assert.equal(G.classifyThreat(far.rooms[ROOM]).threat, 'SCOUT');
        const armed = buildSnapshot(observation({ hostiles: [{ id: 'x', ownerName: 'e', pos: P(5, 5), body: [{ type: 'work', hits: 100 }], hits: 100, hitsMax: 100 }] }));
        assert.equal(G.classifyThreat(armed.rooms[ROOM]).threat, 'ARMED');
        const unknownBody = buildSnapshot(observation({ hostiles: [{ id: 'x', ownerName: 'e', pos: P(5, 5), body: [], hits: 100, hitsMax: 100 }] }));
        assert.equal(G.classifyThreat(unknownBody.rooms[ROOM]).threat, 'ARMED');
        assert.equal(G.classifyThreat(armed.rooms.W2N2).threat, 'NOT_VISIBLE');
    });

    test(label + ': proposals are hypothetical (shadow, missionPatches []) and the governor refuses non-shadow contexts', function () {
        const snap = buildSnapshot(observation());
        const travel = Travel.estimateTravel(snap, ROOM, { functionOf: Replacement.functionOf });
        const replacement = Replacement.analyzeReplacements({ snapshot: snap, roomName: ROOM, horizon: 1500, travelEstimates: travel });
        const ctx = createContext({ mode: 'shadow', tick: 500, snapshot: null, stateView: null, stateRevision: 3, versions: {}, ownerTokens: {}, budget: null });
        const roomState = { roomName: ROOM, tick: 500, room: snap.rooms[ROOM], revision: 3, lastClosedTick: 499, signals: { mode: 'RECOVER', recover: true, stabilize: false, reasons: ['NO_FEED_CHAIN'] }, replacement: replacement, travel: travel, flowWindows: [], spawning: [], lastRecord: null, empire: { selfSufficientRooms: 0 } };
        const proposals = G.propose(ctx, roomState);
        assert.ok(proposals.length >= 1);
        for (const p of proposals) { assert.equal(validateProposal(p).ok, true, JSON.stringify(validateProposal(p))); assert.deepEqual(p.missionPatches, []); assert.equal(p.mode, 'shadow'); }
        assert.ok(proposals.some(function (p) { return p.demands[0].capability === 'feed' && p.reasonCode === 'CRITICAL_DEADLINE'; }), 'missing feed chain -> emergency proposal');
        assert.throws(function () { G.propose(createContext({ mode: 'legacy', tick: 500, snapshot: null, stateView: null, stateRevision: 3, versions: {}, ownerTokens: {}, budget: null }), roomState); }, /shadow mode/);
    });

    test(label + ': travel estimate is ESTIMATED from Chebyshev range x fatigue +25%, absent when not computable', function () {
        const snap = buildSnapshot(observation());
        const t = Travel.estimateTravel(snap, ROOM, { functionOf: Replacement.functionOf });
        // h1: 3 non-move / 1 move -> 3 ticks per tile; worst source range from spawn (25,25): 20 -> ceil(20*3*1.25)=75
        assert.deepEqual(t['W1N1/legacy/harvester/h1'], { value: 75, quality: 'ESTIMATED', reason: null });
        assert.deepEqual(t['emergency:feed'], { value: Math.ceil(20 * 2 * 1.25), quality: 'ESTIMATED', reason: null });
        assert.deepEqual(Travel.estimateTravel(snap, 'W2N2', { functionOf: Replacement.functionOf }), {}, 'not visible: no estimate (UNKNOWN stays)');
    });

    test(label + ': envelope copied only when valid; filterSnapshot drops non-shadow rooms/creeps with a valid fingerprint', function () {
        const key = buildOperationKey({ domain: ROOM, ownerEpoch: 1, demandStableKey: 'W1N1/feed', generation: 2, action: 'spawn', occurrence: '0' });
        const obs = observation();
        obs.creeps[0].strategyEnvelope = { operationKey: key, homeRoom: ROOM, ownerEpoch: 1 };
        obs.creeps[1].strategyEnvelope = { operationKey: 'bad', homeRoom: ROOM, ownerEpoch: 1 };
        const snap = buildSnapshot(obs);
        assert.deepEqual(snap.ownCreeps.h1.strategyEnvelope, { operationKey: key, homeRoom: ROOM, ownerEpoch: 1 });
        assert.equal(snap.ownCreeps.far.strategyEnvelope, null);
        const filtered = filterSnapshot(snap, [ROOM], null);
        assert.deepEqual(Object.keys(filtered.rooms), [ROOM]);
        assert.deepEqual(Object.keys(filtered.ownCreeps), ['h1']);
        assert.equal(validateSnapshot(filtered, { checkFingerprint: true }).ok, true);
        assert.equal(filterSnapshot(filtered, [ROOM], null), filtered, 'nothing to drop: same object');
    });

    test(label + ': DecisionRecorder bounds the ring (100 records, char budget), writer planning only', function () {
        let ring = [];
        const rec = createDecisionRecorder({ capacityPerRoom: 100, maxRingChars: 6000, readRing: function () { return ring; } });
        assert.equal(rec.append({ decisionId: 'x' }).kind, 'REJECTED');
        for (let i = 0; i < 150; i++) {
            const r = G.interruptionRecord({ roomName: ROOM, tick: 1000 + i, reasonCode: 'BUDGET_DEFERRED', resultKind: 'DEFERRED', detail: { i: i }, lastRecord: null, inputFingerprint: fingerprint(i) }, 0);
            assert.equal(rec.append(r).kind, 'READY');
        }
        assert.equal(rec.lastRecord(ROOM).tick, 1149);
        const patches = rec.drain(1149);
        assert.equal(patches.length, 1);
        assert.equal(patches[0].writer, 'planning');
        assert.equal(validateStatePatch(patches[0]).ok, true);
        ring = patches[0].value;
        assert.ok(ring.length <= 100 && JSON.stringify(ring).length <= 6000);
        assert.equal(ring[ring.length - 1].tick, 1149, 'newest kept');
        assert.equal(rec.pending().records, 0);
    });

    test(label + ': contract A.4 layout: exportRequest operator-only, replayExport writer planning', function () {
        const root = emptyShadowRoot();
        root.exportRequest = { requested: true, ticks: 5, tickFrom: null };
        assert.equal(validateShadowRoot(root).ok, true);
        assert.equal(validateStatePatch({ patchId: 'p', writer: 'planning', namespace: 'strategyShadow', path: ['exportRequest'], op: 'set', value: null }).errors[0].code, 'PATH_NOT_PATCHABLE');
        const failed = { requestFingerprint: fingerprint(1), status: 'FAILED', startedAt: 1, completedAt: 2, reasonCode: 'BUDGET_DEFERRED', detail: null, fixture: null };
        assert.equal(validateStatePatch({ patchId: 'p', writer: 'planning', namespace: 'strategyShadow', path: ['replayExport'], op: 'set', value: failed }).ok, true);
        assert.equal(validateStatePatch({ patchId: 'p', writer: 'finance', namespace: 'strategyShadow', path: ['replayExport'], op: 'set', value: failed }).errors[0].code, 'NOT_PATH_OWNER');
        assert.equal(validateStatePatch({ patchId: 'p', writer: 'planning', namespace: 'strategyShadow', path: ['replayExport'], op: 'set', value: Object.assign({}, failed, { status: 'READY' }) }).ok, false, 'READY needs a fixture');
    });

    test(label + ': StateCodec loads a valid exportRequest and quarantines an invalid one without losing the rest', function () {
        const shadow = emptyShadowRoot();
        shadow.exportRequest = { requested: true, ticks: 3 };
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategyShadow: shadow }));
        const store = world.store();
        assert.deepEqual(JSON.parse(JSON.stringify(store.open(world.tick).value.shadow.exportRequest)), { requested: true, ticks: 3 });
        world.edit(function (m) { m.strategyShadow.exportRequest = { requested: 'yes', extra: 1 }; });
        world.nextTick();
        const v = store.open(world.tick).value;
        assert.equal(v.shadow.exportRequest, undefined);
        assert.ok(v.quarantine.some(function (q) { return q.namespace === 'strategyShadow' && q.key === 'exportRequest'; }));
        assert.deepEqual(JSON.parse(JSON.stringify(world.raw().strategyShadow.exportRequest)), { requested: 'yes', extra: 1 }, 'raw kept');
    });

    test(label + ': StateStore.close(tick) writes lastClosedTick as an internal write (no revision bump)', function () {
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: require('../support/fixtures').sampleStrategyRoot() }));
        const store = world.store();
        const view = store.open(world.tick).value;
        const revision = view.strategy.revision;
        assert.equal(store.close(world.tick + 1).reasonCode, 'STALE_INPUT', 'only the session tick');
        const r = store.close(world.tick);
        assert.equal(r.kind, 'READY');
        assert.equal(store.view().strategy.lastClosedTick, world.tick);
        assert.equal(store.view().strategy.revision, revision);
        assert.equal(world.raw().strategy.lastClosedTick, world.tick);
        assert.equal(store.close(world.tick).kind, 'READY', 'idempotent');
        assert.deepEqual(world.journal().violations, []);
        // suspended store: refused, namespace untouched
        const bad = H.createWorld(Object.assign({}, H.LEGACY, { strategy: { schemaVersion: 42 } }));
        const s2 = bad.store();
        s2.open(bad.tick);
        assert.equal(s2.close(bad.tick).reasonCode, 'INCOMPATIBLE_SCHEMA');
        assert.deepEqual(JSON.parse(JSON.stringify(bad.raw().strategy)), { schemaVersion: 42 });
    });
    test(label + ': interruption records reset the clear streak of an active hold (persisted)', function () {
        const prevRecord = { inputs: { gov: { mode: 'SIEGE', since: 1005, hold: { mode: 'SIEGE', clearSince: 1010 } }, signature: fingerprint('prev') } };
        const r = G.interruptionRecord({ roomName: ROOM, tick: 1020, reasonCode: 'BUDGET_DEFERRED', resultKind: 'DEFERRED', detail: { kind: 'INTERRUPTED' }, lastRecord: prevRecord, inputFingerprint: fingerprint(1) }, 9);
        assert.deepEqual(r.inputs.gov.hold, { mode: 'SIEGE', clearSince: null });
        assert.equal(G.isSignificant(r, prevRecord), true);
        const d = G.decideMode({ tick: 1112, lastClosedTick: 1111, roomContinuous: true, threat: threat('NONE'), signals: GROW_SIGNALS, prev: G.govOf(r) });
        assert.equal(d.mode, 'SIEGE');
        assert.equal(d.hold.clearSince, 1112, 'count restarts after the interruption');
        const gap = G.decideMode({ tick: 1113, lastClosedTick: 1112, roomContinuous: false, threat: threat('NONE'), signals: GROW_SIGNALS, prev: d });
        assert.equal(gap.hold.clearSince, 1113, 'room event gap (absent from shadow / deferred reconcile) restarts the count');
    });

    test(label + ': a refused proposal batch never blocks the decision ring (separate batches)', function () {
        let ring = [];
        const rec = createDecisionRecorder({ readRing: function () { return ring; }, readProposals: function () { return {}; } });
        rec.append(G.interruptionRecord({ roomName: ROOM, tick: 10, reasonCode: 'BUDGET_DEFERRED', resultKind: 'DEFERRED', detail: {}, lastRecord: null, inputFingerprint: fingerprint(2) }, 0));
        const snap = buildSnapshot(observation());
        const travel = Travel.estimateTravel(snap, ROOM, { functionOf: Replacement.functionOf });
        const repl = Replacement.analyzeReplacements({ snapshot: snap, roomName: ROOM, horizon: 1500, travelEstimates: travel });
        const ctx = createContext({ mode: 'shadow', tick: 500, snapshot: null, stateView: null, stateRevision: 3, versions: {}, ownerTokens: {}, budget: null });
        const proposals = G.propose(ctx, { roomName: ROOM, tick: 500, room: snap.rooms[ROOM], revision: 3, lastClosedTick: 499, signals: { mode: 'RECOVER', recover: true, stabilize: false, reasons: ['NO_FEED_CHAIN'] }, replacement: repl, travel: travel, flowWindows: [], spawning: [], lastRecord: null, empire: {} });
        assert.equal(rec.stageProposals(ROOM, proposals, []).kind, 'READY');
        const batches = [];
        let revision = 7;
        const planning = {
            view: function () { return { strategy: { revision: revision } }; },
            apply: function (expected, patches) {
                batches.push({ expected: expected, paths: patches.map(function (p) { return p.path[0]; }) });
                if (patches.some(function (p) { return p.path[0] === 'proposals'; })) return { kind: 'REJECTED', reasonCode: 'INVALID_RECORD', evidence: { limit: 200 } };
                revision += 1;
                ring = patches[0].value;
                return { kind: 'READY', value: { revision: revision } };
            },
        };
        const out = SA.persistRecorder(planning, rec, 10);
        assert.equal(out.ring.kind, 'READY');
        assert.equal(out.proposals.kind, 'REJECTED');
        assert.deepEqual(batches.map(function (b) { return b.paths[0]; }), ['rooms', 'proposals']);
        assert.deepEqual(batches.map(function (b) { return b.expected; }), [7, 8], 'expectedRevision: read once, then the revision of the accepted batch');
        assert.equal(ring.length, 1, 'hysteresis-carrying ring persisted');
    });

    test(label + ': forecast cache recomputes at once when liquidity crosses a reserve band', function () {
        function obs(tick, pool, container) {
            const o = observation();
            o.tick = tick; o.rooms.W1N1.tick = tick; o.rooms.W2N2.tick = tick;
            o.rooms.W1N1.energyAvailable = pool;
            o.rooms.W1N1.structures = [{ id: 'sp', objectType: 'spawn', pos: P(25, 25), energy: pool, capacity: 300 }, { id: 'ct', objectType: 'container', pos: P(11, 26), energy: container, capacity: 2000 }];
            o.creeps = [o.creeps[0], { name: 'm1', id: 'i3', roomName: ROOM, pos: P(20, 25), spawning: false, body: [{ type: 'carry', hits: 100 }, { type: 'move', hits: 100 }], ticksToLive: 900, energy: 0, capacity: 50, legacyRole: 'mule' }];
            return buildSnapshot(o);
        }
        const mem = SA.createMemoryState({ revision: 0, control: { rooms: {} }, shadowRooms: {} }, 499);
        const cache = { rooms: {} };
        let r = SA.stepForecast(mem.finance, SA.DEFAULT_MODELS, obs(500, 300, 1500), [ROOM], cache);
        assert.equal(r.value.fresh[ROOM], true);
        assert.equal(cache.rooms[ROOM].band, 'AT_TARGET');
        r = SA.stepForecast(mem.finance, SA.DEFAULT_MODELS, obs(501, 290, 1500), [ROOM], cache);
        assert.equal(r.value.fresh[ROOM], false, 'same band: cached');
        r = SA.stepForecast(mem.finance, SA.DEFAULT_MODELS, obs(502, 50, 0), [ROOM], cache);
        assert.equal(r.value.fresh[ROOM], true, 'crossed below the lower reserve: recomputed');
        assert.equal(cache.rooms[ROOM].band, 'BELOW_LOWER');
        assert.equal(r.value.rooms[ROOM].signals.stabilize, true);
    });
}

module.exports = { defineUnitTests };
