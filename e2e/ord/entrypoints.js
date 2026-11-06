'use strict';
// ORD scenario entrypoints — the in-game `main` module source per mode.
//
// Every entrypoint calls REAL public methods on REAL objects (no production
// rewrite, no Game/engine substitution, no verified-result writes). Results
// are recorded under Memory.ord as inspectable evidence; the probe-side
// oracle evaluation compares them against the oracle table.
//
// EVIDENCE SIZE CONSTRAINT: the SRV field-set read funnels `memory:<uid>`
// through a single CLI print() line — server-side util.inspect truncates
// strings at maxStringLength=10000 (URI-encoded payload incl. closing marker),
// so user Memory must stay ~<=3KB raw or snapshots incoherence-timeout. All
// recorded evidence is therefore compact (error names + short messages, ids,
// counts); large artifacts (e.g. harvestPlanner's serialized costMatrix) are
// observed then deleted inside the same tick.
//
//   CAP(fn) — capture {ok:true,v} / {ok:false,n:<errname>,m:<msg<=60ch>};
//             NaN and undefined results are tagged so JSON keeps them.
//   Memory.ord.done — set when the scenario finished all its phases.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');

// Read production files verbatim; module names are the flat screeps module ids.
function prodModules(dist, names) {
    const modules = {};
    const hashes = {};
    for (const name of names) {
        const file = path.join(REPO, dist, name + '.js');
        const src = fs.readFileSync(file, 'utf8');
        modules[name] = src;
        hashes[name] = crypto.createHash('sha256').update(src).digest('hex');
    }
    return { modules, hashes };
}

const CAP_FN = `
function CAP(fn) {
    try {
        var v = fn();
        if (v === undefined) return { ok: true, v: null, u: true };
        if (typeof v === 'number' && isNaN(v)) return { ok: true, v: null, nan: true };
        return { ok: true, v: v };
    } catch (e) {
        return { ok: false, n: e && e.name, m: String(e && e.message || e).slice(0, 60) };
    }
}
`;

const D2_MODULES = ['logger', 'resourceManager', 'resources.Resource',
    'resources.sourceResource', 'resources.creepOrder', 'resources.spawnProcess',
    'resources.constructionOrder', 'constructionPatterns', 'utils.priority',
    'mapPatch'];

const LOAD_RM = `
function loadRM() {
    var rm = require('resourceManager');
    rm.registerResourceType('source', require('resources.sourceResource'));
    rm.registerResourceType('creepOrder', require('resources.creepOrder'));
    rm.registerResourceType('spawnProcess', require('resources.spawnProcess'));
    rm.registerResourceType('constructionOrder', require('resources.constructionOrder'));
    return rm;
}
`;

