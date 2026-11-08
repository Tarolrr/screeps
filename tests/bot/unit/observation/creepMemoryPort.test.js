// Real createGameReadPort(...).creepMemory against a trap Memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGameReadPort } = require('../../../../src/bot/app/ports');
const { createTrapMemory } = require('../../support/trapRuntime');

function setup() {
    const initial = { creeps: { h1: { role: 'harvester', home: 'W1N1', strategy: { operationKey: null, homeRoom: 'W1N1', ownerEpoch: 2 } } }, rooms: { W1N1: { x: 1 } } };
    const trap = createTrapMemory(initial, { allowedRootKeys: [] });
    const port = createGameReadPort(function () { return {}; }, function () { return trap.Memory; });
    return { trap: trap, port: port, before: JSON.stringify(initial) };
}

test('creepMemory: reads the role without creating Memory.creeps entries or writing', function () {
    const t = setup();
    const m = t.port.creepMemory('h1');
    assert.equal(m.role, 'harvester');
    assert.equal(t.port.creepMemory('ghost'), null, 'absent entry gives null');
    assert.equal(t.port.creepMemory('hasOwnProperty'), null);
    assert.equal(t.trap.raw.creeps.ghost, undefined);
    assert.deepEqual(t.trap.journal.writes, []);
    assert.deepEqual(t.trap.journal.violations, []);
    assert.equal(t.trap.serialize(), t.before, 'Memory unchanged');
});

test('creepMemory: result is a copy; mutating it does not affect Memory', function () {
    const t = setup();
    const m = t.port.creepMemory('h1');
    assert.notEqual(m, t.trap.raw.creeps.h1);
    try { m.role = 'hacked'; if (m.strategy) m.strategy.homeRoom = 'W9N9'; } catch (error) { /* frozen copies are fine too */ }
    assert.equal(t.trap.raw.creeps.h1.role, 'harvester');
    assert.equal(t.trap.raw.creeps.h1.strategy.homeRoom, 'W1N1');
    assert.equal(t.port.creepMemory('h1').role, 'harvester');
    assert.deepEqual(t.trap.journal.writes, []);
});

test('creepMemory: missing Memory.creeps root gives null and creates nothing', function () {
    const trap = createTrapMemory({}, { allowedRootKeys: [] });
    const port = createGameReadPort(function () { return {}; }, function () { return trap.Memory; });
    assert.equal(port.creepMemory('h1'), null);
    assert.equal(trap.serialize(), '{}');
    assert.deepEqual(trap.journal.writes, []);
});
