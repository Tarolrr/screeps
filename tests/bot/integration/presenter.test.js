// STRAT-VIEW presentation on the BUILT artifact (test build: fake dist2, real main/app/
// stageA/shadow pipeline/presenter) in the Screeps-like loader with trap Game/Memory and a
// recording fake RoomVisual global.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildShadowTestArtifact, createRun, strategyWithControl, STRATEGY_KEYS } = require('./support/artifact');
const { createSim, ROOM } = require('./support/simWorld');
const { createRoomVisualRecorder } = require('../support/trapRuntime');

let artifact;
test.before(async function () { artifact = await buildShadowTestArtifact(); });

function legacyMemory(sim, extra) {
    return Object.assign({ creeps: sim.legacyCreepMemory(), resourceManager: { resources: { creepOrder: { o1: { role: 'mule' } } } }, rooms: { W1N1: { legacy: true } }, spawns: {}, flags: {} }, extra || {});
}

function legacyKeysOf(mem) {
    const out = {};
    for (const k in mem) if (STRATEGY_KEYS.indexOf(k) === -1 && k !== 'strategyView') out[k] = mem[k];
    return out;
}

function viewRun(simOptions, extraMemory, options) {
    const sim = createSim(simOptions);
    const visual = createRoomVisualRecorder();
    const memory = legacyMemory(sim, Object.assign({ strategy: strategyWithControl({ W1N1: 'shadow' }) }, extraMemory || {}));
    if (simOptions && simOptions.spawnAt) memory.creeps[simOptions.spawnAt.name] = { role: simOptions.spawnAt.role };
    const run = createRun(Object.assign({ text: artifact.text, sim: sim, memory: memory, globals: { RoomVisual: visual.RoomVisual } }, options || {}));
    run.visual = visual.journal;
    return run;
}

function rootsWritten(journal) {
    return Array.from(new Set(journal.writes.map(function (w) { return w.where.split('.')[1]; }))).sort();
}

function shadowLines(run) {
    return run.consoleLines().filter(function (l) { return l.indexOf('[shadow ') === 0; });
}

test('overlay on: draw ops via RoomVisual, no intents, legacy Memory identical, presenter writes no Memory', function () {
    const run = viewRun({ spawnAt: { tick: 1030, name: 'h2', role: 'harvester', body: ['work', 'work', 'carry', 'move'] }, ttl: { m1: 130 } }, { strategyView: { rooms: { W1N1: { overlay: true } } } });
    const legacyBefore = JSON.stringify(legacyKeysOf(run.mem()));
    const viewBefore = JSON.stringify(run.mem().strategyView);
    const perTick = [];
    for (let i = 0; i < 60; i++) { const n = run.visual.ops.length; run.tick(); perTick.push(run.visual.ops.length - n); }
    assert.deepEqual(run.gameViolations(), [], 'no mutating Game call / assignment');
    assert.deepEqual(run.memoryViolations(), [], 'no write outside strategy*');
    assert.deepEqual(rootsWritten(run.memory.journal), ['strategy', 'strategyShadow'], 'Memory writes only in strategy namespaces');
    assert.equal(run.memory.journal.writes.some(function (w) { return w.where.indexOf('Memory.strategyView') === 0; }), false, 'Memory.strategyView never written by the loop');
    assert.equal(JSON.stringify(run.mem().strategyView), viewBefore);
    assert.equal(JSON.stringify(legacyKeysOf(run.mem())), legacyBefore, 'legacy Memory byte-identical');
    assert.equal(run.count('resourceManager.save'), 60);
    assert.ok(perTick.every(function (n) { return n > 0 && n <= 64; }), 'bounded ops every tick: ' + perTick.join(','));
    assert.ok(run.visual.ops.every(function (o) { return o.room === ROOM; }));
    const texts = run.visual.ops.filter(function (o) { return o.shape === 'text'; }).map(function (o) { return o.args[0]; });
    assert.ok(texts.some(function (t) { return /^W1N1 shadow [A-Z]+ since t\d+/.test(t); }), 'panel head');
    assert.ok(texts.some(function (t) { return /^free /.test(t); }));
    assert.ok(texts.some(function (t) { return /^legacy: (idle|harvester h2)$/.test(t); }), 'legacy actual at the spawn');
    assert.ok(texts.some(function (t) { return /^shadow: /.test(t); }), 'shadow proposal at the spawn');
    assert.ok(texts.some(function (t) { return /^harvester \d+$/.test(t); }), 'creep label role + TTL');
    assert.ok(texts.some(function (t) { return /^legacy: harvester h2$/.test(t); }), 'legacy spawn of h2 shown while spawning: ' + Array.from(new Set(texts.filter(function (t) { return /^legacy/.test(t); }))).join('/'));
});

