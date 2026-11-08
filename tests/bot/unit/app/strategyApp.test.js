const test = require('node:test');
const assert = require('node:assert/strict');
const { createStrategyApp } = require('../../../../src/bot/app/StrategyApp');
const { createLegacyAdapter } = require('../../../../src/bot/integration/LegacyAdapter');
const { createRuntimePorts } = require('../../../../src/bot/app/ports');
const { READY } = require('../../../../src/bot/domain/results');
const { fingerprint } = require('../../../../src/bot/domain/fingerprint');
const { createTrapGame, createTrapMemory } = require('../../support/trapRuntime');
const { createFakeLegacy, EXPECTED_INIT, expectedLoop } = require('../../support/fakeLegacy');

function setup(options) {
    const o = options || {};
    const trapGame = createTrapGame({ time: o.time || 100, creeps: { a: { name: 'a' } }, rooms: { W5N8: { name: 'W5N8' } } });
    const trapMemory = createTrapMemory({}, { allowedRootKeys: [] });
    const lines = [];
    const ports = createRuntimePorts({ getGame: function () { return trapGame.Game; }, getMemory: function () { return trapMemory.Memory; }, sink: function (l) { lines.push(l); } });
    const fake = createFakeLegacy(o.legacy);
    const legacy = createLegacyAdapter({ loadModules: fake.loadModules, prepareEnvironment: fake.prepareEnvironment, getGame: function () { return trapGame.raw; } });
    const app = createStrategyApp({
        ports: { clock: ports.clock, cpu: ports.cpu, log: ports.log },
        legacy: legacy,
        listRoomNames: function () { return ports.gameRead.roomNames(); },
        components: o.components || [],
        stateApi: o.stateApi || null,
        buildInfo: { buildId: 'b-test', contractVersion: 'A.3', schemaVersion: 1 },
    });
    return { app: app, fake: fake, trapGame: trapGame, trapMemory: trapMemory, lines: lines, legacy: legacy };
}

test('creating the app has no side effects', function () {
    const s = setup();
    assert.deepEqual(s.fake.calls, []);
    assert.deepEqual(s.trapGame.journal.reads, []);
    assert.deepEqual(s.trapMemory.journal.reads, []);
});

test('stage-A pipeline order: environment, router, observe stub, legacy, close', function () {
    const s = setup();
    assert.deepEqual(s.app.plan().map(function (c) { return c.phase + ':' + c.name; }), [
        'BOOT:boot.environment', 'BOOT:boot.router', 'OBSERVE:observe.snapshot', 'EXECUTE:execute.legacy', 'CLOSE:close.report',
    ]);
    const report = s.app.tick();
    assert.deepEqual(report.entries.map(function (e) { return e.component + '=' + e.kind; }), [
        'boot.environment=READY', 'boot.router=READY', 'observe.snapshot=UNKNOWN', 'execute.legacy=READY', 'close.report=READY',
    ]);
    assert.equal(report.results['boot.router'].value.rooms.W5N8.effectiveOwner, 'legacy');
    assert.equal(report.results['observe.snapshot'].reason, 'UNSUPPORTED_CAPABILITY');
    assert.deepEqual(s.fake.calls, ['mapPatch'].concat(EXPECTED_INIT, expectedLoop(['a'])));
    assert.deepEqual(s.trapGame.journal.violations, []);
    assert.deepEqual(s.trapMemory.journal.writes, [], 'A0 new system writes no Memory');
});

test('legacy runs exactly once per tick; init once per app (global)', function () {
    const s = setup();
    for (let i = 0; i < 3; i++) s.app.tick();
    assert.equal(s.fake.calls.filter(function (c) { return c === 'resourceManager.save'; }).length, 3);
    assert.equal(s.fake.calls.filter(function (c) { return c === 'resourceManager.load'; }).length, 1);
    assert.equal(s.legacy.initCount(), 1);
});

test('extra components may not run before legacy EXECUTE', function () {
    for (const phase of ['BOOT', 'OBSERVE', 'CRITICAL']) {
        assert.throws(function () { setup({ components: [{ name: 'x', phase: phase, run: function () { return READY(null, fingerprint(0)); } }] }); }, /before legacy EXECUTE/, phase);
    }
    const s = setup({ components: [{ name: 'reconcile.x', phase: 'RECONCILE', run: function () { return READY(null, fingerprint(0)); } }] });
    const order = s.app.plan().map(function (c) { return c.name; });
    assert.ok(order.indexOf('reconcile.x') > order.indexOf('execute.legacy'), 'RECONCILE runs after legacy in stage A');
});

test('shadow components receive no gameRead, MemoryPort or gateway', function () {
    const stateApi = { apply: function () { return null; }, view: function () { return null; } };
    const frames = [];
    const s = setup({ stateApi: stateApi, components: ['RECONCILE', 'FORECAST', 'PLAN', 'ADMIT', 'CLOSE'].map(function (phase) {
        return { name: 'probe.' + phase, phase: phase, run: function (frame) { frames.push(frame); return READY(null, fingerprint(0)); } };
    }) });
    s.app.tick();
    assert.equal(frames.length, 5);
    function walk(value, path, seen) {
        if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
        seen.add(value);
        for (const key of Object.keys(value)) {
            assert.equal(['gateway', 'gameRead', 'memory', 'Game', 'Memory', 'getGame', 'getMemory'].indexOf(key), -1, 'forbidden key ' + path + '.' + key);
            const v = value[key];
            if (v && typeof v === 'object') {
                assert.ok(!(typeof v.write === 'function' && typeof v.namespace === 'string'), 'MemoryPort at ' + path + '.' + key);
                assert.ok(!(typeof v.roomNames === 'function' || typeof v.getObjectById === 'function'), 'GameReadPort at ' + path + '.' + key);
            }
            walk(v, path + '.' + key, seen);
        }
    }
    for (const frame of frames) {
        walk(frame, 'frame', new Set());
        assert.deepEqual(Object.keys(frame.services).sort(), ['clock', 'cpu', 'log', 'state']);
        assert.equal(frame.services.state, stateApi);
    }
});

