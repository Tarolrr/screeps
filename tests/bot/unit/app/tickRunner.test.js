const test = require('node:test');
const assert = require('node:assert/strict');
const { createTickRunner, PHASES, STAGE_A_PHASE_ORDER } = require('../../../../src/bot/app/TickRunner');
const { createFaultBoundary } = require('../../../../src/bot/app/FaultBoundary');
const { READY } = require('../../../../src/bot/domain/results');
const { fingerprint } = require('../../../../src/bot/domain/fingerprint');

const FP = fingerprint(0);
function budget(kind) {
    return { admit: function (block) { return kind === 'READY' || block.budgetClass === 'exempt' ? READY(null, FP) : (kind === 'DEFERRED' ? { kind: 'DEFERRED', cursor: null, reason: 'BUDGET_DEFERRED' } : { kind: 'UNKNOWN', reason: 'MISSING_FIELD', missingFields: ['cpu.used'] }); } };
}

test('phase lists', function () {
    assert.deepEqual(PHASES, ['BOOT', 'OBSERVE', 'RECONCILE', 'CRITICAL', 'FORECAST', 'PLAN', 'ADMIT', 'EXECUTE', 'CLOSE']);
    assert.deepEqual(STAGE_A_PHASE_ORDER, ['BOOT', 'OBSERVE', 'CRITICAL', 'EXECUTE', 'RECONCILE', 'FORECAST', 'PLAN', 'ADMIT', 'CLOSE']);
    assert.throws(function () { createTickRunner({ faultBoundary: createFaultBoundary(), workBudget: budget('READY'), phaseOrder: ['CLOSE'] }); }, TypeError);
    assert.throws(function () { createTickRunner({ faultBoundary: createFaultBoundary(), workBudget: budget('READY'), phaseOrder: ['OBSERVE', 'BOOT', 'RECONCILE', 'CRITICAL', 'EXECUTE', 'FORECAST', 'PLAN', 'ADMIT', 'CLOSE'] }); }, TypeError);
});

test('components run by phase order then registration order and see earlier results', function () {
    const runner = createTickRunner({ faultBoundary: createFaultBoundary(), workBudget: budget('READY'), phaseOrder: STAGE_A_PHASE_ORDER });
    const order = [];
    function comp(name, phase) {
        return { name: name, phase: phase, run: function (frame) { order.push(name); return READY({ saw: frame.result('obs') !== null }, FP); } };
    }
    runner.register(comp('close', 'CLOSE'));
    runner.register(comp('plan', 'PLAN'));
    runner.register(comp('legacy', 'EXECUTE'));
    runner.register(comp('obs', 'OBSERVE'));
    runner.register(comp('boot', 'BOOT'));
    runner.register(comp('obs2', 'OBSERVE'));
    const report = runner.runTick({ tick: 7, tickToken: 1 });
    assert.deepEqual(order, ['boot', 'obs', 'obs2', 'legacy', 'plan', 'close']);
    assert.equal(report.results.boot.value.saw, false);
    assert.equal(report.results.legacy.value.saw, true);
    assert.deepEqual(runner.plan().map(function (c) { return c.name; }), order);
    assert.throws(function () { runner.register(comp('obs', 'OBSERVE')); }, TypeError, 'duplicate names rejected');
    assert.throws(function () { runner.register(comp('zzz', 'NOPE')); }, TypeError);
});

test('component specs may not carry extra keys (no smuggled ports)', function () {
    const runner = createTickRunner({ faultBoundary: createFaultBoundary(), workBudget: budget('READY') });
    assert.throws(function () { runner.register({ name: 'x', phase: 'PLAN', ports: {}, run: function () { return READY(null, FP); } }); }, /unknown key ports/);
});

test('frame.services is exactly what the composition root passed, frozen', function () {
    const svc = { clock: { tick: function () { return 1; } } };
    const runner = createTickRunner({ faultBoundary: createFaultBoundary(), workBudget: budget('READY'), services: svc });
    let seen = null;
    runner.register({ name: 'x', phase: 'PLAN', run: function (frame) { seen = frame; return READY(null, FP); } });
    runner.runTick({ tick: 1, tickToken: 1 });
    assert.deepEqual(Object.keys(seen).sort(), ['phase', 'result', 'services', 'tick', 'tickToken']);
    assert.ok(Object.isFrozen(seen.services));
    assert.equal(seen.services.clock, svc.clock);
});

test('a throwing component does not stop later ones', function () {
    const runner = createTickRunner({ faultBoundary: createFaultBoundary(), workBudget: budget('READY'), phaseOrder: STAGE_A_PHASE_ORDER });
    let after = 0;
    runner.register({ name: 'bad', phase: 'OBSERVE', run: function () { throw new Error('x'); } });
    runner.register({ name: 'good', phase: 'EXECUTE', run: function () { after++; return READY(null, FP); } });
    const report = runner.runTick({ tick: 1, tickToken: 1 });
    assert.equal(report.results.bad.reasonCode, 'COMPONENT_FAULT');
    assert.equal(after, 1);
    assert.deepEqual(report.entries.map(function (e) { return [e.component, e.kind, e.reason]; }), [['bad', 'REJECTED', 'COMPONENT_FAULT'], ['good', 'READY', null]]);
});

test('budget DEFERRED/UNKNOWN skip optional work; critical runs on UNKNOWN; exempt never consults budget', function () {
    for (const kind of ['DEFERRED', 'UNKNOWN']) {
        const runner = createTickRunner({ faultBoundary: createFaultBoundary(), workBudget: budget(kind) });
        const ran = [];
        for (const cls of ['optional', 'critical', 'exempt']) {
            runner.register({ name: cls, phase: 'PLAN', budgetClass: cls, run: function () { ran.push(cls); return READY(null, FP); } });
        }
        const report = runner.runTick({ tick: 1, tickToken: 1 });
        assert.equal(report.results.optional.kind, kind);
        assert.deepEqual(ran, kind === 'DEFERRED' ? ['exempt'] : ['critical', 'exempt']);
    }
});

test('input fingerprint function feeds the fault boundary', function () {
    const runner = createTickRunner({ faultBoundary: createFaultBoundary(), workBudget: budget('READY') });
    let input = 'a';
    let calls = 0;
    runner.register({ name: 'c', phase: 'PLAN', inputFingerprint: function () { return fingerprint(input); }, run: function () { calls++; throw new Error('x'); } });
    runner.runTick({ tick: 1, tickToken: 1 });
    runner.runTick({ tick: 2, tickToken: 2 });
    assert.equal(calls, 1, 'cooldown');
    input = 'b';
    runner.runTick({ tick: 3, tickToken: 3 });
    assert.equal(calls, 2, 'input change retries');
});
