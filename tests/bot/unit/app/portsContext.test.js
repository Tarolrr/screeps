const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimePorts, createMemoryPort, STRATEGY_NAMESPACES } = require('../../../../src/bot/app/ports');
const { createContext, capabilitiesFor } = require('../../../../src/bot/app/context');
const { createTrapGame, createTrapMemory } = require('../../support/trapRuntime');
const F = require('../../support/fixtures');

test('creating ports reads nothing', function () {
    const g = createTrapGame();
    const m = createTrapMemory({});
    createRuntimePorts({ getGame: function () { return g.Game; }, getMemory: function () { return m.Memory; } });
    assert.deepEqual(g.journal.reads, []);
    assert.deepEqual(m.journal.reads, []);
});

test('clock and cpu ports: unknown is null, not zero', function () {
    const g = createTrapGame({ time: 42, cpu: { used: 3, limit: 20, tickLimit: undefined, bucket: 900 } });
    const ports = createRuntimePorts({ getGame: function () { return g.Game; } });
    assert.equal(ports.clock.tick(), 42);
    const cpu = ports.cpu.read();
    assert.equal(cpu.tickLimit, null);
    assert.deepEqual(cpu.missingFields, ['cpu.tickLimit']);
    const none = createRuntimePorts({ getGame: function () { return undefined; } });
    assert.equal(none.clock.tick(), null);
    assert.deepEqual(none.cpu.read().missingFields, ['cpu.bucket', 'cpu.limit', 'cpu.tickLimit', 'cpu.used']);
});

test('game read port only performs read-only calls', function () {
    const g = createTrapGame({ rooms: { W5N8: { name: 'W5N8', getEventLog: function () { return [{ event: 4 }]; } }, W1N1: { name: 'W1N1' } }, creeps: { b: {}, a: {} } });
    const port = createRuntimePorts({ getGame: function () { return g.Game; } }).gameRead;
    assert.deepEqual(port.roomNames(), ['W1N1', 'W5N8']);
    assert.deepEqual(port.creepNames(), ['a', 'b']);
    assert.equal(port.eventLog('W5N8').length, 1);
    assert.equal(port.eventLog('W1N1'), null);
    assert.equal(port.room('W9N9'), null);
    assert.equal(port.getObjectById('x'), null);
    assert.equal(port.shardName(), 'shard0');
    assert.deepEqual(g.journal.violations, []);
    assert.ok(Object.isFrozen(port));
});

test('memory ports are namespaced to strategy keys only', function () {
    assert.deepEqual(STRATEGY_NAMESPACES, ['strategy', 'strategyShadow', 'strategyMigration']);
    const m = createTrapMemory({ resourceManager: { resources: {} } }, { allowedRootKeys: ['strategy', 'strategyShadow', 'strategyMigration'] });
    for (const bad of ['resourceManager', 'creeps', 'rooms', 'spawns', 'flags', 'loggerState', '']) {
        assert.throws(function () { createMemoryPort(function () { return m.Memory; }, bad); }, TypeError, bad);
    }
    const ports = createRuntimePorts({ getMemory: function () { return m.Memory; } });
    assert.deepEqual(Object.keys(ports.memory).sort(), ['strategy', 'strategyMigration', 'strategyShadow']);
    assert.equal(ports.memory.strategy.read(), undefined);
    ports.memory.strategyShadow.write({ schemaVersion: 1 });
    assert.deepEqual(m.raw.strategyShadow, { schemaVersion: 1 });
    assert.throws(function () { ports.memory.strategy.write(undefined); }, TypeError);
    ports.memory.strategyShadow.remove();
    assert.equal('strategyShadow' in m.raw, false);
    assert.deepEqual(m.journal.violations, []);
    assert.deepEqual(m.raw.resourceManager, { resources: {} }, 'legacy namespace untouched');
});

test('contexts carry values only; shadow has no gateway key', function () {
    const ctx = createContext({ mode: 'shadow', tick: 1000, snapshot: F.sampleSnapshot(), stateView: F.sampleStateView(), stateRevision: 3, versions: { contractVersion: 'A.3', schemaVersion: 1, buildId: 'b', policyVersion: null }, ownerTokens: {}, budget: { admit: function () { return null; } } });
    assert.equal('gateway' in ctx, false);
    assert.equal(ctx.capabilities.ISSUE_INTENTS, false);
    assert.equal(ctx.capabilities.WRITE_LEGACY_MEMORY, false);
    assert.equal(ctx.capabilities.PROPOSE, true);
    assert.ok(Object.isFrozen(ctx.snapshot.rooms.W5N8));
    for (const key of ['gateway', 'Game', 'Memory', 'rawMemory']) {
        const parts = { mode: 'shadow', tick: 1, snapshot: null, stateView: null, versions: {}, budget: null };
        parts[key] = {};
        assert.throws(function () { createContext(parts); }, TypeError, key);
    }
    assert.throws(function () { capabilitiesFor('adaptive-v1'); }, /UNSUPPORTED_CAPABILITY/);
    assert.equal(capabilitiesFor('legacy').ISSUE_INTENTS, false);
});
