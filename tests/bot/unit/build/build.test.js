// Build determinism, manifest and Screeps-loader checks of the artifact.
// Builds into temporary directories (never touches build/strategy).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { buildStrategy, ROOT } = require('../../../../tools/build-strategy');
const { createScreepsSandbox } = require('../../support/screepsLoader');
const { createTrapGame, createTrapMemory } = require('../../support/trapRuntime');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

let first;
let second;
let bundleText;

test.before(async function () {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'strat-build-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'strat-build-b-'));
    first = await buildStrategy({ outdir: dirA });
    second = await buildStrategy({ outdir: dirB });
    bundleText = fs.readFileSync(first.outFile, 'utf8');
});

test('build is deterministic', function () {
    const a = fs.readFileSync(first.outFile);
    const b = fs.readFileSync(second.outFile);
    assert.equal(sha256(a), sha256(b));
    assert.equal(fs.readFileSync(first.manifestFile, 'utf8'), fs.readFileSync(second.manifestFile, 'utf8'));
    assert.equal(first.manifest.output.sha256, sha256(a));
});

test('manifest lists every bundled module with hashes and versions', function () {
    const m = first.manifest;
    assert.match(m.buildId, /^b-[0-9a-f]{16}$/);
    assert.equal(m.contractVersion, 'A.3');
    assert.equal(m.testBuild, false);
    assert.equal(m.schemaVersion, 1);
    assert.equal(m.screepsModuleName, 'main');
    assert.equal(m.moduleCount, m.inputs.length);
    assert.equal(/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(m)), false, 'no timestamps');
    const paths = m.inputs.map(function (i) { return i.path; });
    assert.deepEqual(paths, paths.slice().sort());
    for (const input of m.inputs) {
        assert.equal(sha256(fs.readFileSync(path.join(ROOT, input.path))), input.sha256, input.path);
        assert.ok(bundleText.indexOf('// ' + input.path) !== -1, 'bundle contains ' + input.path);
    }
    for (const required of ['src/bot/main.js', 'src/bot/stageA.js', 'src/bot/integration/LegacyAdapter.js', 'dist2/mapPatch.js', 'dist2/logger.js', 'dist2/js-yaml.js', 'dist2/roles.js', 'dist2/resourceManager.js', 'dist2/BuildController.js', 'dist2/SpawnController.js', 'dist2/resources.Resource.js']) {
        assert.ok(paths.indexOf(required) !== -1, required);
    }
    assert.equal(paths.indexOf('dist2/main.js'), -1, 'dist2/main.js is never bundled');
    assert.deepEqual(m.builder.aliases, { logger: './dist2/logger.js', 'js-yaml': './dist2/js-yaml.js' });
    assert.ok(bundleText.indexOf(JSON.stringify(m.buildId)) !== -1, 'buildId injected');
});

