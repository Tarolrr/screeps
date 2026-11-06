'use strict';
// SPN scenario entrypoints — the in-game `main` module source per mode.
//
// Every entrypoint drives REAL public methods on REAL objects (no production
// rewrite, no Game/engine substitution, no verified-result writes):
//   dist  — a test `parent` object stands in for RoomManager's surface while
//           the call order, selection loop, queue and save paths are exactly
//           dist/RoomManager.js:58-107 (spnMgr.run -> srcMgr.run ->
//           queueCreeps do/while -> save). All manager objects are real
//           production classes (SourceManager, SpawnManager, DeliveryManager,
//           CreepOwner).
//   dist2 — the real SourceController/SpawnController singletons are invoked
//           every tick exactly like dist2/main.js (reconcile + rm.save);
//           orders come from sourceController.initialize() (real order
//           creation) or rm.applyResource (real public API input).
//
// Evidence lands in Memory.spn (compact action records only — see the 10 KB
// eval-truncation constraint documented in docs/testing/orders.md). Per-tick
// queue/order/process state is read probe-side from the frame's user Memory
// (Memory.managers / Memory.resourceManager / Memory.creeps), never stored
// twice.
//
//   CAP(fn) — capture {ok:true,v} / {ok:false,n:<errname>,m:<msg<=60ch>}.
//   Memory.spn.done — set when the scenario finished all its phases.

const crypto = require('crypto');
const { prodModules } = require('../ord/entrypoints');

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

// ---------------------------------------------------------------------------
// dist tree — SourceManager/SpawnManager request + process the real queue.
// Modules are read verbatim from dist/; `parent` is the only test object and
// emulates RoomManager's fields (managers map, sourceManagers list).
// ---------------------------------------------------------------------------
const DIST_MODULES = ['mapPatch', 'logger', 'creepUtils', 'SourceDesc', 'Manager',
    'Consumer', 'Producer', 'CreepOwner', 'SourceManager', 'DeliveryManager',
    'SpawnManager', 'CreepPlanner', 'room.harvestPlanner'];

