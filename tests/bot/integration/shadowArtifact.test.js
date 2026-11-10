// STRAT-A5 acceptance on the BUILT artifact (test build: fake dist2, real main/app/stageA/
// shadow pipeline) driven tick by tick through the Screeps-like loader over a simulated
// world. Criteria numbering follows the A5 brief (i)..(viii).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildShadowTestArtifact, createRun, strategyWithControl, prototypeFingerprint, STRATEGY_KEYS } = require('./support/artifact');
const { createSim, ROOM } = require('./support/simWorld');
const replay = require('../../../tools/replay');
const { ROOT } = require('../../../tools/build-strategy');

let artifact;
test.before(async function () { artifact = await buildShadowTestArtifact(); });

function legacyMemory(sim, extra) {
    return Object.assign({ creeps: sim.legacyCreepMemory(), resourceManager: { resources: { creepOrder: { o1: { role: 'mule' } } } }, rooms: { W1N1: { legacy: true } }, spawns: {}, flags: {} }, extra || {});
}

function shadowRun(simOptions, extraMemory) {
    const sim = createSim(simOptions);
    const memory = legacyMemory(sim, Object.assign({ strategy: strategyWithControl({ W1N1: 'shadow' }) }, extraMemory || {}));
    if (simOptions && simOptions.spawnAt) memory.creeps[simOptions.spawnAt.name] = { role: simOptions.spawnAt.role };
    return createRun({ text: artifact.text, sim: sim, memory: memory });
}

function legacyKeysOf(mem) {
    const out = {};
    for (const k in mem) if (STRATEGY_KEYS.indexOf(k) === -1) out[k] = mem[k];
    return out;
}

function shadowRoom(run) { return run.mem().strategyShadow.rooms[ROOM]; }

function walkPlain(value, where, problems) {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'function' || typeof value === 'undefined') problems.push(where);
        return;
    }
    const proto = Object.getPrototypeOf(value);
    const plain = Array.isArray(value) || proto === null || Object.getPrototypeOf(proto) === null;
    if (!plain) problems.push(where);
    for (const k of Object.keys(value)) walkPlain(value[k], where + '.' + k, problems);
}

test('artifact is a marked test build with fake dist2 and the real shadow pipeline', function () {
    assert.equal(artifact.manifest.testBuild, true);
    assert.match(artifact.manifest.buildId, /^t-/);
    assert.equal(artifact.manifest.contractVersion, 'A.4');
    const paths = artifact.manifest.inputs.map(function (i) { return i.path; });
    for (const p of ['src/bot/stageA.js', 'src/bot/integration/ShadowAdapter.js', 'src/bot/planning/TravelEstimate.js', 'src/bot/telemetry/DecisionRecorder.js']) assert.ok(paths.indexOf(p) !== -1, p);
    assert.equal(paths.some(function (p) { return p.indexOf('dist2/') === 0; }), false);
});

test('(i) shadow emits no intents, writes only strategy namespaces, never reads creep.memory, leaves prototypes alone', function () {
    const run = shadowRun({ spawnAt: { tick: 1030, name: 'h2', role: 'harvester', body: ['work', 'work', 'carry', 'move'] }, ttl: { m1: 130 } });
    const before = prototypeFingerprint(run.sandbox);
    const legacyBefore = JSON.stringify(legacyKeysOf(run.mem()));
    run.ticks(60);
    assert.deepEqual(run.gameViolations(), [], 'no mutating Game call / assignment');
    assert.deepEqual(run.memoryViolations(), [], 'no write outside strategy*');
    const roots = Array.from(new Set(run.memory.journal.writes.map(function (w) { return w.where.split('.')[1]; }))).sort();
    assert.deepEqual(roots, ['strategy', 'strategyShadow']);
    assert.deepEqual(run.sim.memoryGetterReads, [], 'creep.memory getter never touched');
    assert.equal(prototypeFingerprint(run.sandbox), before, 'builtin prototypes unchanged');
    assert.equal(JSON.stringify(legacyKeysOf(run.mem())), legacyBefore, 'legacy Memory byte-identical');
    assert.equal(run.count('resourceManager.save'), 60, 'legacy ran every tick');
    const m = run.mem();
    assert.equal(m.strategy.lastClosedTick, 1059, 'CLOSE wrote lastClosedTick of the last tick');
    const room = m.strategyShadow.rooms[ROOM];
    assert.equal(room.forecast.roomName, ROOM);
    assert.ok(room.decisionRing.length >= 2 && room.decisionRing.length <= 100);
    for (const r of room.decisionRing) { assert.equal(r.executed, false); assert.equal(r.mode, 'shadow'); }
    const proposals = Object.values(m.strategyShadow.proposals);
    assert.ok(proposals.length >= 1, 'mule replacement proposed');
    for (const p of proposals) { assert.deepEqual(p.missionPatches, []); assert.equal(p.mode, 'shadow'); }
    // legacy comparison is an explanation field of the records
    assert.ok(room.decisionRing.some(function (r) { return r.inputs.legacy && r.inputs.legacy.spawning.some(function (s) { return s.name === 'h2'; }); }), 'legacy spawn of h2 is explained');
    // significant decisions only, not one per tick
    assert.ok(room.decisionRing.length < 20, 'ring holds significant decisions only: ' + room.decisionRing.length);
});