// ---------------------------------------------------------------------------
// ORD-01 — dist2 resource manager: apply/reapply/save/reload/query/delete +
// schema-validation variants + CreepOrder.calculateBodyParts boundaries.
// Phases: a (apply+variants+save+wipe cache), b (fresh runtime reload+query+
// delete+save+wipe), c (reload, absent-after-delete, done).
// ---------------------------------------------------------------------------
function ord01Entrypoint(ctx) {
    const main = `${CAP_FN}
var RM_MODULES = ${JSON.stringify(D2_MODULES)};
function wipe() {
    for (var i = 0; i < RM_MODULES.length; i++) delete require.cache[RM_MODULES[i]];
}
${LOAD_RM}
var S1 = ${JSON.stringify(ctx.s1)};
var S2 = ${JSON.stringify(ctx.s2)};
var ROOM = ${JSON.stringify(ctx.room)};
module.exports.loop = function () {
    try {
        Memory.ord = Memory.ord || {};
        var rm = loadRM();
        if (!Memory.ord.a) {
            var R = { t: Game.time };
            rm.load();
            R.a1 = CAP(function () {
                return rm.applyResource('source', { sourceId: S1, roomName: ROOM,
                    metadata: { annotation: 'ord1src' } });
            });
            R.a2 = CAP(function () {
                return rm.applyResource('source', { sourceId: S2, roomName: ROOM,
                    metadata: { annotation: 'ord1src' } });
            });
            var res = rm.getResourceByTypeAndId('source', 'ord1src');
            R.res = CAP(function () {
                return { id: res.id, sid: res.sourceId,
                    an: res.metadata && res.metadata.annotation,
                    inst: res instanceof require('resources.sourceResource') };
            });
            R.cnt = rm.getResourcesOfType('source').filter(function (r) {
                return r.metadata && r.metadata.annotation === 'ord1src';
            }).length;
            R.co1 = CAP(function () {
                return rm.applyResource('creepOrder', { role: 'harvester',
                    schema: { constant: ['move', 'carry', 'work'], ratio: { work: 1 }, maxCost: 700 },
                    roomName: ROOM, priority: 5, memory: { role: 'harvester' },
                    metadata: { annotation: 'ord1co' } });
            });
            var co = rm.getResourceByTypeAndId('creepOrder', 'ord1co');
            co.status = 'active'; co.creepName = 'ordcreep'; co.expiryTime = 12345;
            R.co2 = CAP(function () {
                return rm.applyResource('creepOrder', { role: 'harvester',
                    schema: { constant: ['move', 'carry', 'work'], ratio: { work: 1 }, maxCost: 700 },
                    roomName: ROOM, priority: 9, memory: { role: 'harvester' },
                    metadata: { annotation: 'ord1co' } });
            });
            R.coA = CAP(function () {
                var c = rm.getResourceByTypeAndId('creepOrder', 'ord1co');
                return { st: c.status, cn: c.creepName, ex: c.expiryTime, pr: c.priority };
            });
            // variants vs oracle table
            R.un = CAP(function () {
                return rm.applyResource('source', { sourceId: S1, roomName: ROOM });
            });
            R.uk1 = CAP(function () { return rm.applyResource('mystery', { a: 1 }); });
            R.uk2 = CAP(function () { return rm.applyResource('mystery', { a: 1 }); });
            R.ex = CAP(function () {
                return rm.applyResource('source', { sourceId: S1, roomName: ROOM,
                    bogus: 1, metadata: { annotation: 'x-extra' } });
            });
            R.wt = CAP(function () {
                return rm.applyResource('source', { sourceId: 123, roomName: ROOM,
                    metadata: { annotation: 'x-wt' } });
            });
            R.mi = CAP(function () {
                return rm.applyResource('source', { roomName: ROOM,
                    metadata: { annotation: 'x-miss' } });
            });
            R.mis = CAP(function () {
                var r = rm.getResourceByTypeAndId('source', 'x-miss');
                return { id: r.id, sidUndef: r.sourceId === undefined,
                    hasProp: 'sourceId' in r };
            });
            R.ns = CAP(function () {
                return rm.applyResource('source', { sourceId: null, roomName: ROOM,
                    metadata: { annotation: 'x-null' } });
            });
            R.nss = CAP(function () {
                return { id: rm.getResourceByTypeAndId('source', 'x-null').id,
                    null: rm.getResourceByTypeAndId('source', 'x-null').sourceId === null };
            });
            R.nm = CAP(function () {
                return rm.applyResource('source', { sourceId: S1, roomName: ROOM,
                    metadata: null });
            });
            // CreepOrder.calculateBodyParts boundary oracle
            var CreepOrder = require('resources.creepOrder');
            var probe = new CreepOrder({ id: 'p1', role: 'harvester',
                schema: { constant: ['move', 'carry', 'work'], ratio: { work: 1 }, maxCost: 700 },
                roomName: ROOM });
            R.bp = {
                b: CAP(function () { return probe.calculateBodyParts(199); }),
                e: CAP(function () { return probe.calculateBodyParts(200); }),
                a1: CAP(function () { return probe.calculateBodyParts(300); }),
                mc: CAP(function () { var x = probe.calculateBodyParts(10000); return x && x.length; })
            };
            var probeNoCap = new CreepOrder({ id: 'p2', role: 'x',
                schema: { constant: ['move'], ratio: { work: 1 }, maxCost: 0 }, roomName: ROOM });
            R.nc = CAP(function () { var x = probeNoCap.calculateBodyParts(6000); return x && x.length; });
            rm.save();
            // serialized-state proof (toJSON round trip), compact
            R.sv = CAP(function () {
                var m = JSON.parse(JSON.stringify(Memory.resourceManager));
                return { sid: m.resources.source.ord1src.sourceId,
                    len: JSON.stringify(Memory.resourceManager).length };
            });
            wipe();
            Memory.ord.a = R;
        } else if (!Memory.ord.b) {
            var R2 = { t: Game.time };
            rm.load();
            R2.rl = CAP(function () {
                var res = rm.getResourceByTypeAndId('source', 'ord1src');
                return { p: !!res, sid: res && res.sourceId,
                    inst: res instanceof require('resources.sourceResource'),
                    toS: !!(res && typeof res.toSpec === 'function'),
                    mA: !!(res && typeof res.matchesAnnotation === 'function'),
                    sObj: !!(res && res.source && res.source.id) };
            });
            R2.q = rm.getResourceByField('source', 'sourceId', S2).length;
            R2.co = CAP(function () {
                var c = rm.getResourceByTypeAndId('creepOrder', 'ord1co');
                return { st: c && c.status, cn: c && c.creepName, ex: c && c.expiryTime,
                    pr: c && c.priority, inst: c instanceof require('resources.creepOrder'),
                    b3: c && c.calculateBodyParts(300) };
            });
            R2.my = rm.getResourcesOfType('mystery').length;
            R2.d = rm.deleteResource('source', 'ord1src');
            R2.d2 = rm.deleteResource('source', 'ord1src');
            R2.ac = rm.getResourcesOfType('source').filter(function (r) {
                return r.metadata && r.metadata.annotation === 'ord1src';
            }).length;
            rm.save();
            wipe();
            Memory.ord.b = R2;
        } else if (!Memory.ord.c) {
            var R3 = { t: Game.time };
            rm.load();
            R3.sp = !!rm.getResourceByTypeAndId('source', 'ord1src');
            R3.cp = !!rm.getResourceByTypeAndId('creepOrder', 'ord1co');
            R3.n = rm.getResourcesOfType('source').length;
            Memory.ord.c = R3;
            Memory.ord.done = true;
        }
    } catch (e) {
        Memory.ord = Memory.ord || {};
        Memory.ord.err = String(e && e.message || e).slice(0, 80);
        Memory.ord.done = true;
    }
};
`;
    const { modules, hashes } = prodModules('dist2', D2_MODULES);
    modules.main = main;
    hashes.main = crypto.createHash('sha256').update(main).digest('hex');
    return { modules, hashes };
}

