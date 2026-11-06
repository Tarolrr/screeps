'use strict';
// ECO scenario entrypoints — the in-game `main` module source per mode.
//
// Every entrypoint drives REAL public methods on REAL Game objects (no
// production rewrite, no Game/engine substitution, no verified-result
// writes):
//   dist  — a test `parent` object stands in for RoomManager's surface
//           (managers Map + sourceManagers). The manager construction and
//           consumer/producer registration reproduce RoomManager.js:11-51,
//           the per-tick order reproduces RoomManager.run() :58-107 minus the
//           queueCreeps do/while (single-executor scenarios: the mule is the
//           only worker, seeded directly as fixture memory). The whole
//           manager graph is kept in `global` across ticks so real
//           plannedDeliveries pending survives fences; when the engine wipes
//           the runtime the graph is rebuilt through the real ctor/load path
//           (S.gbuild records the rebuild tick). Role dispatch mirrors
//           dist/main.js:33-50, per-creep try so a role throw lands in
//           Memory.eco.errs as evidence (production wraps the whole loop —
//           with a single subject creep the deviation is nil).
//   dist2 — real controllers (`RoomController.initialize`,
//           `SourceController.initialize`, `rm.applyResource`,
//           `SpawnController.reconcile`) plus `roles.run` dispatch exactly
//           like dist2/main.js:42-54. rm.load()/rm.save() frame every tick.
//           Fixture creep memory is copied from the REAL order spec memory
//           (copyOrderMemory) — verbatim what spawnCreep(order.memory) would
//           install — or written as declared fixture input.
//
// Evidence lands in Memory.eco (compact CAP/done records only — see the
// ~10 KB eval-truncation constraint in docs/testing/orders.md). Per-tick
// state (Memory.managers, Memory.creeps, Memory.resourceManager, room
// objects) is read probe-side from frame data, never stored twice.
// DeliveryManager.save() output carries a multi-KB serialized costMatrix:
// after the real save() call the field is replaced in Memory by the marker
// 'REC' + its real length (costMatrixLen) so the field-set read stays
// coherent; routes/producers/plannedDeliveries are kept verbatim. The
// DeliveryManager.load() deserialize path is therefore NOT exercised —
// recorded as a documented limit.
//
//   CAP(fn) — capture {ok:true,v} / {ok:false,n:<errname>,m:<msg<=60ch>}.
//   Memory.eco.done — set when the scenario window ended.

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
// dist tree — SourceManager/DeliveryManager/SpawnManager/StorageManager/
// ControllerManager + role.harvester/role.mule/role.upgrader on real objects.
// Modules are read verbatim from dist/; `parent` is the only test object.
// ---------------------------------------------------------------------------
const DIST_MODULES = ['mapPatch', 'logger', 'creepUtils', 'SourceDesc', 'Manager',
    'Consumer', 'Producer', 'CreepOwner', 'SourceManager', 'DeliveryManager',
    'SpawnManager', 'StorageManager', 'ControllerManager', 'CreepPlanner',
    'room.harvestPlanner', 'role.harvester', 'role.mule', 'role.upgrader'];

