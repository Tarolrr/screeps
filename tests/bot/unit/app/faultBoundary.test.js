const test = require('node:test');
const assert = require('node:assert/strict');
const { createFaultBoundary, RETRY_COOLDOWN_TICKS, BREAKER_THRESHOLD, BREAKER_TICKS } = require('../../../../src/bot/app/FaultBoundary');
const { READY } = require('../../../../src/bot/domain/results');
const { fingerprint } = require('../../../../src/bot/domain/fingerprint');
const { validateFaultStatus } = require('../../../../src/bot/domain/dtos');

const FP_A = fingerprint('a');
const FP_B = fingerprint('b');
function ok() { return READY(1, FP_A); }
function boom() { throw new Error('boom'); }

test('constants follow ARCHITECTURE §7', function () {
    assert.equal(RETRY_COOLDOWN_TICKS, 25);
    assert.equal(BREAKER_THRESHOLD, 3);
    assert.equal(BREAKER_TICKS, 100);
});

test('exception rejects only that component output', function () {
    const fb = createFaultBoundary();
    const r1 = fb.run('shadow.x', { tick: 10 }, boom);
    assert.equal(r1.kind, 'REJECTED');
    assert.equal(r1.reasonCode, 'COMPONENT_FAULT');
    assert.equal(r1.evidence.component, 'shadow.x');
    assert.equal(r1.evidence.message, 'boom');
    assert.equal(fb.run('shadow.y', { tick: 10 }, ok).kind, 'READY', 'other component unaffected');
});

test('retry not earlier than 25 ticks with unchanged input; immediate on input change', function () {
    const fb = createFaultBoundary();
    let calls = 0;
    const counting = function () { calls++; throw new Error('x'); };
    fb.run('c', { tick: 100, inputFingerprint: FP_A }, counting);
    const cooldown = fb.run('c', { tick: 124, inputFingerprint: FP_A }, counting);
    assert.equal(cooldown.reasonCode, 'RETRY_COOLDOWN');
    assert.equal(cooldown.evidence.retryAt, 125);
    assert.equal(calls, 1);
    const changed = fb.run('c', { tick: 101, inputFingerprint: FP_B }, ok);
    assert.equal(changed.kind, 'READY', 'changed input retries immediately');
    assert.equal(fb.status('c').consecutiveFailures, 0, 'success resets');
    fb.run('c', { tick: 200 }, counting);
    assert.equal(fb.run('c', { tick: 224 }, ok).reasonCode, 'RETRY_COOLDOWN', 'missing fingerprint counts as unchanged');
    assert.equal(fb.run('c', { tick: 225 }, ok).kind, 'READY');
});

test('3 consecutive failures open a 100 tick breaker; half-open after expiry', function () {
    const fb = createFaultBoundary();
    fb.run('c', { tick: 0 }, boom);
    fb.run('c', { tick: 25 }, boom);
    const third = fb.run('c', { tick: 50 }, boom);
    assert.equal(third.reasonCode, 'COMPONENT_FAULT');
    assert.equal(fb.status('c').breakerUntil, 150);
    const open = fb.run('c', { tick: 120, inputFingerprint: FP_B }, ok);
    assert.equal(open.reasonCode, 'CIRCUIT_OPEN', 'input change does not bypass the breaker');
    assert.equal(open.evidence.until, 150);
    assert.equal(fb.run('c', { tick: 149 }, ok).reasonCode, 'CIRCUIT_OPEN');
    // half-open: one failure re-opens
    assert.equal(fb.run('c', { tick: 150 }, boom).reasonCode, 'COMPONENT_FAULT');
    assert.equal(fb.status('c').breakerUntil, 250);
    assert.equal(fb.run('c', { tick: 250 }, ok).kind, 'READY');
    const st = fb.status('c');
    assert.equal(st.breakerUntil, null);
    assert.equal(st.halfOpen, false);
    assert.equal(st.consecutiveFailures, 0);
    assert.equal(st.totalFailures, 4);
    assert.deepEqual(validateFaultStatus(st), { ok: true });
});

test('bypassCooldown components always run but failures are recorded', function () {
    const fb = createFaultBoundary();
    let calls = 0;
    for (let t = 0; t < 5; t++) fb.run('legacy', { tick: t, bypassCooldown: true }, function () { calls++; throw new Error('x'); });
    assert.equal(calls, 5);
    assert.equal(fb.status('legacy').breakerUntil, null);
    assert.equal(fb.status('legacy').consecutiveFailures, 5);
});

test('non-Result output is a contract fault', function () {
    const fb = createFaultBoundary();
    assert.equal(fb.run('c', { tick: 1 }, function () { return 42; }).evidence.errorName, 'ContractError');
});

test('injectable store persists status (reset survival is the store\'s job)', function () {
    const saved = {};
    const store = { load: function (k) { return saved[k] ? JSON.parse(saved[k]) : null; }, save: function (k, v) { saved[k] = JSON.stringify(v); } };
    createFaultBoundary({ store: store }).run('c', { tick: 10 }, boom);
    const afterReset = createFaultBoundary({ store: store });
    assert.equal(afterReset.run('c', { tick: 20 }, ok).reasonCode, 'RETRY_COOLDOWN');
});