// cfg: {mode, expectName, killTick, done: <tick|0 born+2|-1 reload+1>, stub}
function dEntrypoint(ctx, cfg) {
    const main = `${CAP_FN}
var MODS = ${JSON.stringify(DIST_MODULES)};
var S1 = ${JSON.stringify(ctx.s1)};
var ROOM = ${JSON.stringify(ctx.room)};
var MODE = ${JSON.stringify(cfg.mode)};
var EXPECT = ${JSON.stringify(cfg.expectName || 'harvester0')};
var KILL = ${JSON.stringify(cfg.killTick || 0)};
var DONERULE = ${JSON.stringify(cfg.done !== undefined ? cfg.done : 0)};
function wipe() { for (var i = 0; i < MODS.length; i++) delete require.cache[MODS[i]]; }
module.exports.loop = function () {
    try {
        Memory.spn = Memory.spn || {};
        var S = Memory.spn;
        if (Memory.creepId === undefined) { Memory.creepId = 0; Memory.managers = {}; }
        Memory.managers = Memory.managers || {};
        Memory.creeps = Memory.creeps || {};
        if (MODE === 'nameexists' && Game.time === 1 && Game.creeps[EXPECT]) {
            // seed the foreign creep as a harvester (production-style memory)
            Memory.creeps[EXPECT] = { role: 'harvester', efficiency: 1, assignedSource: S1 };
        }
        // runtime reload: re-require everything the tick after birth so the
        // manager constructor load() path rebinds saved names -> Game objects
        if (S.bornTick !== undefined && Game.time === S.bornTick + 1 && S.rl === undefined) {
            wipe(); S.rlT = Game.time;
        }
        var room = Game.rooms[ROOM];
        require('logger').load();
        var SourceManager = require('SourceManager');
        var SpawnManager = require('SpawnManager');
        var DeliveryManager = require('DeliveryManager');
        var CreepOwner = require('CreepOwner');
        var parent = { managers: new Map(), sourceManagers: [] };
        var src = new SourceManager(room, Game.getObjectById(S1), parent);
        parent.sourceManagers.push(src); parent.managers.set(src.name, src);
        var spn = new SpawnManager(room, parent);
        parent.managers.set(spn.name, spn);
        // real DeliveryManager instance: seeds DeliveryManager.cache, which
        // SpawnManager.save() -> energyNeeded requires. No consumers/routes
        // are registered (delivery layer out of scope for SPN).
        var dlv = new DeliveryManager(room, parent);
        parent.managers.set(dlv.name, dlv);
        ${cfg.stub ? `
        // variant 'priority': a stub consumer at priority 8 exercises the real
        // RoomManager.queueCreeps selection (mule queued before harvesters).
        var Manager = require('Manager');
        var stub = new Manager(room, parent);
        var stubName = 'StubM';
        stub.creepOwner = new CreepOwner(stub);
        Object.defineProperty(stub, 'name', { get: function () { return stubName; } });
        Object.defineProperty(stub, 'features', { get: function () { return new Set(['CreepOwner']); } });
        Object.defineProperty(stub, 'creepNeeded', { value: function () {
            return (this.creepOwner.creeps.length + this.creepOwner.creepsQueued.length) === 0 ?
                { role: 'mule', memory: { src: stubName }, priority: 8 } : null;
        } });
        // persist like a real manager: reload saved owner state each tick
        if (Memory.managers[stubName]) {
            var smm = Memory.managers[stubName];
            smm.creeps = smm.creeps || []; smm.creepsQueued = smm.creepsQueued || [];
            stub.creepOwner.load(smm);
        }
        parent.managers.set(stubName, stub);` : ''}
        if (S.rlT !== undefined && S.rl === undefined) {
            S.rl = { t: Game.time,
                c: src.creepOwner.creeps.map(function (c) { return c.name; }),
                q: src.creepOwner.creepsQueued.map(function (q) { return q.name; }),
                spawnQ: spn.queue.map(function (q) { return q.name; }) };
        }
        // ==== RoomManager.run() call order (dist/RoomManager.js:58-107) ====
        spn.run();
        src.run();
        ${cfg.stub ? `stub.creepOwner.run(); // each production manager runs its own creepOwner
        var smm = Memory.managers[stubName] = Memory.managers[stubName] || {};
        stub.creepOwner.save(smm);` : ''}
        var need, sel;
        do {
            need = null; sel = null;
            parent.managers.forEach(function (m) {
                var t = m.creepNeeded && m.creepNeeded();
                if (t && (!need || t.priority > need.priority)) { need = t; sel = m; }
            });
            if (need) { var qc = spn.queueCreep(need.role, need.memory); sel.creepOwner.addCreep(qc); }
        } while (need);
        spn.save(); src.save();
        // ---- variant hooks (real API calls as inputs) ----
        if (MODE === 'occupied' && Game.time === 1) {
            S.occ = CAP(function () { return room.find(FIND_MY_SPAWNS)[0].spawnCreep(['move'], 'occ'); });
        }
        if (MODE === 'deadq' && S.bornTick !== undefined && Game.time === S.bornTick + 2) {
            S.kill = Game.creeps[EXPECT] ?
                Object.assign(CAP(function () { return Game.creeps[EXPECT].suicide(); }), { t: Game.time }) :
                { ok: false, n: 'probe', m: 'expected creep absent at kill tick' };
        }
        var c = Game.creeps[EXPECT];
        if (c && !c.spawning && S.bornTick === undefined) S.bornTick = Game.time;
        if (DONERULE === -1) { if (S.rl && Game.time >= S.rl.t + 1) S.done = true; }
        else if (DONERULE === 0) { if (S.bornTick !== undefined && Game.time >= S.bornTick + (MODE === 'deadq' ? 5 : 2)) S.done = true; }
        else if (Game.time >= DONERULE) S.done = true;
    } catch (e) {
        Memory.spn = { err: String(e && e.stack || e).slice(0, 120), done: true };
    }
};
`;
    const { modules, hashes } = prodModules('dist', DIST_MODULES);
    modules.main = main;
    hashes.main = crypto.createHash('sha256').update(main).digest('hex');
    return { modules, hashes };
}

// ---------------------------------------------------------------------------
// dist2 tree — real SourceController/SpawnController reconcile path.
// cfg (JSON, embedded): {
//   useSrcCtrl            call sourceController.initialize() at tick 1
//   apiOrders             [{t, spec}] applied via rm.applyResource at Game.time t
//   forced                [{t, id, fields}] direct state-field writes at t
//                         (fields.expiryAdd sets expiryTime=Game.time+value)
//   directSpawn           [{t, name, body}] entrypoint real spawnCreep at t
//   kill                  {t, name} real creep.suicide() at t
//   expectOrder           annotation/id of the order whose lifecycle is proven
//   reloadLag             wipe+rm.load() at S.act+reloadLag (SPN-02)
//   done                  Game.time at which Memory.spn.done is set
// }
// ---------------------------------------------------------------------------
const D2_MODULES = ['mapPatch', 'logger', 'resourceManager', 'resources.Resource',
    'resources.sourceResource', 'resources.creepOrder', 'resources.spawnProcess',
    'utils.priority', 'SourceController', 'SpawnController'];

