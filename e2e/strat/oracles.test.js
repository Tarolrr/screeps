'use strict';
// Unit tests for the pure STRAT oracle helpers (no server needed):
//   ~/.local/node22/bin/node --test e2e/strat/oracles.test.js
const test = require('node:test');
const assert = require('node:assert');
const O = require('./oracles');
const { fnv1a } = require('./paged');

const fakeResult = () => ({
    ctx: { userId: 'u0000000000001' },
    fx: { actual: { source1: { id: 'aaaaaaaaaaaaaaa' }, source2: { id: 'bbbbbbbbbbbbbbb' }, controller: { id: 'ccccccccccccccc' } } },
    frames: [
        { gameTime: 1, objects: [{ id: 'sp1111111111111', type: 'spawn', name: 'Spawn1', x: 1, y: 1 }, { id: 'cr1111111111111', type: 'creep', name: 'har1', x: 2, y: 2 }] },
        { gameTime: 2, objects: [{ id: 'en1111111111111', type: 'energy', x: 3, y: 3 }] },
    ],
});

test('normalizer maps instance ids to stable labels and legacy generated ids', () => {
    const norm = O.normalizer(O.buildIdMap(fakeResult()));
    const v = norm({ spawnId: 'sp1111111111111', creep: 'cr1111111111111', pile: 'en1111111111111', owner: 'u0000000000001',
        ann: 'mule_spawn_aaaaaaaaaaaaaaa', proc: { spawnProcess_40_3: { orderId: 'creepOrder_12_1' } } });
    assert.deepStrictEqual(v, { spawnId: '$spawn:Spawn1', creep: '$creep:har1', pile: '$energy@3,3@2', owner: '$user',
        ann: 'mule_spawn_$source1', proc: { 'spawnProcess_40_*': { orderId: 'creepOrder_12_*' } } });
});

test('two runs with different ids normalise identically', () => {
    const a = fakeResult(), b = fakeResult();
    b.frames[0].objects[0].id = 'zz9999999999999';
    const na = O.normalizer(O.buildIdMap(a)), nb = O.normalizer(O.buildIdMap(b));
    assert.deepStrictEqual(na({ s: 'sp1111111111111' }), nb({ s: 'zz9999999999999' }));
});

test('id counter collision after normalisation is reported, not hidden', () => {
    const mem = { resourceManager: { resources: { spawnProcess: { spawnProcess_40_1: { orderId: 'a' }, spawnProcess_40_2: { orderId: 'b' } } } } };
    assert.strictEqual(O.idCounterCollisions(mem).length, 1);
    assert.ok(O.duplicationProblems(mem).some(p => /collision/.test(p)));
});

test('duplicate orders and double spawning processes are flagged', () => {
    const mem = { resourceManager: { resources: {
        creepOrder: { x: { metadata: { annotation: 'm' } }, y: { metadata: { annotation: 'm' } } },
        spawnProcess: { p1: { orderId: 'x', spawnId: 's', status: 'spawning' }, p2: { orderId: 'x', spawnId: 's', status: 'spawning' } },
    } } };
    const p = O.duplicationProblems(mem);
    assert.ok(p.some(s => /annotation m duplicated/.test(s)));
    assert.ok(p.some(s => /spawnProcess for order x duplicated/.test(s)));
    assert.ok(p.some(s => /two spawning processes/.test(s)));
});

test('gameRefs detects serialised Game objects and ignores plain positions', () => {
    assert.deepStrictEqual(O.gameRefs({ creeps: { a: { pos: { x: 1, y: 2 }, role: 'mule' } } }), []);
    assert.deepStrictEqual(O.gameRefs({ t: { id: 'x', pos: { x: 1, y: 2, roomName: 'W1N1' }, room: { name: 'W1N1' } } }), ['/t']);
    assert.deepStrictEqual(O.gameRefs({ r: { name: 'W1N1', energyAvailable: 300 } }), ['/r']);
});

test('legacyMemory drops exactly the three strategy namespaces', () => {
    assert.deepStrictEqual(Object.keys(O.legacyMemory({ creeps: {}, strategy: {}, strategyShadow: {}, strategyMigration: {}, resourceManager: {} })), ['creeps', 'resourceManager']);
});

