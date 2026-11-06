'use strict';
// HAR-01 — minimal harvest scenario.
//
// F0 world, one [MOVE,CARRY,WORK] creep at ~3 BFS cells from source S1, driven
// by the SIMPLEST UNCHANGED production harvester: dist/role.harvester.js,
// loaded as a user module and invoked through its public run(creep) on real
// Game objects. The only arrangement the test entrypoint performs is the same
// assignment production makes at spawn time (dist/SourceManager.js:143 sets
// creep.memory.assignedSource). No production rewrite, no engine substitution,
// no verified-result writes.
//
// Modes:
//   harvest  (default) real creep + real module; PASS needs harvest evidence
//   control  same world, no creep, trivial loop — isolates engine regen
//   refuse   F0-IMPOSSIBLE fixture; must end BLOCKED before stepping
//   validate F0 + one step only; proves the fixture path end-to-end
//
// Usage: node har-01.js --mode harvest [--http-port 32340 --cli-port 32341]
//                       [--bmove N --baction N] [--max-steps N]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runScenario, VERDICT_EXIT } = require('./harness');
const { fixtureF0, impossibleFixture } = require('./fixture');
const { sha256File } = require('./trace');

const REPO = path.resolve(__dirname, '..', '..');
const HARVESTER_FILE = path.join(REPO, 'dist', 'role.harvester.js');
const HARVESTER_MODULE = 'role.harvester';
const SEED_DB = '/home/happier/screeps/node_modules/@screeps/launcher/init_dist/db.json';

function arg(name, dflt) {
    const i = process.argv.indexOf('--' + name);
    return i !== -1 ? process.argv[i + 1] : dflt;
}
const MODE = arg('mode', 'harvest');
const HTTP_PORT = Number(arg('http-port', 32340));
const CLI_PORT = Number(arg('cli-port', 32341));

// Budgets (ticks). Theoretical move cost for [MOVE,CARRY,WORK]: each cell move
// adds 2 fatigue per non-MOVE part (4) on plain terrain; one MOVE part clears
// 2/tick => 1 cell per ~2 ticks. A dist-3 route costs ~6 ticks. Bmove=20 and
// Baction=10 are upper bounds with >3x margin over theory (R10/R100 aware);
// observed values are written to budgets.json by each run.
const BMOVE = Number(arg('bmove', 20));
const BACTION = Number(arg('baction', 10));
const MAX_STEPS = Number(arg('max-steps', BMOVE + BACTION));
const WCASE_MS = Number(arg('wcase-ms', 300000));

const seedId = crypto.createHash('sha256').update(fs.readFileSync(SEED_DB)).digest('hex').slice(0, 16);

function harvestEntrypoint(sourceId) {
    return `var roleHarvester = null, loadError = null;
try { roleHarvester = require(${JSON.stringify(HARVESTER_MODULE)}); }
catch (e) { loadError = String(e && e.stack || e); }
module.exports.loop = function() {
    if (loadError) { Memory.har = { loadError: loadError }; return; }
    for (var name in Game.creeps) {
        var creep = Game.creeps[name];
        try {
            if (!creep.memory.assignedSource) creep.memory.assignedSource = ${JSON.stringify(sourceId)};
            roleHarvester.run(creep);
        } catch (e) { Memory.har_err = String(e && e.stack || e); }
    }
    Memory.har = { tick: Game.time, creeps: Object.keys(Game.creeps).length };
};`;
}
const CONTROL_ENTRYPOINT = `module.exports.loop = function() { Memory.ctl = { tick: Game.time }; };`;

async function supplemental(h, ctx) {
    const out = {};
    try {
        out.notifications = await h.eval(
            `storage.db['users.notifications'].find({user:${JSON.stringify(ctx.userId)}})`, 10000);
        out.errors = (out.notifications || []).filter(n => n.type === 'error');
    } catch (e) { out.notifications = `unreadable: ${e.message}`; out.errors = null; }
    try {
        const u = await h.eval(`storage.db.users.findOne({_id:${JSON.stringify(ctx.userId)}})`, 10000);
        out.userCpu = u && { cpu: u.cpu, cpuAvailable: u.cpuAvailable };
    } catch (e) { out.userCpu = `unreadable: ${e.message}`; }
    try {
        out.intents = await h.eval(`storage.db['rooms.intents'].find({room:${JSON.stringify(ctx.room)}})`, 10000);
    } catch (e) { out.intents = `unreadable: ${e.message}`; }
    return out;
}