// ---------------------------------------------------------------------------
// ORD-02 — disabled flag semantics + priority helper.
// Phases: a (priority matrix + V1 apply+save), b (reload, V2 in-mem change,
// disabled input, save — absent save entry check), c (disabled=false, reload
// old memory, save, done). `mode`: 'true' | 'strtrue' | 'false'.
// ---------------------------------------------------------------------------
function ord02Entrypoint(ctx, mode) {
    const disabledExpr = mode === 'strtrue' ? `'true'` : mode === 'true' ? `true` : `false`;
    const main = `${CAP_FN}
var S1 = ${JSON.stringify(ctx.s1)};
var S2 = ${JSON.stringify(ctx.s2)};
var ROOM = ${JSON.stringify(ctx.room)};
${LOAD_RM}
module.exports.loop = function () {
    try {
        Memory.ord = Memory.ord || {};
        var rm = loadRM();
        if (!Memory.ord.a) {
            var R = { t: Game.time };
            var PC = require('utils.priority');
            R.pri = {
                s10: CAP(function () { return PC.calculatePriorityFromId(S1, 0); }),
                s110: CAP(function () { return PC.calculatePriorityFromId(S1, 10); }),
                s20: CAP(function () { return PC.calculatePriorityFromId(S2, 0); }),
                s210: CAP(function () { return PC.calculatePriorityFromId(S2, 10); }),
                h10: CAP(function () { return PC.calculatePriorityFromId('000001', 0); }),
                h110: CAP(function () { return PC.calculatePriorityFromId('000001', 10); }),
                h20: CAP(function () { return PC.calculatePriorityFromId('000002', 0); }),
                inv: CAP(function () { return PC.calculatePriorityFromId('zzzzzz', 0); }),
                sh: CAP(function () { return PC.calculatePriorityFromId('ab', 0); })
            };
            var set = [40, 49, 50, 51, 70, 80, 1000];
            var s1p = R.pri.s10.v, s2p = R.pri.s20.v;
            R.sorted = set.concat([s1p, s2p]).slice().sort(function (a, b) { return b - a; });
            rm.load();
            R.ap = CAP(function () {
                return rm.applyResource('source', { sourceId: S1, roomName: ROOM,
                    metadata: { annotation: 'p1' } });
            });
            rm.save();
            R.sv = CAP(function () {
                return JSON.parse(JSON.stringify(Memory.resourceManager)).resources.source.p1.sourceId;
            });
            Memory.ord.a = R;
        } else if (!Memory.ord.b) {
            var R2 = { t: Game.time };
            rm.load();
            R2.l = rm.getResourceByTypeAndId('source', 'p1').sourceId;
            R2.ap2 = CAP(function () {
                return rm.applyResource('source', { sourceId: S2, roomName: ROOM,
                    metadata: { annotation: 'p1' } });
            });
            R2.im = rm.getResourceByTypeAndId('source', 'p1').sourceId;
            Memory.resourceManager.disabled = ${disabledExpr};
            rm.save();
            R2.da = rm.disabled;
            R2.sv = CAP(function () {
                var m = JSON.parse(JSON.stringify(Memory.resourceManager));
                return { sid: m.resources.source.p1.sourceId, dis: m.disabled };
            });
            Memory.ord.b = R2;
        } else if (!Memory.ord.c) {
            var R3 = { t: Game.time };
            rm.load();
            R3.l = rm.getResourceByTypeAndId('source', 'p1').sourceId;
            R3.db = rm.disabled;
            Memory.resourceManager.disabled = false;
            rm.save();
            R3.da = rm.disabled;
            R3.fin = CAP(function () {
                var m = JSON.parse(JSON.stringify(Memory.resourceManager));
                return { sid: m.resources.source.p1.sourceId, dis: m.disabled };
            });
            Memory.ord.c = R3;
            Memory.ord.done = true;
        }
    } catch (e) {
        Memory.ord = Memory.ord || {};
        Memory.ord.err = String(e && e.message || e).slice(0, 80);
        Memory.ord.done = true;
    }
};
`;
    const { modules, hashes } = prodModules('dist2', D2_MODULES);
    modules.main = main;
    hashes.main = crypto.createHash('sha256').update(main).digest('hex');
    return { modules, hashes };
}