test('artifact has no Node runtime dependency and is not strict at top level', function () {
    assert.equal(/require\(["'](?:node:)?(?:fs|path|crypto|os|child_process|module|vm)["']\)/.test(bundleText), false);
    assert.equal(/^\s*["']use strict["']/.test(bundleText), false);
    // the only free `require` calls left are none: everything is resolved into __commonJS wrappers
    assert.equal(/[^_.\w]require\(["']/.test(bundleText.replace(/\/\/.*$/gm, '')), false, 'no unresolved require() in bundle');
});

function loadArtifact(options) {
    const o = options || {};
    const sandbox = createScreepsSandbox({ modules: { main: bundleText }, Game: o.Game, Memory: o.Memory });
    return sandbox;
}

test('require("main") has zero side effects and exports loop', function () {
    const g = createTrapGame({ time: 100 });
    const m = createTrapMemory({ resourceManager: { resources: {} } }, { allowedRootKeys: [] });
    const sandbox = loadArtifact({ Game: g.Game, Memory: m.Memory });
    const exportsOfMain = sandbox.require('./main');
    assert.equal(typeof exportsOfMain.loop, 'function');
    assert.deepEqual(Object.keys(exportsOfMain), ['loop']);
    assert.deepEqual(g.journal.reads, [], 'Game not even read');
    assert.deepEqual(g.journal.calls, []);
    assert.deepEqual(m.journal.reads, [], 'Memory not even read');
    assert.deepEqual(m.journal.writes, []);
    assert.deepEqual(sandbox.consoleLines, []);
    assert.equal(sandbox.evaluate('typeof Map.prototype.toObject'), 'undefined', 'mapPatch not applied at require time');
    assert.throws(function () { sandbox.require('missing'); }, /Unknown module 'missing'/);
});

function emptyWorld(time) {
    return createTrapGame({ time: time, rooms: {}, creeps: {}, spawns: {} });
}

function countWrites(journal, where) {
    return journal.writes.filter(function (w) { return w.where === where; }).length;
}

test('loop runs the real legacy sequence once per tick; init once per global; reset re-initialises once', function () {
    const memory = createTrapMemory({}, { allowedRootKeys: '*' });
    let game = emptyWorld(101);
    const sandbox = loadArtifact({ Game: game.Game, Memory: memory.Memory });
    sandbox.require('main');

    for (let t = 101; t <= 103; t++) {
        game = emptyWorld(t);
        sandbox.setGlobals({ Game: game.Game });
        const before = countWrites(memory.journal, 'Memory.resourceManager.resources');
        sandbox.runMainLoop();
        assert.equal(countWrites(memory.journal, 'Memory.resourceManager.resources') - before, 1, 'resourceManager.save exactly once at tick ' + t);
        assert.deepEqual(game.journal.violations, [], 'no mutating Game call at tick ' + t);
    }
    const inits = sandbox.consoleLines.filter(function (l) { return l.indexOf('Initializing game state...') !== -1; });
    assert.equal(inits.length, 1, 'legacy initialised once per global');
    assert.ok(sandbox.consoleLines.some(function (l) { return l.indexOf('Initialization complete') !== -1; }));
    assert.equal(sandbox.consoleLines.filter(function (l) { return l.indexOf('Error in main loop') !== -1; }).length, 0, sandbox.consoleLines.join('\n'));
    assert.deepEqual(JSON.parse(JSON.stringify(memory.raw.loggerState)), { currentLevel: 'trace' }, 'legacy logger state written by legacy (at first loop, not require)');
    assert.ok(memory.raw.resourceManager && memory.raw.resourceManager.resources, 'legacy save ran');
    const strategyKeys = Object.keys(memory.raw).filter(function (k) { return k.indexOf('strategy') === 0; });
    assert.deepEqual(strategyKeys, [], 'A0 writes no strategy namespace');

    // dist2/mapPatch.js keeps sloppy-mode semantics inside the bundle (implicit global `result`).
    assert.equal(sandbox.evaluate("JSON.stringify(new Map([['a', 1]]).toObject())"), '{"a":1}');
    assert.equal(sandbox.evaluate('typeof result'), 'object');
    assert.equal(sandbox.evaluate('typeof Map.fromObject'), 'function');
    assert.throws(function () { sandbox.evaluate('[].flat()'); }, /initial value/, 'patched flat is active (and throws on empty arrays)');
    assert.equal(typeof Map.prototype.toObject, 'undefined', 'host realm untouched');

    // Global reset: new heap, same Memory.
    const reset = loadArtifact({ Game: emptyWorld(104).Game, Memory: memory.Memory });
    const writesBefore = memory.journal.writes.length;
    const readsBefore = memory.journal.reads.length;
    reset.require('main');
    assert.equal(memory.journal.writes.length, writesBefore, 'require after reset writes nothing');
    assert.equal(memory.journal.reads.length, readsBefore, 'require after reset reads nothing');
    reset.runMainLoop();
    reset.setGlobals({ Game: emptyWorld(105).Game });
    reset.runMainLoop();
    assert.equal(reset.consoleLines.filter(function (l) { return l.indexOf('Initializing game state...') !== -1; }).length, 1, 'reset re-initialises legacy exactly once');
});

test('legacy reads only Memory it owned before; new code reads no legacy Memory', function () {
    const memory = createTrapMemory({ creeps: {}, resourceManager: { resources: {} } }, { allowedRootKeys: '*' });
    const sandbox = loadArtifact({ Game: emptyWorld(110).Game, Memory: memory.Memory });
    sandbox.require('main');
    sandbox.runMainLoop();
    const roots = Array.from(new Set(memory.journal.writes.map(function (w) { return w.where.split('.')[1]; }))).sort();
    assert.deepEqual(roots, ['loggerState', 'resourceManager'], 'only legacy namespaces written (by legacy)');
});

test('build refuses Node builtins', async function () {
    const esbuild = require('esbuild');
    const { noNodeBuiltins } = require('../../../../tools/build-strategy');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strat-builtin-'));
    for (const name of ['fs', 'node:path', 'crypto/foo']) {
        const entry = path.join(dir, 'entry.js');
        fs.writeFileSync(entry, "module.exports = require('" + name + "');\n");
        await assert.rejects(esbuild.build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'neutral', write: false, logLevel: 'silent', plugins: [noNodeBuiltins] }), /not available in the Screeps runtime/, name);
    }
});