async function arrange(h, fx, journal, { withCreep, modules }) {
    const username = `har01_${process.pid}`;
    const userId = await h.createUser({
        username, modules, roomName: fx.room, spawn: true, spawnPos: fx.actual.spawn,
    });
    journal.add('user', userId, 'create', { username, modules: Object.keys(modules), spawnPos: fx.actual.spawn });
    await h.dbUpdate('rooms.objects', { $and: [{ room: fx.room }, { type: 'controller' }] }, { level: fx.spec.rcl });
    journal.add('controller', fx.actual.controller.id, 'update', { level: fx.spec.rcl });
    const ctx = { userId, room: fx.room };
    if (withCreep) {
        const inserted = await h.insertCreep({
            userId, room: fx.room, x: fx.actual.creep.x, y: fx.actual.creep.y,
            name: fx.spec.creep.name, parts: fx.spec.creep.body,
            store: fx.spec.creep.store, capacity: 50, age: 1500,
        });
        ctx.creepId = inserted && inserted._id;
        ctx.creepName = fx.spec.creep.name;
        journal.add('creep', ctx.creepId || fx.spec.creep.name, 'create',
            { x: fx.actual.creep.x, y: fx.actual.creep.y, body: fx.spec.creep.body });
    }
    return ctx;
}

function findCreep(rec, ctx) {
    return (rec.creeps || []).find(c => c.name === ctx.creepName) || null;
}
function findSource(rec, id) {
    return (rec.sources || []).find(s => s.id === id) || null;
}

function harvestTickCheck(rec, prev, ctx) {
    const bad = [];
    const creep = findCreep(rec, ctx);
    const prevCreep = findCreep(prev, ctx);
    const src = findSource(rec, ctx.source1Id);
    const prevSrc = findSource(prev, ctx.source1Id);
    if (!creep) { bad.push('creep missing'); return bad; }
    if (creep.user !== ctx.userId) bad.push(`creep owner ${creep.user} != ${ctx.userId}`);
    if (creep.hits !== 300 || creep.hitsMax !== 300) bad.push(`creep hits ${creep.hits}/${creep.hitsMax}`);
    if (creep.spawning !== false) bad.push(`creep spawning=${creep.spawning}`);
    if (!prevCreep) { bad.push('creep missing in previous frame'); return bad; }
    const dx = Math.abs(creep.x - prevCreep.x), dy = Math.abs(creep.y - prevCreep.y);
    if (Math.max(dx, dy) > 1) bad.push(`creep teleported ${prevCreep.x},${prevCreep.y} -> ${creep.x},${creep.y}`);
    const e = creep.store && creep.store.energy || 0;
    const pe = prevCreep.store && prevCreep.store.energy || 0;
    if (e > creep.storeCapacity || e < 0) bad.push(`creep store ${e} out of bounds`);
    if (e < pe) bad.push(`creep store decreased ${pe} -> ${e}`);
    if (!src) bad.push('source1 missing');
    else if (prevSrc && src.energy > prevSrc.energy) bad.push(`source energy increased ${prevSrc.energy} -> ${src.energy} (unexpected regen in window)`);
    // gameTime+1 / ack.sequence contiguity are asserted in runScenario core.
    const mem = rec.memory && rec.memory[ctx.userId];
    if (mem && mem.har && mem.har.loadError) bad.push(`module load failed: ${mem.har.loadError}`);
    if (mem && mem.har_err) bad.push(`harvester threw: ${mem.har_err}`);
    if (Array.isArray(rec.errors) && rec.errors.length) bad.push(`${rec.errors.length} user error notifications`);
    return bad;
}

function controlTickCheck(rec, prev, ctx) {
    const bad = [];
    if ((rec.creeps || []).length) bad.push('unexpected creep in control run');
    const src = findSource(rec, ctx.source1Id);
    const prevSrc = findSource(prev, ctx.source1Id);
    if (src && prevSrc) {
        if (src.energy < prevSrc.energy) bad.push(`source energy decreased without harvester ${prevSrc.energy} -> ${src.energy}`);
        if (src.energy > prevSrc.energy) ctx.regenEvents.push({ gameTime: rec.gameTime, from: prevSrc.energy, to: src.energy });
    }
    // gameTime+1 / ack.sequence contiguity are asserted in runScenario core.
    return bad;
}