// cfg: {
//   managers        build the manager graph (ECO-02)
//   consumers       subset of ['ctrl','spn','str'] registered via
//                   dlv.addConsumer (RoomManager.js:46-48 order);
//                   [] registers none (no-route variant)
//   queueSeed       N x real spn.queueCreep('harvester',{assignedSource:S1})
//                   at init — makes SpnM.energyNeeded > 0 (spawn route)
//   muleSrc         'SrcM' | 'StrM' | null — mule memory.src manager name
//   creepMemory     {name: memObj} written at init when absent (fixture)
//   roleOnly        [names] — dispatch whitelist (null = all creeps, as main)
//   kill            {t, name} — real creep.suicide() at user tick t
//   doneT           user Game.time at which Memory.eco.done is set
// }
function dEntrypoint(ctx, cfg) {
    const main = `${CAP_FN}
var S1 = ${JSON.stringify(ctx.s1)};
var ROOM = ${JSON.stringify(ctx.room)};
var CFG = ${JSON.stringify(cfg)};
module.exports.loop = function () {
    try {
        Memory.eco = Memory.eco || {};
        var S = Memory.eco;
        if (Memory.creepId === undefined) { Memory.creepId = 0; Memory.managers = {}; }
        Memory.managers = Memory.managers || {};
        Memory.creeps = Memory.creeps || {};
        var room = Game.rooms[ROOM];
        require('logger').load();
        // Production main.js:1 — side-effect require: installs
        // Map.prototype.filter/toObject, Map.fromObject, Array.prototype.flat.
        // No manager module requires it, so it must be required here exactly
        // like production does, or role.mule's parent.managers.filter() and
        // DeliveryManager's (from|to)Object throw TypeError.
        require('mapPatch');
        // Manager graph kept in global across ticks: real objects persist, so
        // DeliveryManager.plannedDeliveries survives fences without a fake
        // reload. Engine runtime wipes rebuild it through the real ctor path.
        var G = global.__eco = global.__eco || {};
        var spn = null, src = null, str = null, ctrl = null, dlv = null;
        if (CFG.managers) {
            if (!G.built) {
                G.parent = { managers: new Map(), sourceManagers: [] };
                var SpawnManager = require('SpawnManager');
                var StorageManager = require('StorageManager');
                var ControllerManager = require('ControllerManager');
                var SourceManager = require('SourceManager');
                var DeliveryManager = require('DeliveryManager');
                // RoomManager.js:20-38 construction order
                spn = new SpawnManager(room, G.parent);
                G.parent.managers.set(spn.name, spn);
                str = new StorageManager(room, spn.spawn.pos, G.parent);
                G.parent.managers.set(str.name, str);
                ctrl = new ControllerManager(room, G.parent);
                G.parent.managers.set(ctrl.name, ctrl);
                src = new SourceManager(room, Game.getObjectById(S1), G.parent);
                G.parent.sourceManagers.push(src);
                G.parent.managers.set(src.name, src);
                dlv = new DeliveryManager(room, G.parent);
                G.parent.managers.set(dlv.name, dlv);
                // RoomManager.js:46-51 registrations (consumers cfg-bound),
                // gated on the RM memory slot exactly like the production
                // ctor early-return at RoomManager.js:41-44 — after a global
                // wipe rebuild the DeliveryManager ctor's own load() already
                // restored routes/producers by name, so re-registering would
                // duplicate them.
                if (!((ROOM + '_RM') in Memory.managers)) {
                    var cns = { ctrl: ctrl, spn: spn, str: str };
                    (CFG.consumers || []).forEach(function (k) { dlv.addConsumer(cns[k]); });
                    if (CFG.producer !== false) dlv.registerProducer(src);
                }
                G.spn = spn; G.str = str; G.ctrl = ctrl; G.src = src; G.dlv = dlv;
                G.built = true;
                S.gbuild = Game.time;
            }
            spn = G.spn; src = G.src; str = G.str; ctrl = G.ctrl; dlv = G.dlv;
            // RoomManager.run() order (dist/RoomManager.js:60-64) minus the
            // queueCreeps do/while: single-executor scenarios. Each manager
            // call is CAP'd so a manager-side crash (e.g. removed spawn row)
            // is recorded as evidence instead of masking the role-level
            // defect the fence is watching — production wraps the whole loop.
            var r;
            r = CAP(function () { spn.run(); }); if (!r.ok) (S.mgrErr = S.mgrErr || []).push({ t: Game.time, m: 'spn', n: r.n });
            r = CAP(function () { src.run(); }); if (!r.ok) (S.mgrErr = S.mgrErr || []).push({ t: Game.time, m: 'src', n: r.n });
            r = CAP(function () { str.run(); }); if (!r.ok) (S.mgrErr = S.mgrErr || []).push({ t: Game.time, m: 'str', n: r.n });
            r = CAP(function () { dlv.run(); }); if (!r.ok) (S.mgrErr = S.mgrErr || []).push({ t: Game.time, m: 'dlv', n: r.n });
            r = CAP(function () { ctrl.run(); }); if (!r.ok) (S.mgrErr = S.mgrErr || []).push({ t: Game.time, m: 'ctrl', n: r.n });
            if (CFG.queueSeed && !S.qs) {
                S.qs = [];
                for (var i = 0; i < CFG.queueSeed; i++) {
                    var qc = CAP(function () { return spn.queueCreep('harvester', { assignedSource: S1 }); });
                    if (qc.ok && qc.v) S.qs.push({ n: qc.v.name, c: qc.v.cost });
                    else S.qs.push({ err: qc.n });
                }
            }
            // RoomManager.save() order (RoomManager.js:93-106): spn, str,
            // dlv, ctrl, then sources. CAP'd for the same evidence reason as
            // run() — e.g. a removed spawn makes SpnM.save() throw on
            // this.spawn.id, which would otherwise abort the tick's role
            // dispatch and hide the wedge.
            r = CAP(function () { spn.save(); }); if (!r.ok) (S.mgrErr = S.mgrErr || []).push({ t: Game.time, m: 'sav-spn', n: r.n });
            r = CAP(function () { str.save(); }); if (!r.ok) (S.mgrErr = S.mgrErr || []).push({ t: Game.time, m: 'sav-str', n: r.n });
            r = CAP(function () { dlv.save(); }); if (!r.ok) (S.mgrErr = S.mgrErr || []).push({ t: Game.time, m: 'sav-dlv', n: r.n });
            r = CAP(function () { ctrl.save(); }); if (!r.ok) (S.mgrErr = S.mgrErr || []).push({ t: Game.time, m: 'sav-ctrl', n: r.n });
            r = CAP(function () { src.save(); }); if (!r.ok) (S.mgrErr = S.mgrErr || []).push({ t: Game.time, m: 'sav-src', n: r.n });
            // RM slot marker — production RoomManager.save() writes it every
            // tick (RoomManager.js:94-97); it is what gates the registration
            // early-return on rebuilt graphs.
            Memory.managers[ROOM + '_RM'] = { room: ROOM };
            if (S.mgrErr && S.mgrErr.length > 12) S.mgrErr = S.mgrErr.slice(0, 12);
            var me = Memory.managers[dlv.name];
            if (me && me.costMatrix && me.costMatrix.data) {
                me.costMatrixLen = me.costMatrix.data.length;
                me.costMatrix = 'REC'; // evidence-size marker, load() not exercised
            }
        }
        // fixture memory (production installs it via spawnCreep memory opts)
        if (CFG.creepMemory) {
            for (var mn in CFG.creepMemory) {
                if (Memory.creeps[mn] === undefined) Memory.creeps[mn] = CFG.creepMemory[mn];
            }
        }
        if (CFG.kill && Game.time === CFG.kill.t) {
            var kc = Game.creeps[CFG.kill.name];
            S.kill = kc ? CAP(function () { return kc.suicide(); })
                : { ok: false, n: 'probe', m: 'kill target absent: ' + CFG.kill.name };
        }
        // role dispatch (dist/main.js:33-50), per-creep capture for evidence
        for (var nm in Game.creeps) {
            var creep = Game.creeps[nm];
            if (CFG.roleOnly && CFG.roleOnly.indexOf(nm) === -1) continue;
            if (!creep.memory.role) continue;
            try {
                if (creep.memory.role === 'harvester') require('role.harvester').run(creep);
                else if (creep.memory.role === 'mule') require('role.mule').run(creep);
                else if (creep.memory.role === 'upgrader') require('role.upgrader').run(creep);
            } catch (e) {
                S.errs = S.errs || [];
                if (S.errs.length < 5) S.errs.push({ t: Game.time, n: nm, k: e && e.name, e: String(e && e.message || e).slice(0, 60) });
            }
        }
        S.t = Game.time;
        if (Game.time >= CFG.doneT) S.done = true;
    } catch (e) {
        Memory.eco = { err: String(e && e.stack || e).slice(0, 120), done: true };
    }
};
`;
    const { modules, hashes } = prodModules('dist', DIST_MODULES);
    modules.main = main;
    hashes.main = crypto.createHash('sha256').update(main).digest('hex');
    return { modules, hashes };
}

