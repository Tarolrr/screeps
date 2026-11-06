'use strict';
// BLD scenario entrypoints — the in-game `main` module source per mode.
//
// Every entrypoint calls REAL public methods on REAL Game objects: production
// modules are uploaded verbatim (SHA-256 recorded per frame) and invoked
// through the same call paths production uses (resourceManager.applyResource,
// controller.reconcile/handleConstructionSites, role.run, ConstructionManager).
// No production rewrite, no Game/engine substitution, no writes that stand in
// for verified results. Explicit INPUT fixtures (construction sites, damaged
// structures, energy piles, seeded creep Memory) are arranged probe-side and
// journaled; everything asserted afterwards comes from real engine state.
//
// EVIDENCE SIZE CONSTRAINT: user Memory is snapshotted through a single CLI
// print() line that truncates around ~10KB URI-encoded — Memory.bld evidence
// stays compact (error names + <=60ch messages, position pairs, counts, ids).
//
//   CAP(fn)  — capture {ok:true,v} / {ok:false,n:<errname>,m:<msg<=60ch>};
//              never store live object references into Memory (serialization
//              would bloat or fail): callers extract compact fields only.
//   Memory.bld.done — set when the scenario finished all its phases; the
//              probe-side postcondition reads it.

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
        var n = e && e.name; if (!n && e && e.constructor) n = e.constructor.name;
        return { ok: false, n: n || 'Error', m: String(e && e.message || e).slice(0, 60) };
    }
}
`;

// Register the dist2 resource types used by each mode before rm.load() so
// persisted rows rehydrate into real class instances (unregistered types load
// as plain objects — production main.js registers all four).
const RM_REGISTER_ALL = `
function loadRM() {
    var rm = require('resourceManager');
    rm.registerResourceType('source', require('resources.sourceResource'));
    rm.registerResourceType('creepOrder', require('resources.creepOrder'));
    rm.registerResourceType('spawnProcess', require('resources.spawnProcess'));
    rm.registerResourceType('constructionOrder', require('resources.constructionOrder'));
    return rm;
}
`;
const RM_REGISTER_CO = `
function loadRM() {
    var rm = require('resourceManager');
    rm.registerResourceType('constructionOrder', require('resources.constructionOrder'));
    return rm;
}
`;

function sha(src) { return crypto.createHash('sha256').update(src).digest('hex'); }

function withMain(main, dist, names) {
    const { modules, hashes } = prodModules(dist, names);
    modules.main = main;
    hashes.main = sha(main);
    return { modules, hashes };
}

// ===========================================================================
// BLD-01 — dist2 constructionPatterns registry on the real engine.
//   ctx: { room, spawn:{x,y}, wall:{x,y}, edge:{x,y}, pathFrom:{x,y}, pathTo:{x,y} }
// Phases (one per user tick to bound findPath CPU):
//   t1 geometry (all 6 area patterns x index/direction/filled variants)
//   t2 path flat-opts width1 full enumeration + width2 boundary + past-end
//   t3 path nested-opts (BuildController spec shape) + unreachable + wall
//      target + default-opts control
//   t4 patternPlacer: string terrain vs RoomTerrain object, wall target,
//      unknown pattern name, registry unknown name; done.
// ===========================================================================
const BLD01_MODULES = ['logger', 'constructionPatterns'];
function bld01Entrypoint(ctx) {
    const cfg = {
        room: ctx.room, spawn: ctx.spawn, wall: ctx.wall, edge: ctx.edge,
        from: ctx.pathFrom, to: ctx.pathTo,
    };
    const main = `${CAP_FN}
