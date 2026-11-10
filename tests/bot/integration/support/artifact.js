// Built-artifact harness for STRAT-A5 integration tests.
//
// buildShadowTestArtifact(): TEST-ONLY build (testBuild:true, 't-' buildId) where every
// dist2 module is replaced by a journaling fake (like tests/bot/unit/build/
// artifactIsolation.test.js), while main.js, StrategyApp, stageA.js and the whole shadow
// pipeline are the real code. One extra test hook: src/bot/planning/ShadowGovernor.js is
// the real source with a guard in evaluateRoom that throws when the sandbox global
// __shadowFail is set (shadow exception test, component plan.shadow). Never deployed.
//
// runArtifact(): loads the bundle as Screeps module `main` in the Screeps-like loader
// with a trap Memory (writes outside strategy* are violations) and drives a simWorld.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildStrategy, ROOT } = require('../../../../tools/build-strategy');
const { createScreepsSandbox } = require('../../support/screepsLoader');
const { createTrapMemory } = require('../../support/trapRuntime');
const { emptyStrategyRoot } = require('../../../../src/bot/domain/stateLayout');

const DIST2 = path.join(ROOT, 'dist2');
const HOOKED = path.join(ROOT, 'src', 'bot', 'planning', 'ShadowGovernor');
const STRATEGY_KEYS = ['strategy', 'strategyShadow', 'strategyMigration'];

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
        'function rec(n, detail) { L.calls.push(detail === undefined ? n : n + ":" + detail); }\n';
    if (name === 'mapPatch') return head + 'rec("mapPatch");\n';
    if (name.indexOf('resources.') === 0) return 'module.exports = function ' + name.replace(/\W/g, '_') + '() {};\n';
    if (name === 'js-yaml') return 'module.exports = {};\n';
    const methods = FAKE_METHODS[name];
    if (!methods) throw new Error('no fake for dist2 module ' + name);
    const body = methods.map(function (m) {
        const detail = name === 'roles' ? 'a[0].name' : 'undefined';
        return '  ' + m + ': function () { var a = arguments; rec("' + name + '.' + m + '", ' + detail + '); }';
    }).join(',\n');
    return head + 'module.exports = {\n' + body + '\n};\n';
}

const fakesPlugin = {
    name: 'a5-test-fakes',
    setup: function (build) {
        build.onResolve({ filter: /.*/ }, function (args) {
            if (!args.resolveDir || args.path[0] !== '.') return undefined;
            const abs = path.resolve(args.resolveDir, args.path).replace(/\.js$/, '');
            if (path.dirname(abs) === DIST2) return { path: path.basename(abs), namespace: 'fake-dist2' };
            if (abs === HOOKED) return { path: HOOKED + '.js', namespace: 'hooked-governor' };
            return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: 'fake-dist2' }, function (args) { return { contents: fakeDist2Source(args.path), loader: 'js' }; });
        build.onLoad({ filter: /.*/, namespace: 'hooked-governor' }, function (args) {
            const src = fs.readFileSync(args.path, 'utf8');
            const anchor = 'function evaluateRoom(context, roomState, helpers) {';
            if (src.indexOf(anchor) === -1) throw new Error('hook anchor missing in ShadowGovernor.js');
            return { contents: src.replace(anchor, anchor + '\n    if (globalThis.__shadowFail) throw new Error("shadow boom (test hook)");'), loader: 'js', resolveDir: path.dirname(args.path) };
        });
    },
};

let cached = null;
async function buildShadowTestArtifact() {
    if (cached) return cached;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strat-a5-test-'));
    const result = await buildStrategy({ outdir: dir, testPlugins: [fakesPlugin] });
    cached = { text: fs.readFileSync(result.outFile, 'utf8'), manifest: result.manifest };
    return cached;
}

let cachedProd = null;
async function buildProductionArtifact() {
    if (cachedProd) return cachedProd;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strat-a5-prod-'));
    const result = await buildStrategy({ outdir: dir });
    cachedProd = { text: fs.readFileSync(result.outFile, 'utf8'), manifest: result.manifest };
    return cachedProd;
}

/** Memory.strategy (schema1) with the given control records. */
function strategyWithControl(rooms, extra) {
    const root = JSON.parse(JSON.stringify(emptyStrategyRoot(null)));
    for (const name in rooms) {
        root.control.rooms[name] = Object.assign({ requestedMode: rooms[name], effectiveOwner: 'legacy', epoch: 0, transitionPhase: null, transitionId: null, previousOwner: null, blockedReason: null }, extra || {});
    }
    return root;
}