// ---------------------------------------------------------------------------
// dist2 tree — real controllers + resourceManager + roles.run dispatch.
// cfg: {
//   useRoomCtrl / useSrcCtrl   call the real <controller>.initialize() at t1
//   apiOrders                  [{t, spec}] real rm.applyResource at tick t
//   copyOrderMemory            {creepName: orderId} — copy the REAL order's
//                              memory verbatim into the fixture creep memory
//   creepMemory                {name: memObj} fixture memory when absent
//   reconcileSpawn             run SpawnController.reconcile() every tick
//                              (needed only for the %10 cleanup variant)
//   directRole                 {name, role} — extra direct module call inside
//                              CAP (error evidence for throw-variants)
//   roleOnly                   [names] — dispatch whitelist (null = all)
//   kill                       {t, name} — real creep.suicide()
//   doneT                      done tick
// }
// ---------------------------------------------------------------------------
const D2_MODULES = ['mapPatch', 'logger', 'resourceManager', 'resources.Resource',
    'resources.sourceResource', 'resources.creepOrder', 'resources.spawnProcess',
    'utils.priority', 'role.harvester', 'role.mule', 'role.upgrader',
    'role.builder', 'roles', 'SourceController', 'SpawnController',
    'RoomController'];

const D2_LOAD_RM = `
var RM_MODULES = ${JSON.stringify(D2_MODULES)};
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
        Memory.eco = Memory.eco || {};
        var S = Memory.eco;
        Memory.creeps = Memory.creeps || {};
        // Production dist2/main.js top-level requires, same side-effect
        // reason as dist (prototype patches live only in mapPatch.js).
        require('mapPatch');
        var rm = loadRM();
        rm.load();
        if (!S.init) {
            if (CFG.useSrcCtrl) require('SourceController').initialize();
            if (CFG.useRoomCtrl) require('RoomController').initialize();
            (CFG.apiOrders || []).forEach(function (ao) {
                if (ao.t === undefined || ao.t === Game.time) rm.applyResource('creepOrder', ao.spec);
            });
            S.init = Game.time;
        }
        (CFG.apiOrders || []).forEach(function (ao) {
            if (ao.t === Game.time) rm.applyResource('creepOrder', ao.spec);
        });
        // fixture creep memory: verbatim order memory (what spawnCreep
        // installs for a real spawned creep) or declared input
        if (CFG.copyOrderMemory) {
            for (var cn in CFG.copyOrderMemory) {
                var ord = rm.getResourceByTypeAndId('creepOrder', CFG.copyOrderMemory[cn]);
                if (ord && Memory.creeps[cn] === undefined) {
                    Memory.creeps[cn] = JSON.parse(JSON.stringify(ord.memory));
                    (S.copied = S.copied || []).push({ n: cn, from: CFG.copyOrderMemory[cn], t: Game.time });
                }
            }
        }
        if (CFG.creepMemory) {
            for (var mn in CFG.creepMemory) {
                if (Memory.creeps[mn] === undefined) Memory.creeps[mn] = CFG.creepMemory[mn];
            }
        }
        if (CFG.kill && Game.time === CFG.kill.t) {
            var kc = Game.creeps[CFG.kill.name];
            S.kill = kc ? CAP(function () { return kc.suicide(); })
                : { ok: false, n: 'probe', m: 'kill target absent: ' + CFG.kill.name };
        }
        // role dispatch (dist2/main.js:42-45) through the real dispatcher
        for (var nm in Game.creeps) {
            var creep = Game.creeps[nm];
            if (CFG.roleOnly && CFG.roleOnly.indexOf(nm) === -1) continue;
            if (!creep.memory.role) continue;
            try {
                require('roles').run(creep);
            } catch (e) {
                S.errs = S.errs || [];
                if (S.errs.length < 5) S.errs.push({ t: Game.time, n: nm, k: e && e.name, e: String(e && e.message || e).slice(0, 60) });
            }
        }
        // direct module call for throw-evidence variants (roles.run would
        // swallow the throw into console.log, invisible probe-side)
        if (CFG.directRole) {
            var dc = Game.creeps[CFG.directRole.name];
            if (dc) {
                var mod = require('role.' + CFG.directRole.role);
                S.direct = CAP(function () { mod.run(dc); return 1; });
            }
        }
        // production reconcile order (dist2/main.js:48-54), cfg-bound
        if (CFG.reconcileSource) require('SourceController').reconcile();
        if (CFG.reconcileSpawn) require('SpawnController').reconcile();
        rm.save();
        S.t = Game.time;
        if (Game.time >= CFG.doneT) S.done = true;
    } catch (e) {
        Memory.eco = { err: String(e && e.stack || e).slice(0, 120), done: true };
    }
};
`;
    const { modules, hashes } = prodModules('dist2', D2_MODULES);
    modules.main = main;
    hashes.main = crypto.createHash('sha256').update(main).digest('hex');
    return { modules, hashes };
}

// Minimal loop for no-creep control / fixture-refusal modes.
const CONTROL_SOURCE = `module.exports.loop = function () { Memory.eco = { t: Game.time }; };`;
function controlEntrypoint() {
    const modules = { main: CONTROL_SOURCE };
    const hashes = { main: crypto.createHash('sha256').update(CONTROL_SOURCE).digest('hex') };
    return { modules, hashes };
}

module.exports = { dEntrypoint, d2Entrypoint, controlEntrypoint, DIST_MODULES, D2_MODULES };