var CFG = ${JSON.stringify(cfg)};
var P = require('constructionPatterns').patterns;
function PP(arr) {
    var o = []; if (!arr) return null;
    for (var i = 0; i < arr.length; i++) { o.push(arr[i].x, arr[i].y); }
    return o;
}
function rec(id, fn) {
    var S = Memory.bld; S.r = S.r || {};
    var t0 = Game.cpu.getUsed();
    var c = CAP(fn);
    var u = Game.cpu.getUsed() - t0;
    var e = {};
    if (c.ok) {
        if (c.v && typeof c.v === 'object' && 'positions' in c.v) {
            e.p = PP(c.v.positions); e.o = c.v.outOfBounds ? 1 : 0;
        } else e.v = c.v;
    } else e.e = { n: c.n, m: c.m };
    e.c = Math.round(u * 100) / 100;
    S.r[id] = e;
}
function ix(opt, n) { return function () { return P.path.getPositions(opt, n); }; }
function enumPath(opt) {
    var seq = [], oob = -1, err = null, n = 0;
    for (var i = 0; i < 45; i++) {
        var c = CAP(ix(opt, i));
        if (!c.ok) { err = { i: i, n: c.n, m: c.m }; break; }
        if (c.v.outOfBounds) { oob = i; break; }
        var p = c.v.positions[0]; seq.push(p.x, p.y); n++;
    }
    return { n: n, seq: seq, oob: oob, e: err };
}
module.exports.loop = function () {
    Memory.bld = Memory.bld || {};
    var S = Memory.bld;
    try {
        if (S.t0 === undefined) S.t0 = Game.time;
        var rt = Game.time - S.t0 + 1; // user-relative tick: first loop tick is 1
        var sp = CFG.spawn;
        if (rt === 1) {
            rec('single0', function () { return P.single.getPositions({ startPos: sp }, 0); });
            rec('single_oob', function () { return P.single.getPositions({ startPos: sp }, 1); });
            rec('single_edge', function () { return P.single.getPositions({ startPos: CFG.edge }, 0); });
            rec('cb_all', function () { return P.checkboard.getPositions({ startPos: sp, size: 3 }); });
            rec('cb_i0', function () { return P.checkboard.getPositions({ startPos: sp, size: 3 }, 0); });
            rec('cb_i4', function () { return P.checkboard.getPositions({ startPos: sp, size: 3 }, 4); });
            rec('cb_oob', function () { return P.checkboard.getPositions({ startPos: sp, size: 3 }, 5); });
            rec('line_all', function () { return P.line.getPositions({ startPos: sp, size: 3 }); });
            rec('line_r', function () { return P.line.getPositions({ startPos: sp, size: 3, direction: 1 }); });
            rec('line_b', function () { return P.line.getPositions({ startPos: sp, size: 3, direction: 5 }); });
            rec('line_oob', function () { return P.line.getPositions({ startPos: sp, size: 3 }, 3); });
            rec('line_neg', function () { return P.line.getPositions({ startPos: sp, size: 3 }, -1); });
            rec('ring_all', function () { return P.ring.getPositions({ startPos: sp, radius: 3 }); });
            rec('ring_oob', function () { return P.ring.getPositions({ startPos: sp, radius: 3 }, 8); });
            rec('rect_h', function () { return P.rectangle.getPositions({ startPos: sp, width: 3, height: 2, filled: false }); });
            rec('rect_f', function () { return P.rectangle.getPositions({ startPos: sp, width: 3, height: 2, filled: true }); });
            rec('rect_oob', function () { return P.rectangle.getPositions({ startPos: sp, width: 3, height: 2 }, 6); });
            rec('pll_all', function () { return P.parallelLines.getPositions({ startPos: sp, size: 3 }); });
            rec('pll_oob', function () { return P.parallelLines.getPositions({ startPos: sp, size: 3 }, 12); });
        }
        if (rt === 2) {
            var FLAT = { roomName: CFG.room, fromPos: CFG.from, toPos: CFG.to,
                width: 1, ignoreCreeps: true, swampCost: 1, range: 1, ignoreRoads: true };
            var t0 = Game.cpu.getUsed();
            S.r.pathW1 = { v: enumPath(FLAT), c: Math.round((Game.cpu.getUsed() - t0) * 100) / 100 };
            var L = (S.r.pathW1.v && S.r.pathW1.v.n) || 0;
            var FLAT2 = { roomName: CFG.room, fromPos: CFG.from, toPos: CFG.to,
                width: 2, ignoreCreeps: true, swampCost: 1, range: 1, ignoreRoads: true };
            rec('pathW2_last', ix(FLAT2, 2 * L - 1));
            rec('pathW2_oob', ix(FLAT2, 2 * L));
            rec('path_big', ix(FLAT, 1000));
        }
        if (rt === 3) {
            var NEST = { roomName: CFG.room, fromPos: CFG.from, toPos: CFG.to, width: 1,
                opts: { ignoreCreeps: true, swampCost: 1, range: 1, ignoreRoads: true } };
            var t0 = Game.cpu.getUsed();
            S.r.pathNested = { v: enumPath(NEST), c: Math.round((Game.cpu.getUsed() - t0) * 100) / 100 };
            rec('path_noroom', ix({ roomName: 'Z9Z9', fromPos: CFG.from, toPos: CFG.to, width: 1 }, 0));
            rec('path_wall', ix({ roomName: CFG.room, fromPos: CFG.from, toPos: CFG.wall, width: 1 }, 0));
            rec('path_def', ix({ roomName: CFG.room, fromPos: CFG.from, toPos: CFG.to, width: 1 }, 0));
        }
        if (rt === 4) {
            var room = Game.rooms[CFG.room];
            var tObj = room.getTerrain();
            var tStr = '';
            for (var y = 0; y < 50; y++) for (var x = 0; x < 50; x++) {
                var v = tObj.get(x, y);
                tStr += (v === 1 ? '1' : (v === 2 ? '2' : (v === 3 ? '3' : '0')));
            }
            var PL = { pattern: 'line', patternArgs: { size: 3 }, terrain: tStr, targetPos: CFG.spawn };
            rec('pl_str', function () { return P.patternPlacer.getPositions(PL, 0); });
            rec('pl_obj', function () { return P.patternPlacer.getPositions(
                { pattern: 'line', patternArgs: { size: 3 }, terrain: tObj, targetPos: CFG.spawn }, 0); });
            rec('pl_wall_str', function () { return P.patternPlacer.getPositions(
                { pattern: 'single', patternArgs: {}, terrain: tStr, targetPos: CFG.wall }, 0); });
            rec('pl_wall_obj', function () { return P.patternPlacer.getPositions(
                { pattern: 'single', patternArgs: {}, terrain: tObj, targetPos: CFG.wall }, 0); });
            rec('pl_i1', function () { return P.patternPlacer.getPositions(PL, 1); });
            rec('pl_i5', function () { return P.patternPlacer.getPositions(PL, 5); });
            rec('pl_unknown', function () { return P.patternPlacer.getPositions(
                { pattern: 'nosuch', patternArgs: {}, terrain: tStr, targetPos: CFG.spawn }, 0); });
            rec('reg_unknown', function () { return P.nosuch.getPositions({ startPos: CFG.spawn }, 0); });
            rec('reg_checkerboard', function () { return P.checkerboard.getPositions({ startPos: CFG.spawn, size: 3 }, 0); });
            S.done = true;
        }
    } catch (e) { S.err = String(e && e.stack || e).slice(0, 300); }
};
`;
    return withMain(main, 'dist2', BLD01_MODULES);
}

// ===========================================================================
// BLD-02 dist — dormant ConstructionManager driven directly.
//   ctx: { room, ctrl:{x,y} }   (mode supplies rcl via fixture spec)
// Tick 1: fresh-constructor path (controller-less -> defect), then a seeded
// Memory.managers row (declared INPUT written inside the entrypoint) reaches
// the load() path; real calls: queueExtension, creepNeeded, run, save.
// ===========================================================================
const BLD02D_MODULES = ['mapPatch', 'logger', 'Manager', 'CreepOwner', 'ConstructionManager'];
function bld02DEntrypoint(ctx) {
    const cfg = { room: ctx.room, ctrl: ctx.ctrl };
    const main = `${CAP_FN}