test('stray strategy-prefixed keys stay in the legacy comparison and are reported', () => {
    const mem = { creeps: {}, strategy: {}, strategyCache: { x: 1 }, StrategyTmp: 1, strategyShadow: {} };
    assert.deepStrictEqual(Object.keys(O.legacyMemory(mem)).sort(), ['StrategyTmp', 'creeps', 'strategyCache']);
    assert.deepStrictEqual(O.strayStrategyKeys(mem), ['StrategyTmp', 'strategyCache']);
    assert.deepStrictEqual(O.strayStrategyKeys({ strategy: {}, strategyShadow: {}, strategyMigration: {} }), []);
    assert.ok(!O.isStrategyKey('strategyX'));
});

test('deepDiff keeps full values (no truncation) and valueAt resolves paths', () => {
    const big = 'x'.repeat(500);
    const d = O.deepDiff({ a: { b: big } }, { a: { b: 'y' } });
    assert.strictEqual(d[0].a, big);
    assert.strictEqual(O.valueAt({ a: { b: 2 } }, '/a/b'), 2);
    assert.strictEqual(O.valueAt({ a: {} }, '/a/b'), O.ABSENT);
    assert.ok(O.reportDiffs(d)[0].a.length <= 162);
});

test('objState keeps every engine field except Loki bookkeeping', () => {
    const s = O.objState({ _id: 'x', meta: {}, $loki: 3, type: 'controller', user: 'u', safeMode: 5, downgradeTime: null, reservation: { u: 1 }, level: 2 });
    assert.deepStrictEqual(Object.keys(s).sort(), ['downgradeTime', 'level', 'reservation', 'safeMode', 'type', 'user']);
    const c = O.objState({ _id: 'y', type: 'spawn', cooldown: 3, storeCapacity: 0, storeCapacityResource: { energy: 300 } });
    assert.deepStrictEqual(Object.keys(c).sort(), ['cooldown', 'storeCapacity', 'storeCapacityResource', 'type']);
});

test('console completeness requires exactly one message per step and contiguous seq', () => {
    const ok = O.consoleSummary({ aux: [{ stepIndex: 0, console: [] }, { stepIndex: 1, console: [{ seq: 1, lines: [] }] }, { stepIndex: 2, console: [{ seq: 2, lines: [] }] }] });
    assert.strictEqual(ok.complete, true);
    const late = O.consoleSummary({ aux: [{ stepIndex: 0, console: [] }, { stepIndex: 1, console: [] }, { stepIndex: 2, console: [{ seq: 1, lines: [] }, { seq: 2, lines: [] }] }] });
    assert.strictEqual(late.complete, false);
    assert.deepStrictEqual(late.badSteps, ['1:0', '2:2']);
    const gap = O.consoleSummary({ aux: [{ stepIndex: 0, console: [] }, { stepIndex: 1, console: [{ seq: 2, lines: [] }] }] });
    assert.strictEqual(gap.seqContiguous, false);
    assert.strictEqual(gap.complete, false);
});

test('deepDiff reports added/removed/changed paths', () => {
    const d = O.deepDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, e: 1 });
    assert.deepStrictEqual(d.map(x => x.path), ['/b/c', '/e']);
});

test('structure ignores values but not keys/types', () => {
    assert.strictEqual(O.canon(O.structure({ a: 1, b: [{ x: 's' }] })), O.canon(O.structure({ a: 7, b: [{ x: 't' }, { x: 'u' }] })));
    assert.notStrictEqual(O.canon(O.structure({ a: 1 })), O.canon(O.structure({ a: '1' })));
});

test('console summary finds initialisations and error lines', () => {
    const s = O.consoleSummary({ aux: [
        { stepIndex: 1, console: [{ seq: 1, lines: ['[DEBUG] Initializing game state...', '[DEBUG] Initialization complete'] }] },
        { stepIndex: 2, console: [{ seq: 2, lines: ['[ERROR] Error in main loop: x'], error: null }] },
        { stepIndex: 3, console: [{ seq: 3, lines: [], error: 'TypeError: boom' }] },
    ] });
    assert.deepStrictEqual(s.inits, [1]);
    assert.strictEqual(s.errorLines.length, 1);
    assert.strictEqual(s.uncaught.length, 1);
});

test('fnv1a is stable', () => {
    assert.strictEqual(fnv1a(''), 0x811c9dc5);
    assert.strictEqual(fnv1a('abc'), fnv1a('abc'));
    assert.notStrictEqual(fnv1a('abc'), fnv1a('abd'));
});