test('(i) default legacy room: no shadow work, no snapshot, no strategy namespace written', function () {
    const sim = createSim({});
    const run = createRun({ text: artifact.text, sim: sim, memory: legacyMemory(sim) });
    run.ticks(10);
    assert.equal(run.count('resourceManager.save'), 10);
    const m = run.mem();
    assert.equal(m.strategy, undefined);
    assert.equal(m.strategyShadow, undefined);
    assert.deepEqual(run.memory.journal.writes, []);
    const finds = run.gameJournals.reduce(function (n, j) { return n + j.calls.filter(function (c) { return /find$/.test(c); }).length; }, 0);
    assert.equal(finds, 0, 'Reader not run for legacy rooms');
});

test('(ii) reset mid-run keeps identities, stores no Game refs, previous=null is a gap', function () {
    const run = shadowRun({});
    run.ticks(30);
    const before = shadowRoom(run);
    run.reset();
    run.ticks(10);
    const after = shadowRoom(run);
    assert.deepEqual(Object.keys(after.observedBindings).sort(), Object.keys(before.observedBindings).sort());
    for (const name of Object.keys(before.observedBindings)) assert.equal(after.observedBindings[name].firstSeen, before.observedBindings[name].firstSeen, name + ' identity kept');
    const problems = [];
    walkPlain(run.memory.raw.strategy, 'strategy', problems);
    walkPlain(run.memory.raw.strategyShadow, 'strategyShadow', problems);
    assert.deepEqual(problems, [], 'only plain JSON data in strategy namespaces');
    // the first tick after reset (1030) has no T-1 snapshot in heap: UNKNOWN delta, not zeros
    const w = after.flowWindows.find(function (x) { return x.windowStart === 1000; });
    assert.equal(w.quality, 'UNKNOWN');
    assert.ok(w.reasonCodes.indexOf('EVENT_GAP') !== -1);
    assert.equal(w.complete, false);
    assert.equal(w.flows.harvest.value, null, 'no fabricated zero');
    assert.equal(run.mem().strategy.lastClosedTick, 1039);
    assert.equal(run.count('resourceManager.load'), 2, 'legacy re-initialised once after reset');
});

test('(iii) operator export request -> bounded fixture in Memory -> tools/replay.js reproduces forecast and reasons', function () {
    const run = shadowRun({ spawnAt: { tick: 1030, name: 'h2', role: 'harvester', body: ['work', 'work', 'carry', 'move'] }, ttl: { m1: 120 } },
        { strategyShadow: { schemaVersion: 1, rooms: {}, ledger: { reservations: {} }, observedOperations: {}, proposals: {}, exportRequest: { requested: true, ticks: 10, tickFrom: 1020 } } });
    run.ticks(70);
    const m = run.mem();
    assert.equal(m.strategyShadow.replayExport.status, 'READY', JSON.stringify(m.strategyShadow.replayExport.detail));
    assert.deepEqual(m.strategyShadow.exportRequest, { requested: true, ticks: 10, tickFrom: 1020 }, 'operator request untouched');
    const got = replay.extractFixtureFromMemory(m);
    assert.ok(got.fixture);
    assert.equal(got.fixture.body.snapshots.length, 11);
    assert.equal(got.fixture.header.policyVersion, 'shadow-a5.1');
    assert.ok(Object.keys(got.fixture.body.expectedForecast).length === 1);
    const result = replay.runFixture(JSON.parse(JSON.stringify(got.fixture)));
    assert.equal(result.pipeline, 'shadow-a5');
    assert.equal(result.status, 'REPRODUCED', JSON.stringify(result.mismatches).slice(0, 2000));
    assert.deepEqual(result.reasonCodes, got.fixture.body.expectedReasonCodes);
    // CLI: extract from a Memory dump, then replay
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strat-a5-replay-'));
    fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(m));
    const tool = path.join(ROOT, 'tools', 'replay.js');
    execFileSync(process.execPath, [tool, '--extract', path.join(dir, 'memory.json'), '--out', path.join(dir, 'fixture.json')]);
    const out = JSON.parse(execFileSync(process.execPath, [tool, path.join(dir, 'fixture.json')]).toString());
    assert.equal(out.status, 'REPRODUCED');
    // a changed expectation is detected
    const tampered = JSON.parse(JSON.stringify(got.fixture));
    tampered.body.expectedForecast[ROOM].freeEnergyNow.value += 1;
    tampered.header.contentFingerprint = require('../../../src/bot/domain/fingerprint').fingerprint(tampered.body);
    assert.equal(replay.runFixture(tampered).status, 'MISMATCH');
    // the same request is not exported again
    run.ticks(5);
    assert.equal(run.mem().strategyShadow.replayExport.completedAt, m.strategyShadow.replayExport.completedAt);
});