var CFG = ${JSON.stringify(cfg)};
var ConstructionManager = require('ConstructionManager');
var parent = { managers: new Map(), sourceManagers: [] }; // RoomManager surface
module.exports.loop = function () {
    Memory.bld = Memory.bld || {};
    var S = Memory.bld;
    try {
        if (S.t0 === undefined) S.t0 = Game.time;
        var rt = Game.time - S.t0 + 1;
        if (rt === 1) {
            var room = Game.rooms[CFG.room];
            Memory.managers = Memory.managers || {};
            var c = CAP(function () { return new ConstructionManager(room, parent); });
            S.fresh = c.ok ? { ok: true } : { ok: false, n: c.n, m: c.m };
            // INPUT: seeded manager row so the load() path is reachable.
            var name = room.name + '_ConstructionManager';
            Memory.managers[name] = { priority: 3, queue: [],
                pos: { x: CFG.ctrl.x, y: CFG.ctrl.y }, creeps: [], creepsQueued: [] };
            var m = null;
            c = CAP(function () { m = new ConstructionManager(room, parent); });
            S.load = c.ok ? { ok: true } : { ok: false, n: c.n, m: c.m };
            if (m) {
                S.fields = {
                    priIsArr: Array.isArray(m.priority),
                    pos: [m.pos.x, m.pos.y],
                    qLen: Array.isArray(m.queue) ? m.queue.length : -1
                };
                var t0 = Game.cpu.getUsed();
                c = CAP(function () { return m.queueExtension(); });
                S.qe = { ok: c.ok, n: c.n, m: c.m, c: Math.round((Game.cpu.getUsed() - t0) * 100) / 100 };
                c = CAP(function () { return m.creepNeeded(); });
                S.cn = c.ok ? { ok: true, v: c.v && c.v.role } : { ok: false, n: c.n, m: c.m };
                t0 = Game.cpu.getUsed();
                c = CAP(function () { return m.run(); });
                S.run = { ok: c.ok, n: c.n, m: c.m, c: Math.round((Game.cpu.getUsed() - t0) * 100) / 100 };
                c = CAP(function () { return m.save(); });
                S.sv = { ok: c.ok, n: c.n, m: c.m };
            }
            S.done = true;
        }
    } catch (e) { S.err = String(e && e.stack || e).slice(0, 300); S.done = true; }
};
`;
    return withMain(main, 'dist', BLD02D_MODULES);
}

// ===========================================================================
// BLD-02 dist2 isolated — real BuildController + SpawnController + rm chain
// (no SourceController, so only the builder creep order exists; the real %10
// spawn reconcile produces the builder through the real order->process path).
//   ctx: { room, doneAt }
// Every tick: rm.load -> spawnController.reconcile (real %10 gate) ->
// buildController.reconcile (real %100 gate) -> rm.save.
// handleConstructionSites() (the same method reconcile calls) is invoked at
// ticks 2/4/6 so the site-creation logic is exercised inside the budget.
// ===========================================================================
const BLD02D2_MODULES = ['logger', 'mapPatch', 'resourceManager', 'resources.Resource',
    'resources.sourceResource', 'resources.creepOrder', 'resources.spawnProcess',
    'resources.constructionOrder', 'constructionPatterns', 'SpawnController',
    'BuildController'];
function bld02D2Entrypoint(ctx) {
    const cfg = { room: ctx.room, doneAt: ctx.doneAt };
    const main = `${CAP_FN}