test('overlay is off by default and console event lines are emitted only on change', function () {
    const run = viewRun({ ttl: { m1: 130 } });
    run.ticks(80);
    assert.deepEqual(run.visual.constructed, [], 'no RoomVisual without the operator flag');
    const lines = shadowLines(run);
    assert.ok(lines.length >= 1 && lines.length < 15, lines.join('\n'));
    for (const l of lines) assert.match(l, /^\[shadow W1N1 t\d+\] <span style="color:#[0-9a-f]{6}">/);
    assert.equal(new Set(lines.map(function (l) { return l.replace(/ t\d+\]/, ']'); })).size, lines.length, 'no line repeated');
    const perTick = {};
    for (const l of lines) { const t = l.match(/ t(\d+)\]/)[1]; perTick[t] = (perTick[t] || 0) + 1; }
    assert.ok(Object.values(perTick).every(function (n) { return n <= 5; }), 'at most 5 lines per tick');
    assert.ok(lines.some(function (l) { return /mode [A-Z]+/.test(l); }), 'mode announced');
    assert.deepEqual(run.memoryViolations(), []);
});

test('a global reset does not repeat earlier console lines', function () {
    const run = viewRun({});
    run.ticks(30);
    const before = shadowLines(run).length;
    assert.ok(before >= 1);
    run.reset();
    run.ticks(10);
    assert.deepEqual(shadowLines(run), [], 'fresh heap after reset: nothing re-announced');
});

test('legacy room / console off: nothing drawn, no event lines, strategyView never read', function () {
    const sim = createSim({});
    const visual = createRoomVisualRecorder();
    const run = createRun({ text: artifact.text, sim: sim, memory: legacyMemory(sim, { strategyView: { rooms: { W1N1: { overlay: true } } } }), globals: { RoomVisual: visual.RoomVisual } });
    run.ticks(10);
    assert.deepEqual(visual.journal.constructed, []);
    assert.deepEqual(shadowLines(run), []);
    assert.equal(run.memory.journal.reads.some(function (r) { return r.indexOf('Memory.strategyView') === 0; }), false, 'no shadow room: flags not read');
    const quiet = viewRun({}, { strategyView: { console: false } });
    quiet.ticks(20);
    assert.deepEqual(shadowLines(quiet), []);
});

test('CPU shortage: presenter skipped (nothing drawn), legacy unaffected', function () {
    const run = viewRun({ cpu: function (t) { return t >= 1010 && t < 1015 ? { used: 1, limit: 20, tickLimit: 500, bucket: 500 } : { used: 1, limit: 20, tickLimit: 500, bucket: 10000 }; } }, { strategyView: { rooms: { W1N1: { overlay: true } } } });
    const perTick = [];
    for (let i = 0; i < 20; i++) { const n = run.visual.ops.length; run.tick(); perTick.push(run.visual.ops.length - n); }
    assert.deepEqual(perTick.slice(10, 15), [0, 0, 0, 0, 0], 'deferred under low bucket');
    assert.ok(perTick.slice(15).every(function (n) { return n > 0; }), 'resumes');
    assert.equal(run.count('resourceManager.save'), 20);
    assert.deepEqual(run.gameViolations(), []);
});

test('console commands: installed on the first loop, not at require; strat.visual writes only Memory.strategyView; strat.export validated', function () {
    const run = viewRun({}, {}, { allowedRootKeys: STRATEGY_KEYS.concat(['strategyView']) });
    assert.equal(run.sandbox.evaluate('typeof strat'), 'undefined', 'not installed at require');
    run.tick();
    assert.equal(run.sandbox.evaluate('typeof strat'), 'object', 'installed on the first loop');
    assert.equal(run.sandbox.evaluate('Object.keys(strat).sort().join()'), 'export,help,report,visual,why');
    run.ticks(5);
    const mark = run.memory.journal.writes.length;
    const answer = run.sandbox.evaluate('strat.visual("W1N1", true)');
    assert.equal(answer, 'strat: overlay W1N1 on');
    const cmdWrites = run.memory.journal.writes.slice(mark);
    assert.deepEqual(cmdWrites.map(function (w) { return w.where; }), ['Memory.strategyView']);
    assert.deepEqual(run.mem().strategyView, { rooms: { W1N1: { overlay: true } } });
    run.ticks(2);
    assert.ok(run.visual.ops.length > 0, 'overlay drawn after the command');
    // export: invalid input writes nothing; valid input writes only the operator request
    const mark2 = run.memory.journal.writes.length;
    assert.match(run.sandbox.evaluate('strat.export(0)'), /usage/);
    assert.match(run.sandbox.evaluate('strat.export(99)'), /usage/);
    assert.equal(run.memory.journal.writes.length, mark2);
    assert.match(run.sandbox.evaluate('strat.export(3)'), /requested from t\d+/);
    assert.deepEqual(run.memory.journal.writes.slice(mark2).map(function (w) { return w.where; }), ['Memory.strategyShadow.exportRequest']);
    assert.equal(run.mem().strategyShadow.exportRequest.ticks, 3);
    assert.match(run.sandbox.evaluate('strat.report("W1N1")'), /^\[shadow W1N1\] W1N1 shadow /);
    assert.match(run.sandbox.evaluate('strat.why("W1N1")'), /^\[shadow W1N1\] decision dr:W1N1:/);
    assert.match(run.sandbox.evaluate('strat.help()'), /strat\.export\(ticks\)/);
    run.ticks(10);
    assert.deepEqual(run.memoryViolations(), []);
    assert.deepEqual(run.gameViolations(), []);
    // reset: new global, commands installed again on its first loop
    run.reset();
    assert.equal(run.sandbox.evaluate('typeof strat'), 'undefined');
    run.tick();
    assert.equal(run.sandbox.evaluate('typeof strat'), 'object');
});