async function main() {
    const runId = `har01-${MODE}-${Date.now()}-${process.pid}`;
    const spec = MODE === 'refuse' ? impossibleFixture() : fixtureF0();
    if (MODE === 'control') spec.expectCreep = false;
    const harvesterSource = fs.readFileSync(HARVESTER_FILE, 'utf8');
    const harvesterHash = sha256File(HARVESTER_FILE);

    let opts;
    if (MODE === 'harvest' || MODE === 'validate') {
        opts = {
            runId, scenarioId: 'HAR-01', seedId,
            ports: { http: HTTP_PORT, cli: CLI_PORT },
            fixtureSpec: spec,
            budgets: { maxSteps: MODE === 'validate' ? 1 : MAX_STEPS, WcaseMs: WCASE_MS },
            arrange: async (h, fx, journal) => {
                const entry = harvestEntrypoint(fx.actual.source1.id);
                const modules = { main: entry, [HARVESTER_MODULE]: harvesterSource };
                const ctx = await arrange(h, fx, journal, { withCreep: true, modules });
                ctx.source1Id = fx.actual.source1.id;
                ctx.source1Initial = fx.actual.source1.energy;
                ctx.moduleHashes = {
                    [HARVESTER_MODULE]: harvesterHash,
                    main: crypto.createHash('sha256').update(entry).digest('hex'),
                };
                return ctx;
            },
            supplemental,
            perTickCheck: harvestTickCheck,
            postcondition: MODE === 'validate' ? (() => true) : ((rec, ctx) => {
                const c = findCreep(rec, ctx);
                const s = findSource(rec, ctx.source1Id);
                // Harvest must be proven by the engine, not inferred: creep
                // store gained AND source drained AND the creep's actionLog
                // recorded a harvest action this same tick.
                const harvestLogged = (rec.actionLog || [])
                    .some(a => a.name === ctx.creepName && a.actionLog && a.actionLog.harvest);
                ctx.harvestEvidence = {
                    creepStore: c && c.store && c.store.energy,
                    sourceEnergy: s && s.energy,
                    sourceInitial: ctx.source1Initial,
                    actionLogHarvest: harvestLogged,
                };
                return !!(c && c.store && c.store.energy > 0 &&
                    s && s.energy < ctx.source1Initial && harvestLogged);
            }),
        };
    } else if (MODE === 'control') {
        opts = {
            runId, scenarioId: 'HAR-01-CONTROL', seedId,
            ports: { http: HTTP_PORT, cli: CLI_PORT },
            fixtureSpec: spec,
            budgets: { maxSteps: MAX_STEPS, WcaseMs: WCASE_MS },
            runFullBudget: true,
            arrange: async (h, fx, journal) => {
                const modules = { main: CONTROL_ENTRYPOINT };
                const ctx = await arrange(h, fx, journal, { withCreep: false, modules });
                ctx.source1Id = fx.actual.source1.id;
                ctx.source1Initial = fx.actual.source1.energy;
                ctx.regenEvents = [];
                ctx.moduleHashes = { main: crypto.createHash('sha256').update(CONTROL_ENTRYPOINT).digest('hex') };
                return ctx;
            },
            supplemental,
            perTickCheck: controlTickCheck,
            postcondition: () => false,
        };
    } else if (MODE === 'refuse') {
        opts = {
            runId, scenarioId: 'HAR-01-REFUSE', seedId,
            ports: { http: HTTP_PORT, cli: CLI_PORT },
            fixtureSpec: spec,
            expectBlocked: true,
            budgets: { maxSteps: 1, WcaseMs: 120000 },
            arrange: async (h, fx, journal) => {
                const modules = { main: CONTROL_ENTRYPOINT };
                const ctx = await arrange(h, fx, journal, { withCreep: false, modules });
                ctx.moduleHashes = {};
                return ctx;
            },
            supplemental,
        };
    } else {
        console.error(`unknown mode ${MODE}`);
        process.exitCode = 64;
        return;
    }

    const res = await runScenario(opts);
    // Persist the effective budgets + observed timing for calibration.
    try {
        const observed = { mode: MODE, BMOVE, BACTION, MAX_STEPS, WCASE_MS, ...res.stats };
        fs.writeFileSync(path.join(res.runDir, 'budgets.json'), JSON.stringify(observed, null, 2), { mode: 0o600 });
    } catch {}
    process.exitCode = VERDICT_EXIT[res.verdict] !== undefined ? VERDICT_EXIT[res.verdict] : 3;
}

main().catch(e => { console.error(e); process.exitCode = 3; });