var CFG = ${JSON.stringify(cfg)};
${RM_REGISTER_ALL}
var spawnController = require('SpawnController');
var buildController = require('BuildController');
module.exports.loop = function () {
    Memory.bld = Memory.bld || {};
    var S = Memory.bld;
    try {
        if (S.t0 === undefined) S.t0 = Game.time;
        var rt = Game.time - S.t0 + 1;
        var rm = loadRM();
        rm.load();
        var t = Game.time;
        if (!S.init) {
            var c = CAP(function () { buildController.initialize(); });
            S.init = { t: t, ok: c.ok, n: c.n, m: c.m };
        }
        var c1 = CAP(function () { spawnController.reconcile(); });
        S.sp = S.sp || {}; if (!c1.ok) S.sp[t] = c1.n + ':' + (c1.m || '');
        var c2 = CAP(function () { buildController.reconcile(); });
        if (!c2.ok) { S.rec = S.rec || {}; S.rec[t] = c2.n + ':' + (c2.m || ''); }
        if (rt === 2 || rt === 4 || rt === 6) {
            var c3 = CAP(function () { buildController.handleConstructionSites(); });
            S['hcs' + rt] = c3.ok ? { ok: true } : { ok: false, n: c3.n, m: c3.m };
        }
        var names = Object.keys(Game.creeps);
        for (var i = 0; i < names.length; i++) {
            var cr = Game.creeps[names[i]];
            if (cr.memory && cr.memory.role === 'builder' && !cr.spawning && !S.born) S.born = t;
        }
        S.sites = 0;
        for (var rn in Game.rooms) S.sites += Game.rooms[rn].find(FIND_MY_CONSTRUCTION_SITES).length;
        rm.save();
        if (rt >= CFG.doneAt) S.done = true;
    } catch (e) { S.err = String(e && e.stack || e).slice(0, 300); S.done = true; }
};
`;
    return withMain(main, 'dist2', BLD02D2_MODULES);
}

// ===========================================================================
// BLD-02 dist2 raw — the UNPATCHED production main.js verbatim (module name
// 'main'), full resource registration at module load, real %10/%100 gates.
// runFullBudget mode: postcondition is simply reaching the budget with every
// fence recorded; the oracle evaluates the %100 reconcile evidence.
// ===========================================================================
const BLD02D2_MAIN_MODULES = ['mapPatch', 'roles', 'logger', 'resourceManager',
    'resources.sourceResource', 'SourceController', 'SpawnController',
    'resources.spawnProcess', 'resources.creepOrder', 'RoomController',
    'BuildController', 'resources.constructionOrder', 'js-yaml',
    'role.harvester', 'role.mule', 'role.upgrader', 'role.builder',
    'resources.Resource', 'utils.priority', 'constructionPatterns', 'main'];
function bld02D2MainEntrypoint() {
    return prodModules('dist2', BLD02D2_MAIN_MODULES);
}

// ===========================================================================
// BLD-03 dist — real role.builder + role.repairer on real creeps.
//   ctx: { room, sitePos:{x,y}|null, repPos:{x,y}|null, repHits, doneAt }
// Creeps drive their real role.run every tick. Input-object ids are resolved
// in-game from the arranged positions (engine evidence) and reported; done
// when the input site has converted to a real road structure AND an eligible
// repair target grew hits (or at the hard budget for negative variants).
// ===========================================================================
const BLD03D_MODULES = ['role.builder', 'role.repairer'];
function bld03DEntrypoint(ctx) {
    const cfg = {
        room: ctx.room, sitePos: ctx.sitePos || null, repPos: ctx.repPos || null,
        repHits: ctx.repHits, doneAt: ctx.doneAt,
    };
    const main = `${CAP_FN}
