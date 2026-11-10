// STRAT-A5 (i) with the REAL dist2 in the production artifact on a small simulated world:
// a run with the room in shadow and a run with the room in legacy must produce the
// same legacy behaviour — identical mutating Game calls/assignments (legacy intents),
// identical legacy Memory content and write journal — while the shadow run additionally
// completes the shadow pipeline. (The sim world is incomplete for dist2: some role
// errors are logged by legacy itself, identically in both runs.)

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProductionArtifact, createRun, strategyWithControl, STRATEGY_KEYS } = require('./support/artifact');
const { createSim, ROOM } = require('./support/simWorld');

const ENGINE_CONSTANTS = { SPAWN_ENERGY_CAPACITY: 300, EXTENSION_ENERGY_CAPACITY: { 0: 50, 1: 50, 2: 50, 3: 50, 4: 50, 5: 50, 6: 50, 7: 100, 8: 200 }, CREEP_LIFE_TIME: 1500, CREEP_SPAWN_TIME: 3, CARRY_CAPACITY: 50, HARVEST_POWER: 2 };

let artifact;
test.before(async function () { artifact = await buildProductionArtifact(); });

function runMode(mode, ticks) {
    const sim = createSim({});
    const run = createRun({ text: artifact.text, sim: sim, allowedRootKeys: '*', globals: ENGINE_CONSTANTS, memory: { creeps: sim.legacyCreepMemory(), strategy: strategyWithControl({ W1N1: mode }) } });
    run.ticks(ticks);
    const mem = run.mem();
    const legacyMem = {};
    for (const k in mem) if (STRATEGY_KEYS.indexOf(k) === -1) legacyMem[k] = mem[k];
    return {
        run: run,
        mem: mem,
        intents: run.gameViolations().map(function (v) { return v.kind + ' ' + v.where; }),
        legacyMem: JSON.stringify(legacyMem),
        legacyWrites: run.memory.journal.writes.filter(function (w) { return STRATEGY_KEYS.indexOf(w.where.split('.')[1]) === -1; }).map(function (w) { return w.kind + ' ' + w.where; }),
    };
}

test('real dist2: shadow adds no intents and no legacy Memory change compared with legacy-only', function () {
    const legacy = runMode('legacy', 20);
    const shadow = runMode('shadow', 20);
    assert.ok(legacy.intents.length > 0, 'legacy itself acted (the comparison is not vacuous)');
    assert.deepEqual(shadow.intents, legacy.intents, 'identical legacy intents/assignments');
    assert.equal(shadow.legacyMem, legacy.legacyMem, 'identical legacy Memory');
    assert.deepEqual(shadow.legacyWrites, legacy.legacyWrites, 'identical legacy write journal');
    assert.equal(legacy.mem.strategyShadow, undefined, 'legacy-only run: no shadow namespace');
    // the shadow pipeline completed next to real dist2 (mapPatch active in the same realm)
    assert.equal(shadow.mem.strategy.lastClosedTick, 1019);
    assert.ok(shadow.mem.strategyShadow.rooms[ROOM].forecast);
    assert.equal(shadow.run.consoleLines().filter(function (l) { return /COMPONENT_FAULT.*\.shadow/.test(l); }).length, 0, shadow.run.consoleLines().filter(function (l) { return l.indexOf('[strategy]') !== -1; }).join('\n'));
    assert.equal(shadow.run.sandbox.evaluate('typeof Map.prototype.toObject'), 'function', 'real mapPatch applied by legacy boot');
});
