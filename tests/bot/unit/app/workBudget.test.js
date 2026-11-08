const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkBudget, createScopedBudget } = require('../../../../src/bot/app/WorkBudget');
const { createCpuPort } = require('../../../../src/bot/app/ports');
const { createTrapGame } = require('../../support/trapRuntime');

function budgetFor(cpu, settings) {
    const trap = createTrapGame({ cpu: cpu });
    return createWorkBudget(createCpuPort(function () { return trap.Game; }), settings);
}

test('optional block fits under limit', function () {
    const b = budgetFor({ used: 5, limit: 20, tickLimit: 500, bucket: 5000 });
    const r = b.admit({ name: 'x', budgetClass: 'optional', estimateCpu: 1 });
    assert.equal(r.kind, 'READY');
    assert.equal(r.value.ceiling, 13, '20 - hardMargin 2 - criticalReserve 5');
});

test('optional block deferred with BUDGET_DEFERRED and cursor', function () {
    const b = budgetFor({ used: 12.5, limit: 20, tickLimit: 500, bucket: 5000 });
    const r = b.admit({ name: 'x', budgetClass: 'optional', estimateCpu: 1, cursor: { room: 'W5N8' } });
    assert.equal(r.kind, 'DEFERRED');
    assert.equal(r.reason, 'BUDGET_DEFERRED');
    assert.deepEqual(r.cursor, { room: 'W5N8' });
});

test('optional (shadow) work never bursts into the bucket and stops when bucket is low', function () {
    const full = budgetFor({ used: 14, limit: 20, tickLimit: 500, bucket: 10000 });
    assert.equal(full.admit({ name: 'x', budgetClass: 'optional', estimateCpu: 0.5 }).kind, 'DEFERRED', 'capped at Game.cpu.limit even with full bucket');
    const low = budgetFor({ used: 0, limit: 20, tickLimit: 500, bucket: 999 });
    const r = low.admit({ name: 'x', budgetClass: 'optional', estimateCpu: 0.1 });
    assert.equal(r.kind, 'DEFERRED');
    assert.equal(r.reason, 'BUDGET_DEFERRED');
    assert.equal(low.settings.minShadowBucket, 1000);
});

test('scoped budget caps CPU spent inside the scope (observe ceiling)', function () {
    let used = 1;
    const trap = createTrapGame({ cpu: { used: function () { return used; }, limit: 20, tickLimit: 500, bucket: 5000 } });
    const port = createCpuPort(function () { return trap.Game; });
    const base = createWorkBudget(port);
    assert.equal(base.settings.observeCeilingCpu, 3);
    const scoped = createScopedBudget(base, port, 3);
    assert.equal(scoped.admit({ name: 'room1', budgetClass: 'optional', estimateCpu: 1 }).kind, 'READY');
    used = 3.5;
    const r = scoped.admit({ name: 'room2', budgetClass: 'optional', estimateCpu: 1, cursor: { next: 'W1N1' } });
    assert.equal(r.kind, 'DEFERRED');
    assert.deepEqual(r.cursor, { next: 'W1N1' });
});

test('critical block uses tickLimit minus hard margin only', function () {
    const b = budgetFor({ used: 497, limit: 20, tickLimit: 500, bucket: 0 });
    assert.equal(b.admit({ name: 'x', budgetClass: 'critical', estimateCpu: 0.5 }).kind, 'READY');
    assert.equal(b.admit({ name: 'x', budgetClass: 'critical', estimateCpu: 2 }).kind, 'DEFERRED');
});

test('missing CPU fields -> UNKNOWN, never zero', function () {
    const b = budgetFor({ used: undefined, limit: 20, tickLimit: undefined, bucket: 100 });
    const r = b.admit({ name: 'x', budgetClass: 'optional' });
    assert.equal(r.kind, 'UNKNOWN');
    assert.equal(r.reason, 'MISSING_FIELD');
    assert.deepEqual(r.missingFields, ['cpu.tickLimit', 'cpu.used']);
    assert.equal(b.admit({ name: 'x', budgetClass: 'critical' }).kind, 'UNKNOWN');
    const noBucket = budgetFor({ used: 1, limit: 20, tickLimit: 500, bucket: undefined });
    assert.deepEqual(noBucket.admit({ name: 'x', budgetClass: 'optional' }).missingFields, ['cpu.bucket']);
    assert.equal(noBucket.admit({ name: 'x', budgetClass: 'critical' }).kind, 'READY', 'critical does not need bucket');
});

test('reads getUsed at every admit', function () {
    let used = 0;
    const b = budgetFor({ used: function () { return used; }, limit: 20, tickLimit: 500, bucket: 5000 });
    assert.equal(b.admit({ name: 'x', budgetClass: 'optional', estimateCpu: 1 }).kind, 'READY');
    used = 19;
    assert.equal(b.admit({ name: 'x', budgetClass: 'optional', estimateCpu: 1 }).kind, 'DEFERRED');
});

test('exempt is always READY', function () {
    const b = budgetFor({ used: 1000, limit: 20, tickLimit: 500, bucket: 0 });
    assert.equal(b.admit({ name: 'legacy', budgetClass: 'exempt' }).kind, 'READY');
});