var CFG = ${JSON.stringify(cfg)};
var rb = require('role.builder');
var rr = require('role.repairer');
module.exports.loop = function () {
    Memory.bld = Memory.bld || {};
    var S = Memory.bld;
    try {
        if (S.t0 === undefined) S.t0 = Game.time;
        var rt = Game.time - S.t0 + 1;
        var room = Game.rooms[CFG.room];
        if (!S.ids) {
            S.ids = { site: null, rep: null };
            if (CFG.sitePos) {
                var ss = room.lookForAt(LOOK_CONSTRUCTION_SITES, CFG.sitePos.x, CFG.sitePos.y);
                if (ss.length) S.ids.site = ss[0].id;
            }
            if (CFG.repPos) {
                var st0 = room.lookForAt(LOOK_STRUCTURES, CFG.repPos.x, CFG.repPos.y);
                if (st0.length) S.ids.rep = st0[0].id;
            }
        }
        var names = Object.keys(Game.creeps);
        for (var i = 0; i < names.length; i++) {
            var cr = Game.creeps[names[i]];
            var role = cr.memory.role === 'repairer' ? rr : rb;
            var c = CAP(function () { role.run(cr); });
            if (!c.ok) { S.errs = S.errs || {}; S.errs[names[i] + '@' + Game.time] = c.n + ':' + (c.m || ''); }
        }
        var site = S.ids.site && Game.getObjectById(S.ids.site);
        var built = false;
        if (!site && CFG.sitePos) {
            var st = room.lookForAt(LOOK_STRUCTURES, CFG.sitePos.x, CFG.sitePos.y);
            built = st.some(function (s) { return s.structureType === 'road'; });
        }
        var rep = S.ids.rep && Game.getObjectById(S.ids.rep);
        if (built && rep && rep.hits > CFG.repHits) S.done = true;
        if (rt >= CFG.doneAt) S.done = true;
    } catch (e) { S.err = String(e && e.stack || e).slice(0, 300); S.done = true; }
};
`;
    return withMain(main, 'dist', BLD03D_MODULES);
}

// ===========================================================================
// BLD-03 dist2 — real ConstructionOrder lifecycle through resourceManager:
// apply (with real positions input) -> claim -> generateConstructionSitePositions
// -> real createConstructionSite return codes -> retry after controlled
// unblock -> updateSpec (count/type change) -> validate -> delete.
//   ctx: { room, posA:[{x,y}*4], posB:[{x,y}*6], doneAt }
// ===========================================================================
const BLD03D2_MODULES = ['logger', 'resourceManager', 'resources.Resource',
    'resources.constructionOrder', 'constructionPatterns'];
function bld03D2Entrypoint(ctx) {
    const cfg = { room: ctx.room, posA: ctx.posA, posB: ctx.posB };
    const main = `${CAP_FN}