test('(iv) missing or malformed event logs are gaps: no complete window, no confirmed effect for those ticks', function () {
    const run = shadowRun({ eventLog: function (t) { return t === 1012 ? 'missing' : t === 1015 ? 'garbage' : 'normal'; } });
    run.ticks(25);
    const room = shadowRoom(run);
    const w = room.flowWindows.find(function (x) { return x.windowStart === 1000; });
    assert.equal(w.quality, 'UNKNOWN');
    assert.equal(w.complete, false);
    assert.ok(w.reasonCodes.indexOf('EVENT_GAP') !== -1);
    for (const k of Object.keys(w.flows)) assert.equal(w.flows[k].value, null, k + ' stays UNKNOWN');
    const ops = run.mem().strategyShadow.observedOperations;
    for (const key of Object.keys(ops)) {
        for (const ek of ops[key].eventKeys) assert.ok(!/:(1011|1014):/.test(ek), 'no effect confirmed from a lost log: ' + ek);
    }
    assert.notEqual(room.forecast.incomeLowerPerTick.quality, 'DERIVED', 'income not derived from a gapped history');
});

test('(v) finance: transfers are internal, income is harvest only, explained in the decision log', function () {
    const run = shadowRun({});
    run.ticks(420);
    const room = shadowRoom(run);
    const complete = room.flowWindows.filter(function (w) { return w.complete; });
    assert.ok(complete.length >= 3);
    for (const w of complete) {
        assert.ok(w.flows.internalTransfer.value > 0, 'transfers observed');
        assert.equal(w.flows.unexplained.value, 0, 'balance explained');
        assert.equal(w.flows.externalIn.value, 0);
    }
    const last3 = complete.slice(-3);
    const minIncome = Math.min.apply(null, last3.map(function (w) { return w.flows.harvest.value + w.flows.externalIn.value; }));
    assert.equal(room.forecast.incomeLowerPerTick.quality, 'DERIVED');
    assert.equal(room.forecast.incomeLowerPerTick.value, minIncome / 100, 'income = harvest lower bound, transfer never income');
    const rec = room.decisionRing[room.decisionRing.length - 1];
    assert.equal(rec.inputs.balance.window.income, last3[2].flows.harvest.value);
    assert.equal(rec.inputs.balance.window.internal, last3[2].flows.internalTransfer.value);
    assert.equal(rec.inputs.balance.window.unexplained, 0);
});

test('(vi) adaptive-v1 request: legacy keeps running, UNSUPPORTED_CAPABILITY, no shadow work', function () {
    const sim = createSim({});
    const memory = legacyMemory(sim, { strategy: strategyWithControl({ W1N1: 'adaptive-v1' }) });
    const run = createRun({ text: artifact.text, sim: sim, memory: memory });
    const strategyBefore = JSON.stringify(run.mem().strategy);
    run.ticks(5);
    assert.equal(run.count('resourceManager.save'), 5);
    assert.ok(run.consoleLines().some(function (l) { return l.indexOf('SHADOW_ROUTE_REJECTED') !== -1 && l.indexOf('UNSUPPORTED_CAPABILITY') !== -1; }));
    assert.equal(run.mem().strategyShadow, undefined);
    assert.equal(JSON.stringify(run.mem().strategy), strategyBefore);
    assert.deepEqual(run.gameViolations(), []);
});

