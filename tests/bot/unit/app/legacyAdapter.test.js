const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLegacyAdapter } = require('../../../../src/bot/integration/LegacyAdapter');
const { createFakeLegacy, EXPECTED_INIT, expectedLoop } = require('../../support/fakeLegacy');

function game(creeps) {
    const map = {};
    for (const n of creeps) map[n] = { name: n };
    return { creeps: map };
}

test('first tick initialises in dist2/main.js order, then runs the loop', function () {
    const fake = createFakeLegacy();
    const adapter = createLegacyAdapter({ loadModules: fake.loadModules, prepareEnvironment: fake.prepareEnvironment, getGame: function () { return game(['a', 'b']); } });
    assert.deepEqual(fake.calls, [], 'creating the adapter has no side effects');
    const out = adapter.runTick(1);
    assert.deepEqual(out, { ran: true, initializedNow: true });
    assert.deepEqual(fake.calls, EXPECTED_INIT.concat(expectedLoop(['a', 'b'])));
    fake.calls.length = 0;
    assert.deepEqual(adapter.runTick(2), { ran: true, initializedNow: false });
    assert.deepEqual(fake.calls, expectedLoop(['a', 'b']), 'no second initialisation');
    assert.equal(adapter.initCount(), 1);
});

test('at most once per tick token', function () {
    const fake = createFakeLegacy();
    const adapter = createLegacyAdapter({ loadModules: fake.loadModules, prepareEnvironment: fake.prepareEnvironment, getGame: function () { return game([]); } });
    adapter.runTick(5);
    const n = fake.calls.length;
    assert.deepEqual(adapter.runTick(5), { ran: false, initializedNow: false });
    assert.equal(fake.calls.length, n);
});

test('loop errors are caught and logged by the legacy logger like dist2', function () {
    const fake = createFakeLegacy({ failOn: 'roles.run' });
    const adapter = createLegacyAdapter({ loadModules: fake.loadModules, prepareEnvironment: fake.prepareEnvironment, getGame: function () { return game(['a', 'b']); } });
    adapter.runTick(1);
    const loop = fake.calls.slice(EXPECTED_INIT.length);
    assert.deepEqual(loop, ['logger.load', 'roles.run:a', 'logger.error:Error in main loop: Error: legacy failure in roles.run']);
});

test('initialisation failure propagates and is retried next tick only', function () {
    const fake = createFakeLegacy({ initFailOn: 'resourceManager.load' });
    const adapter = createLegacyAdapter({ loadModules: fake.loadModules, prepareEnvironment: fake.prepareEnvironment, getGame: function () { return game([]); } });
    assert.throws(function () { adapter.runTick(1); }, /init failure/);
    assert.equal(adapter.isInitialized(), false);
    assert.deepEqual(adapter.runTick(1), { ran: false, initializedNow: false }, 'same tick not retried');
    fake.calls.length = 0;
    assert.deepEqual(adapter.runTick(2), { ran: true, initializedNow: true });
    assert.deepEqual(fake.calls, EXPECTED_INIT.concat(expectedLoop([])));
});

test('adapter source does not import dist2/main.js and requires dist2 lazily', function () {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../../src/bot/integration/LegacyAdapter.js'), 'utf8');
    assert.equal(/dist2\/main['"]/.test(src), false);
    // every require of dist2 is indented (inside a function body), none at column 0
    const lines = src.split('\n').filter(function (l) { return /require\(['"][^'"]*dist2/.test(l); });
    assert.ok(lines.length >= 13);
    for (const l of lines) assert.match(l, /^\s{4,}/, l);
});

test('the adapter reproduces the dist2/main.js call sequence (source cross-check)', function () {
    const main = fs.readFileSync(path.resolve(__dirname, '../../../../dist2/main.js'), 'utf8');
    const initOrder = (main.match(/^(\w+)\.initialize\(\)/gm) || []).map(function (s) { return s.replace('.initialize()', ''); });
    assert.deepEqual(initOrder, ['buildController', 'sourceController', 'spawnController', 'roomController']);
    const reconcileOrder = (main.match(/(\w+)\.reconcile\(\)/g) || []).map(function (s) { return s.replace('.reconcile()', ''); });
    assert.deepEqual(reconcileOrder, ['sourceController', 'spawnController', 'roomController', 'buildController']);
    const registrations = (main.match(/registerResourceType\("(\w+)"/g) || []).map(function (s) { return s.replace(/.*\("/, '').replace('"', ''); });
    assert.deepEqual(registrations, ['source', 'spawnProcess', 'creepOrder', 'constructionOrder']);
    const requires = (main.match(/require\(["']([^"']+)["']\)/g) || []).map(function (s) { return s.replace(/require\(["']\.?\/?/, '').replace(/["']\)/, ''); });
    assert.deepEqual(requires, ['mapPatch', 'roles', 'logger', 'resourceManager', 'resources.sourceResource', 'SourceController', 'SpawnController', 'resources.spawnProcess', 'resources.creepOrder', 'RoomController', 'BuildController', 'resources.constructionOrder', 'js-yaml']);
    const adapter = fs.readFileSync(path.resolve(__dirname, '../../../../src/bot/integration/LegacyAdapter.js'), 'utf8');
    const adapterRequires = (adapter.match(/require\('\.\.\/\.\.\/\.\.\/dist2\/([^']+)'\)/g) || []).map(function (s) { return s.replace(/.*dist2\//, '').replace("')", ''); });
    // applyDist2Environment() requires mapPatch; loadDist2Modules() calls it first, then the rest in dist2 order
    assert.deepEqual(adapterRequires, requires);
    assert.match(adapter, /function loadDist2Modules\(\) \{\n\s+applyDist2Environment\(\);/);
});