var CFG = ${JSON.stringify(cfg)};
${RM_REGISTER_CO}
function PP(arr) {
    var o = []; for (var i = 0; i < arr.length; i++) { o.push(arr[i].x, arr[i].y); }
    return o;
}
module.exports.loop = function () {
    Memory.bld = Memory.bld || {};
    var S = Memory.bld;
    try {
        if (S.t0 === undefined) S.t0 = Game.time;
        var rt = Game.time - S.t0 + 1;
        var rm = loadRM();
        rm.load();
        var room = Game.rooms[CFG.room];
        function order(id) { return rm.getResourceByTypeAndId('constructionOrder', id); }
        function createAt(p, type) {
            var c = CAP(function () { return room.createConstructionSite(p.x, p.y, type || 'extension'); });
            return c.ok ? c.v : { n: c.n, m: c.m };
        }
        if (rt === 1) {
            S.apA = CAP(function () {
                return rm.applyResource('constructionOrder', {
                    structureType: 'extension',
                    pattern: { type: 'single', params: { startPos: CFG.posA[0] } },
                    roomName: CFG.room, priority: 10, count: 0,
                    positions: CFG.posA,
                    metadata: { annotation: 'bldA' } });
            });
            // Order B exercises site creation with an RCL-unlimited type so the
            // RCL2 extension cap (5) stays free for order A.
            S.apB = CAP(function () {
                return rm.applyResource('constructionOrder', {
                    structureType: 'road',
                    pattern: { type: 'single', params: { startPos: CFG.posB[0] } },
                    roomName: CFG.room, priority: 5, count: 0,
                    positions: CFG.posB,
                    metadata: { annotation: 'bldL' } });
            });
            rm.save();
        } else if (rt === 2) {
            var oa = order('bldA');
            S.claim = CAP(function () { oa.claimStructures(oa.positions); });
            S.owned = oa.ownedStructureIds.slice();
            var ob = order('bldL');
            var availB = [];
            S.genB = CAP(function () { availB = ob.generateConstructionSitePositions(6); return availB.length; });
            S.createB = availB.map(function (p) { return createAt(p, 'road'); });
            // RCL-limit evidence: tower requires RCL3 -> ERR_RCL_NOT_ENOUGH.
            S.rcl = CAP(function () { return room.createConstructionSite(CFG.posA[0].x, CFG.posA[0].y, 'tower'); });
            rm.save();
        } else if (rt === 3) {
            var oa = order('bldA');
            var availA = [];
            S.genA = CAP(function () { availA = oa.generateConstructionSitePositions(5); return PP(availA); });
            S.createA = availA.map(function (p) { return createAt(p, 'extension'); });
            rm.save();
        } else if (rt === 4) {
            // beforeStep removed the blocker structure before this tick.
            var oa = order('bldA');
            var availA = [];
            S.genA2 = CAP(function () { availA = oa.generateConstructionSitePositions(5); return PP(availA); });
            S.retry = availA.map(function (p) { return createAt(p, 'extension'); });
            rm.save();
        } else if (rt === 5) {
            // Same annotation, changed count+type, no positions key -> real
            // updateResource -> updateSpec -> onSpecUpdate path.
            S.upd = CAP(function () {
                return rm.applyResource('constructionOrder', {
                    structureType: 'road',
                    pattern: { type: 'single', params: { startPos: CFG.posA[0] } },
                    roomName: CFG.room, priority: 10, count: 1,
                    metadata: { annotation: 'bldA' } });
            });
            var oa = order('bldA');
            S.after = { pos: oa.positions.length, owned: oa.ownedStructureIds.slice(),
                wt: oa.hasWrongTypeStructures, wp: oa.hasWrongPositionStructures,
                st: oa.structureType, cnt: oa.count };
            rm.save();
        } else if (rt === 6) {
            var oa = order('bldA');
            S.val = CAP(function () { oa.validateOwnedStructures(); });
            S.owned6 = oa.ownedStructureIds.slice();
            S.del = rm.deleteResource('constructionOrder', 'bldA');
            rm.save();
            S.row = !!order('bldA');
            S.done = true;
        }
    } catch (e) { S.err = String(e && e.stack || e).slice(0, 300); S.done = true; }
};
`;
    return withMain(main, 'dist2', BLD03D2_MODULES);
}

// ===========================================================================
// BLD-04 dist2 — role.builder target selection/loss with real rm orders.
//   ctx: { room, siteN:{x,y}, siteF:{x,y}, doneAt }
// Tick 1 creates two real constructionOrders (priorities 90 far / 10 near);
// every tick runs the real roles dispatcher. Probe-side beforeStep removes
// the targeted site, then the remaining site, on controlled steps.
// ===========================================================================
const BLD04D2_MODULES = ['mapPatch', 'logger', 'resourceManager', 'resources.Resource',
    'resources.constructionOrder', 'constructionPatterns', 'roles',
    'role.harvester', 'role.mule', 'role.upgrader', 'role.builder'];
function bld04D2Entrypoint(ctx) {
    const cfg = { room: ctx.room, siteN: ctx.siteN, siteF: ctx.siteF, doneAt: ctx.doneAt };
    const main = `${CAP_FN}
