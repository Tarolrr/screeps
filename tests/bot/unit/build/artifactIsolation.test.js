// Isolation on the BUILT artifact under the Screeps-like loader.
//
// A test-only build (tools/build-strategy.js testPlugins) redirects:
//   - every dist2 module required by LegacyAdapter -> generated fake modules that
//     journal calls into sandbox global __legacy (and can fail on demand);
//   - src/bot/stageA.js (composition wiring) -> a fake wiring that registers one
//     shadow PLAN component journaling into __shadow (and can throw).
// Everything else (main.js, StrategyApp, TickRunner, FaultBoundary, LegacyAdapter)
// is the real code, bundled the same way as production. Test builds are marked
// testBuild:true with a 't-' buildId.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildStrategy, ROOT } = require('../../../../tools/build-strategy');
const { createScreepsSandbox } = require('../../support/screepsLoader');
const { createTrapGame, createTrapMemory } = require('../../support/trapRuntime');

const DIST2 = path.join(ROOT, 'dist2');
const STAGE_A = path.join(ROOT, 'src', 'bot', 'stageA');

const FAKE_METHODS = {
    roles: ['run'],
    logger: ['debug', 'error', 'load'],
    resourceManager: ['registerResourceType', 'load', 'save'],
    SourceController: ['initialize', 'reconcile'],
    SpawnController: ['initialize', 'reconcile'],
    RoomController: ['initialize', 'reconcile'],
    BuildController: ['initialize', 'reconcile'],
};

function fakeDist2Source(name) {
    const head = 'var L = globalThis.__legacy;\n' +
        'function rec(n, detail) { L.calls.push(detail === undefined ? n : n + ":" + detail);' +
        ' if (L.failOn === n) throw new Error("legacy fail " + n);' +
        ' if (L.initFailOn === n) { L.initFailOn = null; throw new Error("legacy init fail " + n); } }\n';
    if (name === 'mapPatch') return head + 'rec("mapPatch");\n';
    if (name.indexOf('resources.') === 0) return 'module.exports = function ' + name.replace(/\W/g, '_') + '() {};\n';
    if (name === 'js-yaml') return 'module.exports = {};\n';
    const methods = FAKE_METHODS[name];
    if (!methods) throw new Error('no fake for dist2 module ' + name);
    const body = methods.map(function (m) {
        const detail = name === 'roles' ? 'a[0].name' : (name === 'logger' && m !== 'load' ? 'String(a[0]).split("\\n")[0]' : 'undefined');
        return '  ' + m + ': function () { var a = arguments; rec("' + name + '.' + m + '", ' + detail + '); }';
    }).join(',\n');
    return head + 'module.exports = {\n' + body + '\n};\n';
}

const FAKE_WIRING = [
    'module.exports.wireStageA = function () {',
    '  return { observe: null, openState: null, stateApi: null, faultStore: null, components: [{',
    '    name: "shadow.plan", phase: "PLAN",',
    '    run: function (frame) {',
    '      var S = globalThis.__shadow;',
    '      S.runs.push({ tick: frame.tick, services: Object.keys(frame.services).sort().join(",") });',
    '      if (S.fail) throw new Error("shadow boom");',
    '      return { kind: "READY", value: null, inputFingerprint: "fnv1a64:0000000000000000" };',
    '    }',
    '  }] };',
    '};',
].join('\n');

const fakesPlugin = {
    name: 'test-fakes',
    setup: function (build) {
        build.onResolve({ filter: /.*/ }, function (args) {
            if (!args.resolveDir || args.path[0] !== '.') return undefined;
            const abs = path.resolve(args.resolveDir, args.path).replace(/\.js$/, '');
            if (path.dirname(abs) === DIST2) return { path: path.basename(abs), namespace: 'fake-dist2' };
            if (abs === STAGE_A) return { path: 'stageA', namespace: 'fake-wiring' };
            return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: 'fake-dist2' }, function (args) { return { contents: fakeDist2Source(args.path), loader: 'js' }; });
        build.onLoad({ filter: /.*/, namespace: 'fake-wiring' }, function () { return { contents: FAKE_WIRING, loader: 'js' }; });
    },
};