// ---------------------------------------------------------------------------
// ORD-03 — dist planners + data classes on real objects.
// Tick a: fresh SourceManager/SourceDesc/CreepPlanner/QueuedCreep/spawnCreep
// dryRun matrix + manager save. Tick b: manager load path (Memory.managers
// entry exists -> load()) + creepOwner queued->living, done.
// ---------------------------------------------------------------------------
function ord03Entrypoint(ctx) {
    const DIST_MODULES = ['logger', 'SourceDesc', 'SourceManager', 'CreepPlanner',
        'creepUtils', 'Manager', 'Consumer', 'Producer', 'CreepOwner',
        'room.harvestPlanner'];
    const main = `${CAP_FN}
var S1 = ${JSON.stringify(ctx.s1)};
var S2 = ${JSON.stringify(ctx.s2)};
var ROOM = ${JSON.stringify(ctx.room)};
var CREEP = ${JSON.stringify(ctx.creepName)};
module.exports.loop = function () {
    try {
        Memory.managers = Memory.managers || {};
        Memory.creepId = Memory.creepId || 0;
        Memory.creeps = Memory.creeps || {};
        Memory.creeps[CREEP] = Memory.creeps[CREEP] || { role: 'harvester', efficiency: 2 };
        Memory.ord = Memory.ord || {};
        var room = Game.rooms[ROOM];
        var s1 = Game.getObjectById(S1);
        var s2 = Game.getObjectById(S2);
        var SourceManager = require('SourceManager');
        var SourceDesc = require('SourceDesc');
        var CreepPlanner = require('CreepPlanner');
        var QueuedCreep = require('creepUtils').QueuedCreep;
        if (!Memory.ord.a) {
            var R = { t: Game.time };
            R.cap = s1.energyCapacity;
            // mgrA is reused below so save() persists this instance's creepOwner
            var mgrA = null;
            R.m1 = CAP(function () {
                mgrA = new SourceManager(room, s1, null);
                return { wp: mgrA.workPlaces.length, fp: mgrA.freePlaces,
                    nw: mgrA.needWork, hw: mgrA.hasWork };
            });
            // adjacent-walls variant: second source on different terrain
            R.m2 = CAP(function () {
                var m = new SourceManager(room, s2, null);
                return { wp: m.workPlaces.length, nw: m.needWork };
            });
            R.d1 = CAP(function () {
                var d = new SourceDesc(s1);
                return { tp: d.totalPlaces, fp: d.freePlaces, nw: d.needWork,
                    tt: d.timeTo, nc: d.needCarry, src: d.srcId };
            });
            R.dc = CAP(function () { return new SourceDesc(s1).availableCarry(); });
            // zero distance: separate negative case
            R.dz = CAP(function () {
                var d = new SourceDesc(s2); d.timeTo = 0; d.needCarry = 0;
                return d.availableCarry();
            });
            // update() with no room.memory.costMatrix — record actual error
            R.du = CAP(function () { new SourceDesc(s1).update(); });
            // availableEnergy getter: return value + side-effect field
            R.ae = CAP(function () {
                var m = new SourceManager(room, s1, null);
                return { r: m.availableEnergy, f: m.energyAvailable };
            });
            // queued -> living WORK via creepOwner on a REAL creep
            R.q = CAP(function () {
                var qc = new QueuedCreep(CREEP, { role: 'harvester', efficiency: 2 },
                    ['work', 'work', 'move'], 250);
                var be = [mgrA.freePlaces, mgrA.hasWork];
                // production path: RoomManager.queueCreeps -> creepOwner.addCreep
                mgrA.creepOwner.addCreep(qc);
                var aa = [mgrA.freePlaces, mgrA.hasWork, mgrA.creepOwner.creepsQueued.length];
                mgrA.creepOwner.run();
                mgrA.run();
                return { be: be, aa: aa, lv: mgrA.creepOwner.creeps.length,
                    qq: mgrA.creepOwner.creepsQueued.length,
                    hw: mgrA.hasWork, fp: mgrA.freePlaces };
            });
            // save() -> Memory.managers entry (load path exercised next tick)
            R.sv = CAP(function () {
                mgrA.save();
                var e = Memory.managers[mgrA.name];
                return { sv: !!e, nw: e && e.needWork, wp: e && e.workPlaces.length,
                    src: e && e.source, cr: e && e.creeps, cq: e && e.creepsQueued };
            });
            // CreepPlanner.calculateCreep matrix
            R.cp = {};
            ['harvester', 'mule', 'upgrader', 'repairer', 'builder'].forEach(function (role) {
                [0, 150, 300].forEach(function (cost) {
                    R.cp[role + '@' + cost] = CAP(function () {
                        var t = CreepPlanner.calculateCreep(role, cost);
                        return t ? { c: t.cost, p: t.parts, m: t.memory } : null;
                    });
                });
            });
            R.ml = CAP(function () {
                var t = CreepPlanner.calculateCreep('harvester', 6000);
                return t ? { c: t.cost, n: t.parts.length } : null;
            });
            // engine-side body verification via real spawnCreep(dryRun)
            R.sp = CAP(function () {
                var spawn = room.find(FIND_MY_SPAWNS)[0];
                var body300 = CreepPlanner.calculateCreep('harvester', 300).parts;
                var b50 = []; for (var i = 0; i < 50; i++) b50.push('move');
                var b51 = []; for (var j = 0; j < 51; j++) b51.push('move');
                return { e: spawn.spawnCreep([], 'z0', { dryRun: true }),
                    o: spawn.spawnCreep(b51, 'z51', { dryRun: true }),
                    a: spawn.spawnCreep(b50, 'z50', { dryRun: true }),
                    v: spawn.spawnCreep(body300, 'z300', { dryRun: true }),
                    en: spawn.room.energyAvailable };
            });
            Memory.ord.a = R;
        } else if (!Memory.ord.b) {
            var R2 = { t: Game.time };
            // load path: Memory.managers entry written last tick -> load()
            R2.ld = CAP(function () {
                var m = new SourceManager(room, s1, null);
                return { wp: m.workPlaces.length, fp: m.freePlaces, nw: m.needWork,
                    src: m.source && m.source.id,
                    c: m.creepOwner.creeps.length, q: m.creepOwner.creepsQueued.length };
            });
            Memory.ord.b = R2;
            Memory.ord.done = true;
        }
    } catch (e) {
        Memory.ord = Memory.ord || {};
        Memory.ord.err = String(e && e.message || e).slice(0, 80);
        Memory.ord.done = true;
    }
};
`;
    const { modules, hashes } = prodModules('dist', DIST_MODULES);
    modules.main = main;
    hashes.main = crypto.createHash('sha256').update(main).digest('hex');
    return { modules, hashes };
}