var CFG = ${JSON.stringify(cfg)};
${RM_REGISTER_CO}
var roles = require('roles');
module.exports.loop = function () {
    Memory.bld = Memory.bld || {};
    var S = Memory.bld;
    try {
        if (S.t0 === undefined) S.t0 = Game.time;
        var rt = Game.time - S.t0 + 1;
        var rm = loadRM();
        rm.load();
        var t = Game.time;
        if (!S.init) {
            S.lo = CAP(function () {
                return rm.applyResource('constructionOrder', {
                    structureType: 'road',
                    pattern: { type: 'single', params: { startPos: CFG.siteN } },
                    roomName: CFG.room, priority: 10, count: 0,
                    positions: [CFG.siteN],
                    metadata: { annotation: 'bld_lo' } });
            });
            S.hi = CAP(function () {
                return rm.applyResource('constructionOrder', {
                    structureType: 'road',
                    pattern: { type: 'single', params: { startPos: CFG.siteF } },
                    roomName: CFG.room, priority: 90, count: 0,
                    positions: [CFG.siteF],
                    metadata: { annotation: 'bld_hi' } });
            });
            S.init = t;
        }
        var names = Object.keys(Game.creeps);
        for (var i = 0; i < names.length; i++) roles.run(Game.creeps[names[i]]);
        rm.save();
        if (rt >= CFG.doneAt) S.done = true;
    } catch (e) { S.err = String(e && e.stack || e).slice(0, 300); S.done = true; }
};
`;
    return withMain(main, 'dist2', BLD04D2_MODULES);
}

module.exports = {
    bld01Entrypoint, bld02DEntrypoint, bld02D2Entrypoint, bld02D2MainEntrypoint,
    bld03DEntrypoint, bld03D2Entrypoint, bld04D2Entrypoint,
    BLD01_MODULES, BLD02D_MODULES, BLD02D2_MODULES, BLD02D2_MAIN_MODULES,
    BLD03D_MODULES, BLD03D2_MODULES, BLD04D2_MODULES,
};