const D2_LOAD_RM = `
var RM_MODULES = ${JSON.stringify(D2_MODULES)};
function wipe() { for (var i = 0; i < RM_MODULES.length; i++) delete require.cache[RM_MODULES[i]]; }
function loadRM() {
    var rm = require('resourceManager');
    rm.registerResourceType('source', require('resources.sourceResource'));
    rm.registerResourceType('creepOrder', require('resources.creepOrder'));
    rm.registerResourceType('spawnProcess', require('resources.spawnProcess'));
    return rm;
}
`;

function d2Entrypoint(ctx, cfg) {
    const main = `${CAP_FN}
var S1 = ${JSON.stringify(ctx.s1)};
var S2 = ${JSON.stringify(ctx.s2)};
var ROOM = ${JSON.stringify(ctx.room)};
var CFG = ${JSON.stringify(cfg)};
${D2_LOAD_RM}
module.exports.loop = function () {
    try {
        Memory.spn = Memory.spn || {};
        var S = Memory.spn;
        var rm = loadRM();
        rm.load();
        // runtime reload once, at activation+reloadLag (SPN-02)
        if (CFG.reloadLag && S.act !== undefined && S.rl === undefined &&
            Game.time >= S.act + CFG.reloadLag) {
            wipe(); rm = loadRM(); rm.load(); S.rlT = Game.time;
        }
        var room = Game.rooms[ROOM];
        if (!S.init) {
            if (CFG.useSrcCtrl) require('SourceController').initialize();
            S.init = Game.time;
        }
        (CFG.apiOrders || []).forEach(function (ao) {
            if (ao.t === Game.time) rm.applyResource('creepOrder', ao.spec);
        });
        (CFG.forced || []).forEach(function (f) {
            if (f.t !== Game.time) return;
            var r = rm.getResourceByTypeAndId('creepOrder', f.id);
            if (!r) { (S.forceMiss = S.forceMiss || []).push(f.id); return; }
            for (var k in f.fields) {
                if (k === 'expiryAdd') r.expiryTime = Game.time + f.fields[k];
                else r[k] = f.fields[k];
            }
        });
        (CFG.directSpawn || []).forEach(function (d) {
            if (d.t === Game.time) {
                var sp = room.find(FIND_MY_SPAWNS)[0];
                S.direct = CAP(function () { return sp.spawnCreep(d.body, d.name); });
            }
        });
        if (CFG.kill && Game.time === CFG.kill.t) {
            var kc = Game.creeps[CFG.kill.name];
            S.kill = kc ? CAP(function () { return kc.suicide(); })
                : { ok: false, n: 'probe', m: 'kill target absent: ' + CFG.kill.name };
        }
        // ==== production loop order (dist2/main.js) ====
        require('SourceController').reconcile();
        require('SpawnController').reconcile();
        rm.save();
        // track the probed order's activation for reload/done timing
        if (CFG.expectOrder) {
            var ord = rm.getResourceByTypeAndId('creepOrder', CFG.expectOrder);
            if (ord && ord.status === 'active' && S.act === undefined) {
                S.act = Game.time;
                S.actInfo = { cn: ord.creepName, ex: ord.expiryTime };
            }
        }
        if (S.rlT !== undefined && S.rl === undefined) {
            var o2 = rm.getResourceByTypeAndId('creepOrder', CFG.expectOrder);
            S.rl = { t: Game.time, st: o2 && o2.status, cn: o2 && o2.creepName,
                inst: o2 instanceof require('resources.creepOrder'),
                alive: !!(o2 && o2.creepName && Game.creeps[o2.creepName] &&
                    !Game.creeps[o2.creepName].spawning) };
        }
        if (Game.time >= CFG.done) S.done = true;
    } catch (e) {
        Memory.spn = { err: String(e && e.stack || e).slice(0, 120), done: true };
    }
};
`;
    const { modules, hashes } = prodModules('dist2', D2_MODULES);
    modules.main = main;
    hashes.main = crypto.createHash('sha256').update(main).digest('hex');
    return { modules, hashes };
}

module.exports = { dEntrypoint, d2Entrypoint, DIST_MODULES, D2_MODULES };