let bundleText;
let manifest;

test.before(async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strat-testbuild-'));
    const result = await buildStrategy({ outdir: dir, testPlugins: [fakesPlugin] });
    bundleText = fs.readFileSync(result.outFile, 'utf8');
    manifest = result.manifest;
});

function boot(legacyOptions, shadowFail) {
    const legacy = Object.assign({ calls: [], failOn: null, initFailOn: null }, legacyOptions || {});
    const shadow = { runs: [], fail: !!shadowFail };
    const memory = createTrapMemory({}, { allowedRootKeys: '*' });
    const sandbox = createScreepsSandbox({ modules: { main: bundleText }, Game: createTrapGame({ time: 200 }).Game, Memory: memory.Memory, globals: { __legacy: legacy, __shadow: shadow } });
    sandbox.require('main');
    return {
        legacy: legacy,
        shadow: shadow,
        sandbox: sandbox,
        tick: function (t) {
            sandbox.setGlobals({ Game: createTrapGame({ time: t }).Game });
            sandbox.runMainLoop();
        },
        count: function (name) { return legacy.calls.filter(function (c) { return c === name; }).length; },
    };
}

test('test build is marked and uses the fakes, not dist2', function () {
    assert.equal(manifest.testBuild, true);
    assert.match(manifest.buildId, /^t-/);
    assert.ok(manifest.inputs.some(function (i) { return i.path === 'fake-dist2:roles' && i.virtual; }));
    assert.equal(manifest.inputs.some(function (i) { return i.path.indexOf('dist2/') === 0; }), false);
    assert.ok(manifest.inputs.some(function (i) { return i.path === 'src/bot/main.js'; }));
});

test('artifact: throwing shadow component does not stop legacy', function () {
    const run = boot(null, true);
    for (let t = 201; t <= 203; t++) run.tick(t);
    assert.equal(run.count('resourceManager.save'), 3, 'legacy loop once per tick');
    assert.equal(run.count('resourceManager.load'), 1, 'legacy init once per global');
    assert.equal(run.shadow.runs.length, 1, 'faulted shadow component is in retry cooldown afterwards');
    assert.equal(run.shadow.runs[0].services, 'clock,cpu,log,state', 'shadow sees only values-only services');
    assert.ok(run.sandbox.consoleLines.some(function (l) { return l.indexOf('COMPONENT_FAULT') !== -1 && l.indexOf('shadow boom') !== -1; }));
});

test('artifact: legacy loop failure does not stop shadow', function () {
    const run = boot({ failOn: 'SpawnController.reconcile' }, false);
    for (let t = 201; t <= 203; t++) run.tick(t);
    assert.equal(run.shadow.runs.length, 3);
    assert.equal(run.count('resourceManager.save'), 0, 'legacy try/catch aborted the rest of its loop, like dist2');
    assert.equal(run.legacy.calls.filter(function (c) { return c.indexOf('logger.error:Error in main loop') === 0; }).length, 3);
});

test('artifact: legacy init failure does not stop shadow; init retried next tick with stack logged', function () {
    const run = boot({ initFailOn: 'resourceManager.load' }, false);
    run.tick(201);
    assert.equal(run.shadow.runs.length, 1);
    assert.equal(run.count('resourceManager.save'), 0);
    assert.ok(run.sandbox.consoleLines.some(function (l) { return l.indexOf('LEGACY_INIT_FAULT') !== -1 && l.indexOf('legacy init fail') !== -1 && l.indexOf('at ') !== -1; }), 'stack logged');
    run.tick(202);
    assert.equal(run.shadow.runs.length, 2);
    assert.equal(run.count('resourceManager.save'), 1);
    assert.equal(run.count('resourceManager.load'), 2, 'init retried once');
});