// ---------------------------------------------------------------------------
// ORD-04 — dormant planners/interfaces. Explicit room/creep Memory is seeded
// as input (srcDescs marker, roles, flags, spawn queue). Every tick the real
// planner run()s are invoked — they self-gate on Game.time%100==1 / %50==1.
// Per-tick effects are verified probe-side from frame memory; the entrypoint
// only records compact require/abstract results. The serialized costMatrix
// written by harvestPlanner is observed (len recorded) then deleted to keep
// user Memory under the CLI evidence limit.
// ---------------------------------------------------------------------------
function ord04Entrypoint(ctx) {
    const DIST_MODULES = ['logger', 'mapPatch', 'SourceDesc', 'room.harvestPlanner',
        'room.consumptionPlanner', 'room.pathPlanner', 'SpawnPlanner', 'CreepPlanner',
        'creepUtils', 'EconomyPlanner', 'Manager', 'Consumer', 'Producer',
        'CreepOwner'];
    const main = `${CAP_FN}
var S1 = ${JSON.stringify(ctx.s1)};
var ROOM = ${JSON.stringify(ctx.room)};
var CREEP = ${JSON.stringify(ctx.creepName)};
module.exports.loop = function () {
    try {
        Memory.ord = Memory.ord || {};
        var room = Game.rooms[ROOM];
        // ---- input seeding (first tick): explicit room/creep Memory ---------
        if (!Memory.ord.seeded) {
            Memory.managers = Memory.managers || {};
            Memory.creepId = Memory.creepId || 0;
            Memory.creeps = Memory.creeps || {};
            Memory.creeps[CREEP] = { role: 'mule' };
            Memory.flags = { f1: true };
            Memory.spawns = Memory.spawns || {};
            Memory.spawns.Spawn1 = { queue: [] };
            room.memory.srcDescs = {};
            room.memory.srcDescs[S1] = { marker: 'SEED', totalPlaces: 3, freePlaces: 111,
                needWork: 5, hasWork: 0, timeTo: 3, needCarry: 1, hasCarry: 0, srcId: S1 };
            room.memory.roles = { mule: { memory: { efficiency: 2 } },
                harvester: { memory: { efficiency: 2 } } };
            Memory.ord.seeded = true;
        }
        // ---- require-time + abstract interface results (once) ---------------
        if (!Memory.ord.req) {
            Memory.ord.req = {
                pp: CAP(function () { return require('room.pathPlanner'); }),
                sp: CAP(function () { return require('SpawnPlanner'); }),
                ep: CAP(function () { return require('EconomyPlanner'); }),
                hp: CAP(function () { return require('room.harvestPlanner'); }),
                cp: CAP(function () { return require('room.consumptionPlanner'); })
            };
            var Manager = require('Manager');
            var Consumer = require('Consumer');
            var A = {
                mc: CAP(function () { return new Manager(room, null); }),
                ml: CAP(function () { new Manager(room, null).load(); }),
                ms: CAP(function () { new Manager(room, null).save(); }),
                mn: CAP(function () { return new Manager(room, null).name; }),
                cn: CAP(function () { return new Consumer().name; }),
                cen: CAP(function () { return new Consumer().energyNeeded; }),
                cd: CAP(function () { return new Consumer().destination(); }),
                crt: CAP(function () { return new Consumer().rulesTemplate(); }),
                cpd: CAP(function () { return new Consumer().planDelivery(5); }),
                pct: CAP(function () { return new (require('Producer').Producer)().energyAvailable; }),
                pae: CAP(function () { return new (require('Producer').Producer)().availableEnergy; }),
                per: CAP(function () { return new (require('Producer').Producer)().energyRate; }),
                prt: CAP(function () { return new (require('Producer').Producer)().rulesTemplate(); }),
                pcn: CAP(function () { return new (require('Producer').Producer)().creepNeeded(); }),
                pmx: CAP(function () {
                    var Mixed = require('Producer').ProducerMixin(Consumer);
                    return new Mixed().energyAvailable;
                })
            };
            Memory.ord.abs = A;
        }
        // ---- per-tick dormant calls (self-gated inside production code) ------
        // Error evidence is aggregated ({n,m,c,ft,lt}) — 101 per-tick rows
        // would exceed the CLI evidence-size limit.
        var calls = {
            eco: function () { require('EconomyPlanner').run(); },
            hp: function () { require('room.harvestPlanner').run(); },
            cmp: function () { require('room.consumptionPlanner').run(); },
            sp: function () { require('SpawnPlanner').run(); }
        };
        for (var nm in calls) {
            var r = CAP(calls[nm]);
            if (!r.ok) {
                var er = Memory.ord.er = Memory.ord.er || {};
                var e = er[nm] = er[nm] || { n: r.n, m: r.m, c: 0, ft: Game.time, lt: 0 };
                e.c++; e.lt = Game.time;
            }
        }
        // observe serialized costMatrix size, then delete (evidence budget)
        var cmr = CAP(function () {
            if (room.memory.costMatrix) {
                var len = room.memory.costMatrix.length;
                delete room.memory.costMatrix;
                return { t: Game.time, len: len };
            }
            return null;
        });
        if (cmr.ok && cmr.v) {
            Memory.ord.cm = Memory.ord.cm || [];
            Memory.ord.cm.push(cmr.v);
        }
        Memory.ord.lt = Game.time;
        Memory.ord.flagsAtEnd = Memory.flags;
        if (Game.time >= 102) Memory.ord.done = true;
    } catch (e) {
        Memory.ord = Memory.ord || {};
        Memory.ord.err = String(e && e.message || e).slice(0, 80);
        Memory.ord.done = true;
    }
};
`;
    const { modules, hashes } = prodModules('dist', DIST_MODULES);
    modules.main = main;
    hashes.main = crypto.createHash('sha256').update(main).digest('hex');
    return { modules, hashes };
}