test('(vii) shadow exception: legacy unaffected, COMPONENT_FAULT recorded, pipeline recovers', function () {
    const run = shadowRun({});
    run.ticks(5);
    run.sandbox.context.__shadowFail = true;
    run.ticks(2);   // 2 consecutive failures: below the breaker threshold; input changes every tick -> retried
    run.sandbox.context.__shadowFail = false;
    run.ticks(33);
    assert.equal(run.count('resourceManager.save'), 40);
    assert.ok(run.consoleLines().some(function (l) { return l.indexOf('COMPONENT_FAULT') !== -1 && l.indexOf('plan.shadow') !== -1; }));
    const ring = shadowRoom(run).decisionRing;
    assert.ok(ring.some(function (r) { return r.reasonCode === 'COMPONENT_FAULT' && r.inputs.interruption.component === 'plan.shadow'; }));
    assert.equal(ring[ring.length - 1].inputs.interruption, undefined, 'normal decisions again after the fault');
    assert.equal(run.mem().strategy.lastClosedTick, 1039);
    assert.deepEqual(run.gameViolations(), []);
});

test('(vii) CPU shortage: shadow deferred, legacy unaffected, BUDGET_DEFERRED recorded', function () {
    const run = shadowRun({ cpu: function (t) {
        if (t === 1010 || t === 1011) return { used: 1, limit: 20, tickLimit: 500, bucket: 500 };      // bucket below minShadowBucket: all shadow deferred
        if (t === 1020) return { used: 11.5, limit: 20, tickLimit: 500, bucket: 10000 };               // ceiling 13: reconcile (prior 5) does not fit, CLOSE (prior 1) does
        return { used: 1, limit: 20, tickLimit: 500, bucket: 10000 };
    } });
    run.ticks(25);
    assert.equal(run.count('resourceManager.save'), 25);
    const ring = shadowRoom(run).decisionRing;
    const lost = ring.find(function (r) { return r.tick === 1012 && r.reasonCode === 'BUDGET_DEFERRED'; });
    assert.ok(lost, 'ticks lost to the budget recorded on the next CLOSE');
    assert.deepEqual([lost.inputs.interruption.from, lost.inputs.interruption.to], [1010, 1011]);
    const same = ring.find(function (r) { return r.tick === 1020 && r.reasonCode === 'BUDGET_DEFERRED'; });
    assert.ok(same, 'deferral inside the tick recorded by CLOSE');
    assert.equal(same.resultKind, 'DEFERRED');
    assert.equal(run.mem().strategy.lastClosedTick, 1024);
});

test('(viii) incompatible Memory.strategy: shadow suspended, namespace untouched, legacy runs', function () {
    const sim = createSim({});
    const memory = legacyMemory(sim, { strategy: { schemaVersion: 99, control: { rooms: { W1N1: { requestedMode: 'shadow' } } }, future: [1, 2, 3] } });
    const run = createRun({ text: artifact.text, sim: sim, memory: memory });
    const before = JSON.stringify(run.mem().strategy);
    run.ticks(6);
    assert.equal(JSON.stringify(run.mem().strategy), before, 'byte-identical');
    assert.equal(run.mem().strategyShadow, undefined);
    assert.equal(run.count('resourceManager.save'), 6);
    assert.ok(run.consoleLines().some(function (l) { return l.indexOf('STATE_INCOMPATIBLE') !== -1; }));
    assert.deepEqual(run.memory.journal.writes, []);
});

test('(iii) an export that would exceed the Memory bound fails explicitly (FAILED, BUDGET_DEFERRED), nothing partial', function () {
    const run = shadowRun({}, { strategyShadow: { schemaVersion: 1, rooms: {}, ledger: { reservations: {} }, observedOperations: {}, proposals: {}, exportRequest: { requested: true, ticks: 40 } } });
    run.ticks(70);
    const exp = run.mem().strategyShadow.replayExport;
    assert.equal(exp.status, 'FAILED');
    assert.equal(exp.reasonCode, 'BUDGET_DEFERRED');
    assert.equal(exp.fixture, null);
    assert.ok(exp.detail.sizeChars > exp.detail.limitChars);
    assert.deepEqual(run.memoryViolations(), []);
});

// ---------------------------------------------------------------- review regressions (STRAT-A5 review)

