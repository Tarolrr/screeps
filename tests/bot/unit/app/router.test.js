const test = require('node:test');
const assert = require('node:assert/strict');
const { routeRooms, LEGACY_EXECUTION } = require('../../../../src/bot/app/OwnershipRouter');
const { READY, REJECTED, UNKNOWN } = require('../../../../src/bot/domain/results');
const { fingerprint } = require('../../../../src/bot/domain/fingerprint');
const { isJsonSafe } = require('../../../../src/bot/domain/canonical');
const F = require('../../support/fixtures');

function open(view) { return READY(view, fingerprint({ v: 1 })); }

test('no StateStore / no control -> legacy, new system off', function () {
    const table = routeRooms({ state: null, roomNames: ['W5N8', 'W1N1', 'bogus'] });
    assert.equal(table.legacyExecution, LEGACY_EXECUTION);
    assert.equal(table.stateSource, 'NO_STATE_STORE');
    assert.deepEqual(Object.keys(table.rooms), ['W1N1', 'W5N8'], 'invalid names dropped, sorted');
    for (const name of ['W1N1', 'W5N8']) {
        const r = table.rooms[name];
        assert.equal(r.requestedMode, 'legacy');
        assert.equal(r.effectiveOwner, 'legacy');
        assert.equal(r.newSystem, 'OFF');
        assert.equal(r.status.kind, 'READY');
        assert.deepEqual(r.token, { room: name, owner: 'legacy', epoch: 0 });
    }
    assert.equal(isJsonSafe(table), true);
});

test('room without control record in an open state -> legacy', function () {
    const table = routeRooms({ state: open(F.sampleStateView({})), roomNames: ['W5N8'] });
    assert.equal(table.stateSource, 'OPEN');
    assert.equal(table.rooms.W5N8.effectiveOwner, 'legacy');
    assert.equal(table.rooms.W5N8.newSystem, 'OFF');
});

test('shadow -> legacy executes, new system observes', function () {
    const table = routeRooms({ state: open(F.sampleStateView()), roomNames: [] });
    const r = table.rooms.W5N8;
    assert.equal(r.requestedMode, 'shadow');
    assert.equal(r.effectiveOwner, 'legacy');
    assert.equal(r.newSystem, 'SHADOW');
    assert.deepEqual(r.token, { room: 'W5N8', owner: 'legacy', epoch: 3 });
});

test('adaptive-v1 -> UNSUPPORTED_CAPABILITY, execution stays legacy', function () {
    const view = F.sampleStateView({ W5N8: F.sampleControlRecord({ requestedMode: 'adaptive-v1' }) });
    const r = routeRooms({ state: open(view), roomNames: ['W5N8'] }).rooms.W5N8;
    assert.equal(r.status.kind, 'REJECTED');
    assert.equal(r.status.reasonCode, 'UNSUPPORTED_CAPABILITY');
    assert.equal(r.effectiveOwner, 'legacy');
    assert.equal(r.newSystem, 'OFF');
});

test('record claiming adaptive ownership is not honoured and not turned into legacy', function () {
    const view = F.sampleStateView({ W5N8: F.sampleControlRecord({ requestedMode: 'adaptive-v1', effectiveOwner: 'adaptive-v1' }) });
    const r = routeRooms({ state: open(view), roomNames: [] }).rooms.W5N8;
    assert.equal(r.effectiveOwner, 'unconfirmed');
    assert.equal(r.newSystem, 'SUSPENDED');
    assert.equal(r.token, null);
    assert.equal(r.status.reasonCode, 'UNSUPPORTED_CAPABILITY');
});

test('invalid control record -> SUSPENDED for the new system, owner unconfirmed', function () {
    const view = F.sampleStateView({ W5N8: { requestedMode: 'turbo', effectiveOwner: 'legacy', epoch: 1 }, W1N1: F.sampleControlRecord() });
    const table = routeRooms({ state: open(view), roomNames: [] });
    assert.equal(table.rooms.W5N8.newSystem, 'SUSPENDED');
    assert.equal(table.rooms.W5N8.effectiveOwner, 'unconfirmed');
    assert.equal(table.rooms.W5N8.status.reasonCode, 'INVALID_RECORD');
    assert.equal(table.rooms.W1N1.newSystem, 'SHADOW', 'damage is local to one room');
});

test('incompatible schema / failed open -> every room SUSPENDED, legacy not enabled by routing', function () {
    for (const state of [REJECTED('INCOMPATIBLE_SCHEMA', { found: 9 }), UNKNOWN('MISSING_FIELD', ['strategy']), open(Object.assign(F.sampleStateView(), { status: 'SUSPENDED', blockedReason: 'INCOMPATIBLE_SCHEMA' }))]) {
        const table = routeRooms({ state: state, roomNames: ['W5N8', 'W1N1'] });
        assert.equal(table.stateSource, 'SUSPENDED');
        for (const name of ['W1N1', 'W5N8']) {
            assert.equal(table.rooms[name].newSystem, 'SUSPENDED');
            assert.equal(table.rooms[name].effectiveOwner, 'unconfirmed');
            assert.equal(table.rooms[name].token, null);
        }
        assert.equal(table.legacyExecution, 'PRE_EXISTING_EXECUTOR', 'legacy continues only as the pre-existing executor');
    }
    const table = routeRooms({ state: REJECTED('INCOMPATIBLE_SCHEMA', null), roomNames: ['W5N8'] });
    assert.equal(table.rooms.W5N8.status.reasonCode, 'INCOMPATIBLE_SCHEMA');
});

test('blocked transition -> SUSPENDED with recorded reason', function () {
    const view = F.sampleStateView({ W5N8: F.sampleControlRecord({ blockedReason: 'LEGACY_BINDING_CONFLICT' }) });
    const r = routeRooms({ state: open(view), roomNames: [] }).rooms.W5N8;
    assert.equal(r.newSystem, 'SUSPENDED');
    assert.equal(r.status.reasonCode, 'LEGACY_BINDING_CONFLICT');
});

test('invalid control keys and records are quarantined, not routed', function () {
    const view = F.sampleStateView({ 'not-a-room': F.sampleControlRecord(), W5N8: { requestedMode: 'turbo' }, W1N1: F.sampleControlRecord() });
    const table = routeRooms({ state: open(view), roomNames: [] });
    assert.deepEqual(Object.keys(table.rooms), ['W1N1', 'W5N8']);
    assert.deepEqual(table.quarantine, [
        { namespace: 'strategy', key: 'control.rooms.W5N8', reasonCode: 'INVALID_RECORD' },
        { namespace: 'strategy', key: 'control.rooms.not-a-room', reasonCode: 'INVALID_RECORD' },
    ]);
});