// ---------------------------------------------------------------------------
// ORD-04-api — isolated runtime API checks (mapPatch + logger), dist | dist2.
// Tick a: API surface observations + global pollution probe. Tick b: reload
// behavior (logger.load from Memory.loggerState), done.
// ---------------------------------------------------------------------------
function ord04ApiEntrypoint(ctx, dist) {
    const MODS = ['mapPatch', 'logger'];
    const main = `${CAP_FN}
require('mapPatch');
module.exports.loop = function () {
    try {
        Memory.ord = Memory.ord || {};
        if (!Memory.ord.a) {
            var R = { t: Game.time };
            R.mfo = CAP(function () {
                var m = Map.fromObject({ a: 1, b: 2 });
                return { is: m instanceof Map, n: m.size, a: m.get('a'), b: m.get('b') };
            });
            R.mto = CAP(function () {
                var m = new Map(); m.set('x', 5); m.set('y', 6);
                var o = m.toObject();
                return { x: o.x, y: o.y };
            });
            // global 'result' pollution after toObject()
            R.gr = CAP(function () {
                return { t: typeof result,
                    v: (typeof result !== 'undefined') ? result : null };
            });
            R.mf = CAP(function () {
                var m = new Map(); m.set('x', 5); m.set('y', 1);
                var fv = m.filter(function (v) { return v > 3; });
                var fe = m.filter(function (e) { return e[1] > 3; });
                return { valPred: fv.size, entryPred: fe.size, entryHasX: fe.has('x') };
            });
            R.fe = CAP(function () { return [].flat(); });
            R.f0 = CAP(function () { return [[1], [2]].flat(0); });
            R.f1 = CAP(function () { return [[1, 2], [3]].flat(); });
            R.f2 = CAP(function () { return [[1, 2], [3]].flat(2); });
            R.fn1 = CAP(function () { return [[[1], [2]]].flat(); });
            R.fn2 = CAP(function () { return [[[1], [2]]].flat(2); });
            R.fnat = CAP(function () {
                return /native code/.test(Array.prototype.flat.toString());
            });
            var logger = require('logger');
            R.lg = { i: logger.currentLevel };
            logger.setLevel('warn');
            R.lg.w = logger.currentLevel;
            logger.setLevel('bogus');
            R.lg.b = logger.currentLevel;
            R.lg.lc = CAP(function () { return logger.log('warn', 'probe'); });
            R.lg.st = Memory.loggerState && Memory.loggerState.currentLevel;
            // persist a level directly — next tick proves load() restores it
            Memory.loggerState = { currentLevel: 'error' };
            Memory.ord.a = R;
        } else if (!Memory.ord.b) {
            var R2 = { t: Game.time };
            var logger = require('logger');
            R2.lb = logger.currentLevel;
            logger.load();
            R2.la = logger.currentLevel;
            R2.gr2 = CAP(function () { return typeof result; });
            Memory.ord.b = R2;
            Memory.ord.done = true;
        }
    } catch (e) {
        Memory.ord = Memory.ord || {};
        Memory.ord.err = String(e && e.message || e).slice(0, 80);
        Memory.ord.done = true;
    }
};
`;
    const { modules, hashes } = prodModules(dist, MODS);
    modules.main = main;
    hashes.main = crypto.createHash('sha256').update(main).digest('hex');
    return { modules, hashes };
}

module.exports = { prodModules, ord01Entrypoint, ord02Entrypoint, ord03Entrypoint, ord04Entrypoint, ord04ApiEntrypoint };