/**
 * The runtime parses Memory inside the isolate: move the (host-realm) initial Memory
 * content onto the sandbox realm's Object/Array prototypes so plain-object checks of the
 * bundle behave as on the server.
 */
function adoptRealm(value, sandbox) {
    const objectProto = sandbox.evaluate('Object.prototype');
    const arrayProto = sandbox.evaluate('Array.prototype');
    (function walk(v) {
        if (v === null || typeof v !== 'object') return;
        Object.setPrototypeOf(v, Array.isArray(v) ? arrayProto : objectProto);
        Object.keys(v).forEach(function (k) { walk(v[k]); });
    })(value);
}

function realmCopier(sandbox) {
    return function (value) { return sandbox.evaluate('JSON.parse(' + JSON.stringify(JSON.stringify(value)) + ')'); };
}

/** Property names of the sandbox's builtin prototypes (prototype mutation check). */
function prototypeFingerprint(sandbox) {
    return sandbox.evaluate('JSON.stringify([Object, Array, Map, Set, Function, String, Number, Promise, Error].map(function (C) { return [C.name, Object.getOwnPropertyNames(C.prototype).sort(), Object.getOwnPropertyNames(C).sort()]; }))');
}

/**
 * @param {{text: string, sim: object, memory?: object, allowedRootKeys?: (string[]|'*'), globals?: object}} options
 *   memory: initial Memory content (legacy keys + strategy*), deep-copied into a trap Memory
 */
function createRun(options) {
    let memory = createTrapMemory(options.memory || {}, { allowedRootKeys: options.allowedRootKeys || STRATEGY_KEYS, mode: 'record' });
    const memoryJournals = [];
    const legacy = { calls: [] };
    const sim = options.sim;
    let current = sim.game();
    const gameJournals = [current.journal];
    const sandbox = createScreepsSandbox({ modules: { main: options.text }, Game: current.Game, Memory: memory.Memory, globals: Object.assign({ __legacy: legacy }, options.globals || {}) });
    adoptRealm(memory.raw, sandbox);
    sim.realm = realmCopier(sandbox);
    sim.creepMemory = function (name) {
        const M = run.memory.Memory;
        if (!M.creeps) M.creeps = {};
        if (!M.creeps[name]) M.creeps[name] = {};
        return M.creeps[name];
    };
    current = sim.game();
    gameJournals[0] = current.journal;
    sandbox.require('main');
    const run = {
        sandbox: sandbox, memory: memory, legacy: legacy, sim: sim, gameJournals: gameJournals,
        /** Advance the world one tick and run loop() once (first call runs the initial tick). */
        tick: function () {
            run.sandbox.setGlobals({ Game: current.Game });
            const t0 = process.hrtime.bigint();
            run.sandbox.runMainLoop();
            run.lastLoopMs = Number(process.hrtime.bigint() - t0) / 1e6;
            sim.step();
            current = sim.game();
            gameJournals.push(current.journal);
        },
        ticks: function (n) { const ms = []; for (let i = 0; i < n; i++) { run.tick(); ms.push(run.lastLoopMs); } return ms; },
        /** Global reset: new sandbox (fresh heap and require cache), same Memory. */
        reset: function () {
            // the new isolate parses Memory again (fresh objects in the new realm)
            const reparsed = createTrapMemory(JSON.parse(memory.serialize()), { allowedRootKeys: options.allowedRootKeys || STRATEGY_KEYS, mode: 'record' });
            memoryJournals.push(memory.journal);
            memory = reparsed;
            run.memory = reparsed;
            const fresh = createScreepsSandbox({ modules: { main: options.text }, Game: current.Game, Memory: memory.Memory, globals: Object.assign({ __legacy: legacy }, options.globals || {}) });
            adoptRealm(memory.raw, fresh);
            sim.realm = realmCopier(fresh);
            current = sim.game();
            gameJournals.push(current.journal);
            fresh.require('main');
            run.sandbox = fresh;
        },
        consoleLines: function () { return run.sandbox.consoleLines; },
        gameViolations: function () { const out = []; gameJournals.forEach(function (j) { j.violations.forEach(function (v) { out.push(v); }); }); return out; },
        mem: function () { return JSON.parse(memory.serialize()); },
        /** Memory write violations over every heap (resets re-parse Memory). */
        memoryViolations: function () { return memoryJournals.concat([memory.journal]).reduce(function (a, j) { return a.concat(j.violations); }, []); },
        count: function (name) { return legacy.calls.filter(function (c) { return c === name; }).length; },
    };
    return run;
}

module.exports = { adoptRealm, STRATEGY_KEYS, buildShadowTestArtifact, buildProductionArtifact, strategyWithControl, prototypeFingerprint, createRun, fakeDist2Source };