test('shadow component exception does not prevent legacy or CLOSE', function () {
    const s = setup({ components: [
        { name: 'shadow.reconcile', phase: 'RECONCILE', run: function () { throw new Error('shadow boom'); } },
        { name: 'shadow.plan', phase: 'PLAN', run: function () { throw new Error('plan boom'); } },
    ] });
    const report = s.app.tick();
    const byName = report.results;
    assert.equal(byName['shadow.reconcile'].reasonCode, 'COMPONENT_FAULT');
    assert.equal(byName['shadow.plan'].reasonCode, 'COMPONENT_FAULT');
    assert.equal(byName['execute.legacy'].kind, 'READY');
    assert.equal(byName['close.report'].kind, 'READY');
    assert.equal(s.fake.calls.filter(function (c) { return c === 'resourceManager.save'; }).length, 1);
});

test('legacy failure (loop or init) does not prevent shadow components or CLOSE', function () {
    let shadowRuns = 0;
    const shadow = { name: 'shadow.plan', phase: 'PLAN', run: function () { shadowRuns++; return READY(null, fingerprint(1)); } };
    const loopFail = setup({ legacy: { failOn: 'spawnController.reconcile' }, components: [shadow] });
    const r1 = loopFail.app.tick();
    assert.equal(r1.results['execute.legacy'].kind, 'READY', 'legacy catches its own loop errors like dist2');
    assert.ok(loopFail.fake.calls.some(function (c) { return c.indexOf('logger.error:Error in main loop') === 0; }));
    assert.equal(r1.results['close.report'].kind, 'READY');

    const initFail = setup({ legacy: { initFailOn: 'buildController.initialize' }, components: [Object.assign({}, shadow, { name: 'shadow.plan2' })] });
    const r2 = initFail.app.tick();
    assert.equal(r2.results['execute.legacy'].reasonCode, 'COMPONENT_FAULT');
    assert.equal(r2.results['shadow.plan2'].kind, 'READY');
    assert.equal(r2.results['close.report'].value.legacy, 'REJECTED');
    assert.equal(initFail.fake.calls.filter(function (c) { return c === 'resourceManager.save'; }).length, 0, 'no loop after failed init in that tick');
    const r3 = initFail.app.tick();
    assert.equal(r3.results['execute.legacy'].kind, 'READY', 'init retried on next tick despite earlier fault (bypassCooldown)');
    assert.equal(initFail.fake.calls.filter(function (c) { return c === 'resourceManager.save'; }).length, 1);
    assert.equal(shadowRuns, 3);
});

test('runner defect still runs legacy once via the safety net', function () {
    const s = setup();
    // Break the clock port so runTick throws before any component.
    const brokenApp = createStrategyApp({
        ports: { clock: { tick: function () { throw new Error('clock broken'); } }, cpu: { read: function () { return { used: 1, limit: 20, tickLimit: 500, bucket: 1, missingFields: [] }; } }, log: { warn: function () {}, error: function () {}, beginTick: function () {} } },
        legacy: s.legacy,
    });
    brokenApp.tick(1);
    assert.equal(s.fake.calls.filter(function (c) { return c === 'resourceManager.save'; }).length, 1);
    brokenApp.tick(1);
    assert.equal(s.fake.calls.filter(function (c) { return c === 'resourceManager.save'; }).length, 1, 'same token does not run twice');
});

test('observe hook (A1 Reader) runs before legacy in the same tick; its result is visible to later components', function () {
    const trapGame = createTrapGame({ time: 5, creeps: {} });
    const ports = createRuntimePorts({ getGame: function () { return trapGame.Game; }, sink: function () {} });
    const fake = createFakeLegacy();
    const legacy = createLegacyAdapter({ loadModules: fake.loadModules, prepareEnvironment: fake.prepareEnvironment, getGame: function () { return trapGame.raw; } });
    let legacyCallsAtObserve = null;
    let seenByPlan = null;
    let budgetSeen = null;
    const app = createStrategyApp({
        ports: ports,
        legacy: legacy,
        observe: function (frame, observationBudget) {
            budgetSeen = observationBudget; legacyCallsAtObserve = fake.calls.filter(function (c) { return c !== 'mapPatch'; }).length; return READY({ tick: 5 }, fingerprint(5)); },
        components: [{ name: 'shadow.plan', phase: 'PLAN', run: function (frame) { seenByPlan = frame.result('observe.snapshot'); return READY(null, fingerprint(0)); } }],
    });
    app.tick();
    assert.equal(legacyCallsAtObserve, 0, 'no legacy call before OBSERVE');
    assert.equal(budgetSeen.ceilingCpu, 3, 'observe gets a scoped stage-A CPU ceiling');
    assert.equal(seenByPlan.kind, 'READY');
    assert.ok(fake.calls.indexOf('resourceManager.save') !== -1);
});