const ARMED = [{ id: 'hostile1', owner: { username: 'enemy' }, pos: { roomName: ROOM, x: 40, y: 40 }, body: [{ type: 'attack', hits: 100 }], hits: 100, hitsMax: 100 }];
function siegeHostiles(t) { return t >= 1005 && t <= 1009 ? ARMED : []; }
function modeAt(ring, tick) {
    let mode = null;
    for (const r of ring) if (r.tick <= tick && r.inputs.gov) mode = r.inputs.gov.mode;
    return mode;
}

test('review 1a: SIEGE exit never counts ticks whose forecast/plan were deferred (reconcile admitted)', function () {
    // ceiling 13. The loader's getUsed is constant, so measured costs are 0 and the estimates
    // decay from their priors while a component runs (0.98/run peak): after 20 runs reconcile
    // ~3.3 and forecast ~6.7. At used=8 reconcile (and CLOSE) still fit, forecast does not and,
    // being deferred, never decays further -> plan/admit are never evaluated for 92 ticks.
    const run = shadowRun({ hostiles: siegeHostiles, cpu: function (t) { return { used: t >= 1020 && t <= 1111 ? 8 : 1, limit: 20, tickLimit: 500, bucket: 10000 }; } });
    run.ticks(116); // through 1115
    const ring = shadowRoom(run).decisionRing;
    assert.equal(modeAt(ring, 1010), 'SIEGE');
    const cut = ring.find(function (r) { return r.inputs.interruption && r.tick >= 1020 && r.tick <= 1111; });
    assert.ok(cut, 'interruption recorded');
    assert.deepEqual(cut.inputs.gov.hold, { mode: 'SIEGE', clearSince: null }, 'clear streak reset and persisted');
    assert.equal(modeAt(ring, 1115), 'SIEGE', 'only 4 evaluated clear ticks since 1112: no exit');
    assert.equal(run.mem().strategy.lastClosedTick, 1115, 'reconcile kept closing ticks');
    run.ticks(100); // 1116..1215: 100+ evaluated clear ticks
    assert.equal(modeAt(shadowRoom(run).decisionRing, 1215), 'GROW', 'exit after 100 evaluated clear ticks');
});

test('review 1b + 5: a room taken out of shadow restarts the count on re-enable; its proposals are deleted meanwhile', function () {
    const run = shadowRun({ hostiles: siegeHostiles, ttl: { m1: 130 } }, { strategy: strategyWithControl({ W1N1: 'shadow', W2N2: 'shadow' }) });
    run.ticks(20); // 1000..1019
    const proposalsOf = function () { return Object.values(run.mem().strategyShadow.proposals).filter(function (p) { return p.roomName === ROOM; }); };
    assert.ok(proposalsOf().length >= 1, 'W1N1 has proposals while in shadow');
    run.memory.raw.strategy.control.rooms.W1N1.requestedMode = 'legacy'; // operator console edit
    run.ticks(86); // 1020..1105, W2N2 keeps lastClosedTick advancing
    assert.equal(run.mem().strategy.lastClosedTick, 1105);
    assert.deepEqual(proposalsOf(), [], 'proposals of a room no longer in shadow deleted by planning');
    run.memory.raw.strategy.control.rooms.W1N1.requestedMode = 'shadow';
    run.ticks(10); // 1106..1115
    const ring = shadowRoom(run).decisionRing;
    assert.equal(modeAt(ring, 1115), 'SIEGE', 'records from before the shadow window are not continuous');
    const last = ring[ring.length - 1];
    assert.ok(last.inputs.gov.hold.clearSince >= 1106, 'count restarted inside the new shadow window: ' + last.inputs.gov.hold.clearSince);
    assert.deepEqual(run.memoryViolations(), []);
});

test('review 6: a finished replay export expires after the TTL (fixture dropped, request not re-run)', function () {
    const { fingerprint } = require('../../../src/bot/domain/fingerprint');
    const request = { requested: true, ticks: 3 };
    const done = { requestFingerprint: fingerprint(request), status: 'FAILED', startedAt: 10, completedAt: 20, reasonCode: 'BUDGET_DEFERRED', detail: null, fixture: null };
    const run = shadowRun({ time: 5000 }, { strategyShadow: { schemaVersion: 1, rooms: {}, ledger: { reservations: {} }, observedOperations: {}, proposals: {}, exportRequest: request, replayExport: done } });
    run.ticks(40);
    const exp = run.mem().strategyShadow.replayExport;
    assert.equal(exp.status, 'EXPIRED');
    assert.equal(exp.fixture, null);
    assert.equal(exp.requestFingerprint, done.requestFingerprint);
    assert.equal(exp.detail.was, 'FAILED');
});
