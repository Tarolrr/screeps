'use strict';
// A.4: the Reader copies the creation envelope (Memory.creeps[name].strategy) via the
// real read-only creepMemory port; the builder validates it (malformed -> null).
const test = require('node:test');
const assert = require('node:assert');
const { createReader } = require('../../../../src/bot/observation/ScreepsReader');
const { createRuntimePorts } = require('../../../../src/bot/app/ports');
const { makeWorld } = require('./readerSupport');

function snap(world, memoryCreeps) {
    const Memory = { creeps: memoryCreeps };
    const ports = createRuntimePorts({ getGame: function () { return world.Game; }, getMemory: function () { return Memory; } });
    const r = createReader({ gameRead: ports.gameRead, cpu: ports.cpu }).capture(world.Game.time, { rooms: 'ALL_VISIBLE', stage: 'FULL' }, undefined);
    assert.equal(r.kind, 'READY', JSON.stringify(r).slice(0, 300));
    return { s: r.value, Memory: Memory };
}

test('reader: valid creation envelope is copied, malformed/absent is null, Memory untouched', function () {
    const world = makeWorld();
    const before = { h1: { role: 'harvester', strategy: { operationKey: 'W1N1/1/W1N1%2Ffeed/2/spawn/0', homeRoom: 'W1N1', ownerEpoch: 1 } } };
    const text = JSON.stringify(before);
    const { s, Memory } = snap(world, before);
    const h1 = s.ownCreeps.h1;
    assert.ok(h1, 'h1 present');
    assert.equal(JSON.stringify(Memory.creeps), text, 'Memory.creeps unchanged');
    // operationKey format is contract-defined; accept either a copied valid envelope or null when the
    // sample key is not canonical, but never a partially copied object
    if (h1.strategyEnvelope !== null) {
        assert.deepEqual(h1.strategyEnvelope, before.h1.strategy);
    }
    const bad = snap(world, { h1: { role: 'harvester', strategy: { operationKey: 42, homeRoom: 'nope', ownerEpoch: -1 } } }).s;
    assert.equal(bad.ownCreeps.h1.strategyEnvelope, null);
    const none = snap(world, { h1: { role: 'harvester' } }).s;
    assert.equal(none.ownCreeps.h1.strategyEnvelope, null);
});

test('reader: canonical operationKey envelope round-trips', function () {
    const { buildOperationKey: operationKey } = require('../../../../src/bot/domain/keys');
    const key = operationKey({ domain: 'W1N1', ownerEpoch: 1, demandStableKey: 'W1N1/feeding/spawn1', generation: 2, action: 'spawn', occurrence: '0' });
    const world = makeWorld();
    const { s } = snap(world, { h1: { role: 'harvester', strategy: { operationKey: key, homeRoom: 'W1N1', ownerEpoch: 1 } } });
    assert.deepEqual(s.ownCreeps.h1.strategyEnvelope, { operationKey: key, homeRoom: 'W1N1', ownerEpoch: 1 });
});
