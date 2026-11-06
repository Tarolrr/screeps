'use strict';
// ECO suite — harvest / delivery / role / energy-accounting e2e scenarios on
// top of the HAR harness (e2e/har/, used unmodified).
//
// Mode-per-scenario runner. Each mode spins up a disposable F0 world, uploads
// REAL production modules verbatim (sha256 recorded per frame) plus a test
// `main` driving real public methods on real Game objects, steps the world
// under the exclusive step gate, collects per-fence state from frame Memory +
// objects, and evaluates it against oracle tables probe-side.
//
// Scenario map (spec: docs/testing/issues/E2E-ECO.md):
//   ECO-01 harvest   dist [w,c,m] + real [m,w] no-carry body / dist2 [w,c,m]
//                    + full-store drop; controls: nosrc, emptysrc, spawning,
//                    no-creep (source regen model).
//   ECO-02 delivery  dist: real SourceManager/DeliveryManager route chain —
//                    resource/ground/structure/wait destinations, route
//                    priority, pending written exactly once, dst switch on
//                    pending, mule death pending cleanup, removed-target
//                    defect, no-route.
//                    dist2: collect/deliver templates — area ground, entity,
//                    area structure (nearest), area creep, removed/full
//                    target, missing templates (throw defect), RoomController
//                    real orders, death Memory cleanup at %10 reconcile.
//   ECO-03 upgrader  dist/dist2 pile→collect→upgrade→controller.progress;
//                    container (dist2-only), both-sources preference, no
//                    energy, unowned controller, spawning, dist early-return.
//
// Fixture-memory rules: creeps carrying template/order memory that needs
// runtime ids (container/spawn/extension ObjectIds) get Memory.creeps[name]
// injected probe-side at beforeStep(1) — the exact content production would
// have installed via spawnCreep(order.memory). Validation still sees an
// empty user Memory; the pre-step frame shows Memory.eco absent.
//
// Usage: node e2e/eco/eco.js --mode eco-02-d [--http-port N --cli-port N]
//                            [--max-steps N] [--wcase-ms N]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runScenario, VERDICT_EXIT } = require('../har/harness');
const { fixtureF0, impossibleFixture } = require('../har/fixture');
const { dEntrypoint, d2Entrypoint, controlEntrypoint } = require('./entrypoints');

const SEED_DB = '/home/happier/screeps/node_modules/@screeps/launcher/init_dist/db.json';

function arg(name, dflt) {
    const i = process.argv.indexOf('--' + name);
    return i !== -1 ? process.argv[i + 1] : dflt;
}
const MODE = arg('mode', '');
const HTTP_PORT = Number(arg('http-port', 0));
const CLI_PORT = Number(arg('cli-port', 0));
const MAX_STEPS = Number(arg('max-steps', 0));
const WCASE_MS = Number(arg('wcase-ms', 300000));

const seedId = crypto.createHash('sha256').update(fs.readFileSync(SEED_DB)).digest('hex').slice(0, 16);
const BODYPART_COST = { move: 50, work: 100, carry: 50, attack: 80, ranged_attack: 150, heal: 250, claim: 600, tough: 10 };
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

async function supplemental(h, ctx) {
    const out = {};
    try {
        out.notifications = await h.eval(
            `storage.db['users.notifications'].find({user:${JSON.stringify(ctx.userId)}})`, 10000);
        out.errors = (out.notifications || []).filter(n => n.type === 'error');
    } catch (e) { out.notifications = `unreadable: ${e.message}`; out.errors = null; }
    try {
        out.intents = await h.eval(
            `storage.db['rooms.intents'].find({room:${JSON.stringify(ctx.room)}})`, 10000);
    } catch (e) { out.intents = `unreadable: ${e.message}`; }
    return out;
}

// Engine-side inserts (journaled). Dropped-energy rows use `energy`
// (verified shape — e2e/dist2-deep-xfail.js used the same row layout).
async function insertEnergy(h, room, pos, amount) {
    return h.dbInsert('rooms.objects', { type: 'energy', room, x: pos.x, y: pos.y, energy: amount });
}
async function insertContainer(h, room, pos, energy) {
    return h.dbInsert('rooms.objects', {
        type: 'container', room, x: pos.x, y: pos.y,
        store: { energy }, storeCapacity: 2000,
        hits: 300000, hitsMax: 300000, notifyWhenAttacked: false,
    });
}
async function insertExtension(h, userId, room, pos, energy) {
    return h.dbInsert('rooms.objects', {
        type: 'extension', room, x: pos.x, y: pos.y, user: userId,
        store: { energy }, storeCapacityResource: { energy: 50 },
        hits: 1000, hitsMax: 1000, notifyWhenAttacked: false,
    });
}

// All free (walkable, unoccupied, not in `avoid`) cells within `range` of
// `pos`, sorted by chebyshev distance then x+y — deterministic.
async function cellsNear(h, room, pos, range, avoid = []) {
    return h.eval(`storage.db['rooms.terrain'].findOne({room:${JSON.stringify(room)}}).then(function(t){
        var s=t.terrain,out=[];
        for(var dx=-${range};dx<=${range};dx++)for(var dy=-${range};dy<=${range};dy++){
            var x=${pos.x}+dx,y=${pos.y}+dy;
            if(x<1||x>48||y<1||y>48)continue;
            var c=s.charAt(y*50+x);if(c==='1'||c==='3')continue;
            out.push({x:x,y:y,d:Math.max(Math.abs(dx),Math.abs(dy))});
        }
        return storage.db['rooms.objects'].find({room:${JSON.stringify(room)}}).then(function(objs){
            var busy={};objs.forEach(function(o){busy[o.x+','+o.y]=1;});
            var avoid=${JSON.stringify(avoid)};
            var free=out.filter(function(p){
                if(busy[p.x+','+p.y])return false;
                for(var i=0;i<avoid.length;i++)if(avoid[i].x===p.x&&avoid[i].y===p.y)return false;
                return true;
            });
            free.sort(function(a,b){return a.d-b.d||a.x-b.x||a.y-b.y;});
            return free;
        });
    })`, 15000);
}

// Free cells adjacent (range 1) to `pos` — the harvest/collect standing set.
async function adjFree(h, room, pos, avoid = []) {
    return cellsNear(h, room, pos, 1, avoid);
}

// Pick a placement cell for an extra object.
//   opts.keepAdjFree — do not consume the LAST free adjacent cell of
//                      opts.nearObj (keeps spawn->source route legal for the
//                      post-arrange validator)
//   opts.pick        — 'any' | 'closeCreep' | 'farCreep' | 'farSpawn' |
//                      'farCreepNoAdj'
async function pickCell(h, fx, e, opts) {
    const near = opts.near;
    const range = e.range || 1;
    const avoid = [fx.actual.creep, ...(e.avoid || [])].filter(Boolean);
    let candidates = await cellsNear(h, fx.room, near, range, avoid);
    if (opts.keepAdjFree) {
        const adj = await adjFree(h, fx.room, near, avoid);
        if (adj.length <= 1) {
            // never consume the last free adjacent cell
            const lastAdj = adj[0];
            if (lastAdj) candidates = candidates.filter(c => !(c.x === lastAdj.x && c.y === lastAdj.y));
        }
    }
    if (opts.noAdj) {
        const adj = new Set((await adjFree(h, fx.room, near, avoid)).map(c => c.x + ',' + c.y));
        candidates = candidates.filter(c => !adj.has(c.x + ',' + c.y));
    }
    if (opts.minChebCreep !== undefined) {
        candidates = candidates.filter(c => cheb(c, fx.actual.creep) >= opts.minChebCreep);
    }
    const ref = opts.pick === 'farSpawn' ? fx.actual.spawn : fx.actual.creep;
    if (opts.pick === 'closeCreep' || opts.pick === 'farCreep' || opts.pick === 'farSpawn' || opts.pick === 'farCreepNoAdj') {
        candidates = candidates.slice().sort((a, b) => {
            const da = cheb(a, ref), db = cheb(b, ref);
            return opts.pick === 'closeCreep' ? da - db : db - da;
        });
    }
    return candidates[0] || null;
}

// Arrange the F0 base: test user + modules + controller RCL + fixture creep +
// scenario extra objects (piles/containers/extensions/extra creeps).
async function arrangeBase(h, fx, journal, label, { modules, withCreep, extra }) {
    const username = `eco_${label}_${process.pid}`;
    const userId = await h.createUser({
        username, modules, roomName: fx.room, spawn: true, spawnPos: fx.actual.spawn,
    });
    journal.add('user', userId, 'create', { username, modules: Object.keys(modules), spawnPos: fx.actual.spawn });
    await h.dbUpdate('rooms.objects', { $and: [{ room: fx.room }, { type: 'controller' }] }, { level: fx.spec.rcl });
    journal.add('controller', fx.actual.controller.id, 'update', { level: fx.spec.rcl });
    const ctx = { userId, room: fx.room };
    if (withCreep) {
        const capacity = fx.spec.creep.body.filter(p => p === 'carry').length * 50;
        const inserted = await h.insertCreep({
            userId, room: fx.room, x: fx.actual.creep.x, y: fx.actual.creep.y,
            name: fx.spec.creep.name, parts: fx.spec.creep.body,
            store: fx.spec.creep.store, capacity, age: 1500,
        });
        ctx.creepId = inserted && inserted._id;
        ctx.creepName = fx.spec.creep.name;
        journal.add('creep', ctx.creepId || fx.spec.creep.name, 'create',
            { x: fx.actual.creep.x, y: fx.actual.creep.y, body: fx.spec.creep.body });
    }
    // Scenario extras. Spec: {kind:'pile'|'container'|'extension'|'creep',
    //   near:'source1'|'source2'|'spawn'|'controller'|'creep'|{x,y},
    //   range, amount|energy, pick, noAdj, keepAdjFree, name, body, capacity}
    ctx.extra = {};
    for (const e of extra || []) {
        const near = e.near === 'source1' ? fx.actual.source1
            : e.near === 'source2' ? fx.actual.source2
            : e.near === 'spawn' ? fx.actual.spawn
            : e.near === 'controller' ? fx.actual.controller
            : e.near === 'creep' ? fx.actual.creep
            : e.near;
        let minChebCreep = e.minChebCreep;
        if (minChebCreep === 'gtCreepNear0' && ctx.extra.piles && ctx.extra.piles[0]) {
            minChebCreep = cheb(ctx.extra.piles[0], fx.actual.creep) + 1;
        }
        let cell = await pickCell(h, fx, e, {
            near, keepAdjFree: e.keepAdjFree, noAdj: e.noAdj, pick: e.pick || 'any',
            minChebCreep,
        });
        if (!cell && (e.range || 1) === 1 && !e.noAdj) {
            // Pocket sources (S1 has exactly one free adjacent cell in the
            // current seed) cannot host a pile at r1 without consuming the
            // last harvest cell — keepAdjFree correctly rejects it. Fall back
            // to r2; the oracle binds evidence to the pile id, not distance.
            journal.add('extra', e.kind, 'place-fallback', { near, range: 'r1->r2' });
            cell = await pickCell(h, fx, { ...e, range: 2 }, {
                near, keepAdjFree: e.keepAdjFree, noAdj: e.noAdj, pick: e.pick || 'any',
                minChebCreep,
            });
        }
        if (!cell) {
            journal.add('extra', e.kind, 'place-failed', { near, range: e.range }, false);
            throw new Error(`arrange: no legal cell for extra ${e.kind} near ${JSON.stringify(near)} r${e.range}`);
        }
        if (e.kind === 'pile') {
            const ins = await insertEnergy(h, fx.room, cell, e.amount);
            journal.add('extra', 'pile', 'create', { cell, amount: e.amount, id: ins && ins._id });
            (ctx.extra.piles = ctx.extra.piles || []).push({ id: ins && ins._id, x: cell.x, y: cell.y, amount: e.amount });
        } else if (e.kind === 'container') {
            const ins = await insertContainer(h, fx.room, cell, e.amount);
            journal.add('extra', 'container', 'create', { cell, energy: e.amount, id: ins && ins._id });
            (ctx.extra.containers = ctx.extra.containers || []).push({ id: ins && ins._id, x: cell.x, y: cell.y });
        } else if (e.kind === 'extension') {
            const ins = await insertExtension(h, userId, fx.room, cell, e.amount || 0);
            journal.add('extra', 'extension', 'create', { cell, energy: e.amount || 0, id: ins && ins._id });
            (ctx.extra.extensions = ctx.extra.extensions || []).push({ id: ins && ins._id, x: cell.x, y: cell.y });
        } else if (e.kind === 'creep') {
            const ins = await h.insertCreep({
                userId, room: fx.room, x: cell.x, y: cell.y, name: e.name,
                parts: e.body, store: e.store || {}, capacity: e.capacity, age: 1500,
            });
            journal.add('extra', 'creep', 'create', { cell, name: e.name, body: e.body, id: ins && ins._id });
            (ctx.extra.creeps = ctx.extra.creeps || []).push({ id: ins && ins._id, x: cell.x, y: cell.y, name: e.name });
        }
    }
    return ctx;
}

// Probe-side Memory.creeps injection at beforeStep(1): writes exactly what a
// real spawnCreep(order.memory) would install — needed when template memory
// references runtime ObjectIds (container/spawn/extension) that cannot be
// baked into the uploaded module text.
async function memInject(h, ctx, journal, def) {
    if (!def.memInject) return;
    const mems = typeof def.memInject === 'function' ? def.memInject(ctx) : def.memInject;
    // Do the read-modify-write inside the server eval: pulling the whole
    // Memory blob through the CLI pipe (>10 KB) truncates the stream and
    // clogs the next snapshot read (eval timeouts on later fences).
    await h.eval(`storage.env.get(${JSON.stringify('memory:' + ctx.userId)}).then(function(raw){
        var mem = JSON.parse(raw || '{}');
        mem.creeps = mem.creeps || {};
        var mems = ${JSON.stringify(mems)};
        for (var n in mems) mem.creeps[n] = mems[n];
        return storage.env.set(${JSON.stringify('memory:' + ctx.userId)}, JSON.stringify(mem)).then(function(){ return 'ok'; });
    })`, 15000);
    journal.add('env', 'memory-creeps', 'update', { injected: Object.keys(mems) });
}

// ---------------------------------------------------------------------------
// Per-fence observation collected from frame data (never stored in Memory).
// ---------------------------------------------------------------------------
function actNonNull(al) {
    const o = {};
    if (!al) return o;
    for (const [k, v] of Object.entries(al)) if (v) o[k] = v;
    return o;
}

function collectObs(rec, ctx) {
    ctx.obs = ctx.obs || {};
    const mem = (rec.memory || {})[ctx.userId] || null;
    const o = { se: null, sp: null, cr: [], s1: null, s2: null, drops: [], ctrl: null, ext: [], cont: [], cm: {}, mm: {}, eco: null, rm: null };
    const spawn = (rec.objects || []).find(x => x.type === 'spawn' && x.user === ctx.userId);
    if (spawn) {
        o.se = spawn.store ? spawn.store.energy : null;
        o.sp = spawn.spawning ? { n: spawn.spawning.name, nt: spawn.spawning.needTime, st: spawn.spawning.spawnTime } : null;
    }
    o.cr = (rec.creeps || []).map(c => ({
        id: c.id, n: c.name, sp: !!c.spawning, hits: c.hits,
        b: (c.body || []).map(x => x.type), x: c.x, y: c.y,
        e: (c.store && c.store.energy) || 0, cap: c.storeCapacity || 0,
        fat: c.fatigue || 0, act: actNonNull(c.actionLog),
    }));
    const s1 = (rec.sources || []).find(s => s.id === ctx.s1);
    const s2 = (rec.sources || []).find(s => s.id === ctx.s2);
    if (s1) o.s1 = { e: s1.energy, cap: s1.energyCapacity, regen: s1.ticksToRegeneration };
    if (s2) o.s2 = { e: s2.energy, cap: s2.energyCapacity, regen: s2.ticksToRegeneration };
    o.drops = (rec.drops || []).map(d => ({ id: d.id, x: d.x, y: d.y, amt: d.amount !== undefined ? d.amount : d.energy, type: d.type }));
    const ctrl = rec.controller || (rec.objects || []).find(x => x.type === 'controller');
    if (ctrl) o.ctrl = { id: ctrl.id, lvl: ctrl.level, prog: ctrl.progress || 0, user: ctrl.user || null };
    o.ext = (rec.objects || []).filter(x => x.type === 'extension')
        .map(x => ({ id: x.id, x: x.x, y: x.y, e: (x.store && x.store.energy) || 0 }));
    o.cont = (rec.objects || []).filter(x => x.type === 'container')
        .map(x => ({ id: x.id, x: x.x, y: x.y, e: (x.store && x.store.energy) || 0 }));
    if (mem) {
        o.eco = mem.eco ? {
            done: !!mem.eco.done, errs: mem.eco.errs, mgrErr: mem.eco.mgrErr,
            kill: mem.eco.kill,
            qs: mem.eco.qs, direct: mem.eco.direct, t: mem.eco.t,
            gbuild: mem.eco.gbuild, copied: mem.eco.copied, err: mem.eco.err,
        } : null;
        if (mem.creeps) {
            for (const [n, v] of Object.entries(mem.creeps)) {
                const d = v.destination || null;
                o.cm[n] = {
                    role: v.role, state: v.state, src: v.src,
                    as: v.assignedSource, sid: v.sourceId, cti: v.currentTaskIndex,
                    dest: d ? { t: d.type, id: d.id, pos: d.pos && { x: d.pos.x, y: d.pos.y }, range: d.range, time: d.time } : null,
                };
            }
        }
        if (mem.managers) {
            for (const [k, v] of Object.entries(mem.managers)) {
                o.mm[k] = {
                    c: v.creeps, q: (v.creepsQueued || []).map(x => x && x.name),
                    queue: (v.queue || []).map(x => x && ({ n: x.name, c: x.cost })),
                    routes: (v.routes || []).map(r => ({ s: r.src, d: r.dst, p: r.priority, di: r.distance })),
                    pend: v.plannedDeliveries, need: v.energyNeeded, avail: v.availableEnergy,
                };
            }
        }
        if (mem.resourceManager && mem.resourceManager.resources) {
            o.rm = {};
            for (const [t, m] of Object.entries(mem.resourceManager.resources)) {
                o.rm[t] = Object.entries(m).map(([id, v]) => ({
                    id, st: v.status, cn: v.creepName, ex: v.expiryTime,
                    pr: v.priority, oid: v.orderId, sid: v.sourceId,
                }));
            }
        }
    }
    ctx.obs[rec.gameTime] = o;
}

// ---------------------------------------------------------------------------
// Oracle helpers
// ---------------------------------------------------------------------------
function fenceList(ctx) {
    return Object.keys(ctx.obs || {}).map(Number).sort((a, b) => a - b)
        .map(g => Object.assign({ g }, ctx.obs[g]));
}
function fenceAt(ctx, g) { return ctx.obs[g] || null; }
function lastFence(ctx) { const fs = fenceList(ctx); return fs[fs.length - 1] || {}; }
function creepAt(f, name) { return (f.cr || []).find(c => c.n === name) || null; }
function mgrKey(o, frag) { return Object.keys(o.mm || {}).find(k => k.includes(frag)) || null; }
function costOf(parts) { return (parts || []).reduce((s, p) => s + (BODYPART_COST[p] || 0), 0); }
function dropsNear(f, pos, rng) {
    return (f.drops || []).filter(d => d.type === 'energy' && cheb(d, pos) <= rng);
}
function spawnEvents(ctx) {
    const ev = []; let prev = null;
    for (const f of fenceList(ctx)) {
        const cur = f.sp ? f.sp.n : null;
        if (cur !== prev && cur) ev.push({ g: f.g, name: cur, needTime: f.sp.nt, spawnTime: f.sp.st, se: f.se });
        prev = cur;
    }
    return ev;
}

// Spawn energy conservation (SPN model — post-charge regen +1/tick while
// <300 — generalized with inbound transfer fences: a creep's store loss
// within range 1 of the spawn counts as inbound energy on the same fence).
function spawnEnergyProblems(ctx, spawnPos) {
    const bad = [];
    const fs = fenceList(ctx);
    const evG = {};
    for (const e of spawnEvents(ctx)) evG[e.g] = e;
    for (let i = 1; i < fs.length; i++) {
        const p = fs[i - 1], c = fs[i];
        if (p.se === null || p.se === undefined || c.se === null || c.se === undefined) continue;
        const d = c.se - p.se;
        let tin = 0;
        for (const cc of c.cr) {
            if (cheb(cc, spawnPos) <= 1) {
                const pc = (p.cr || []).find(x => x.n === cc.n);
                if (pc && pc.e > cc.e) {
                    const lostE = pc.e - cc.e;
                    // A creep.drop() adjacent to the spawn loses store but is
                    // NOT an inbound transfer — it materializes as an energy
                    // row at the creep's own cell. Only count the loss as
                    // inbound when no matching drop appeared there.
                    const dropB4 = (p.drops || []).filter(dd => dd.type === 'energy' && dd.x === cc.x && dd.y === cc.y)
                        .reduce((s, x) => s + x.amt, 0);
                    const dropAf = (c.drops || []).filter(dd => dd.type === 'energy' && dd.x === cc.x && dd.y === cc.y)
                        .reduce((s, x) => s + x.amt, 0);
                    if (dropAf - dropB4 >= lostE) continue;
                    tin += lostE;
                }
            }
        }
        const ev = evG[c.g];
        let want;
        if (ev) {
            const cr = creepAt(c, ev.name) || creepAt(p, ev.name) ||
                (function () { for (const f2 of fs) { const c2 = creepAt(f2, ev.name); if (c2) return c2; } return null; })();
            const cost = costOf(cr && cr.b);
            want = -cost + 1 + tin;
            if (!cost) { bad.push(`t${c.g}: spawn ${ev.name} has no body for cost check`); continue; }
        } else {
            want = (p.se < 300 ? 1 : 0) + tin;
        }
        if (d !== want) bad.push(`t${c.g}: spawn.energy delta ${d} want ${want} (ev=${ev && ev.name}, transfer=${tin})`);
        if (c.se < 0 || c.se > 300) bad.push(`t${c.g}: spawn.energy ${c.se} out of [0,300]`);
    }
    return bad;
}

// Source energy conservation for one source. Harvest fences (creeps with
// actionLog.harvest adjacent to this source) drain 2*work each; regen jumps
// to capacity are recorded, never asserted absent.
function sourceProblems(ctx, key, workPartsByName, sourcePos) {
    const bad = [];
    const fs = fenceList(ctx);
    ctx.regenEvents = ctx.regenEvents || [];
    for (let i = 1; i < fs.length; i++) {
        const p = fs[i - 1], c = fs[i];
        if (!p[key] || !c[key]) continue;
        const d = c[key].e - p[key].e;
        if (d > 0) {
            if (c[key].e === c[key].cap) ctx.regenEvents.push({ g: c.g, src: key, from: p[key].e, to: c[key].e });
            else bad.push(`t${c.g}: ${key} partial energy rise ${p[key].e}->${c[key].e} (not a full regen event)`);
            continue;
        }
        if (d < 0) {
            let want = 0;
            for (const cr of c.cr) {
                if (!cr.act || !cr.act.harvest) continue;
                if (sourcePos && cheb(cr, sourcePos) > 1) continue;
                const parts = workPartsByName[cr.n] !== undefined ? workPartsByName[cr.n] : 1;
                want -= 2 * parts;
            }
            if (d !== want) bad.push(`t${c.g}: ${key} drained ${d} want ${want} (harvesters=${JSON.stringify(c.cr.filter(x => x.act && x.act.harvest).map(x => x.n))})`);
            if (want === 0) bad.push(`t${c.g}: ${key} drained ${d} with no adjacent harvest actionLog`);
        }
    }
    return bad;
}

// Teleport + bounds assertions for one creep across the whole window.
function creepMoveProblems(ctx, name) {
    const bad = [];
    const fs = fenceList(ctx);
    for (let i = 1; i < fs.length; i++) {
        const pc = creepAt(fs[i - 1], name), cc = creepAt(fs[i], name);
        if (!pc || !cc) continue;
        if (cheb(pc, cc) > 1) bad.push(`t${fs[i].g}: ${name} moved ${pc.x},${pc.y}->${cc.x},${cc.y} (>1 cell)`);
        if (cc.e < 0 || cc.e > cc.cap) bad.push(`t${fs[i].g}: ${name} store ${cc.e}/${cc.cap} out of bounds`);
    }
    return bad;
}

function expectStateSeq(ctx, E, stateSeq, bad) {
    if (!E.stateSeq) return;
    let cursor = -1;
    for (const want of E.stateSeq) {
        const idx = stateSeq.findIndex((x, i) => x.s === want && i > cursor);
        if (idx === -1) { bad.push(`state sequence missing ${want} (have ${JSON.stringify(stateSeq)})`); return; }
        cursor = idx;
    }
}

// ---------------------------------------------------------------------------
// Oracle: ECO-01 harvest (shared dist/dist2)
// ---------------------------------------------------------------------------
function oracleEco01(ctx) {
    const bad = [];
    const fs = fenceList(ctx);
    const N = ctx.creepName;
    const work = ctx.workParts || 1;
    ctx.characterizations = ctx.characterizations || [];
    ctx.evidence = ctx.evidence || {};
    ctx.accounting = ctx.accounting || [];

    bad.push(...spawnEnergyProblems(ctx, ctx.spawnPos));
    bad.push(...sourceProblems(ctx, 's1', { [N]: work }, ctx.s1Pos));
    bad.push(...creepMoveProblems(ctx, N));

    for (const f of fs) {
        const c = creepAt(f, N);
        if (!c) { bad.push(`t${f.g}: creep ${N} missing`); break; }
        if (c.sp) { bad.push(`t${f.g}: creep ${N} spawning`); break; }
    }

    const harvestFs = fs.filter(f => { const c = creepAt(f, N); return c && c.act && c.act.harvest; });
    ctx.evidence.harvestFences = harvestFs.map(f => f.g);
    if (!harvestFs.length) { bad.push('no harvest actionLog ever recorded'); return bad; }
    const firstH = harvestFs[0].g;
    for (const f of harvestFs) {
        const c = creepAt(f, N);
        if (cheb(c, ctx.s1Pos) > 1) bad.push(`t${f.g}: harvest actionLog at range ${cheb(c, ctx.s1Pos)} from source`);
    }
    for (let i = 1; i < fs.length; i++) {
        const p = fs[i - 1], c = fs[i];
        const cc = creepAt(c, N), pc = creepAt(p, N);
        if (!cc || !pc) continue;
        const h = cc.act && cc.act.harvest;
        const dStore = cc.e - pc.e;
        const dSrc = (p.s1 && c.s1) ? c.s1.e - p.s1.e : null;
        if (h) {
            ctx.accounting.push({ g: c.g, kind: 'harvest', storeDelta: dStore, srcDelta: dSrc });
            if (dSrc !== -2 * work) bad.push(`t${c.g}: harvest fence source delta ${dSrc} want ${-2 * work}`);
            const wantStore = Math.min(2 * work, cc.cap - pc.e);
            if (cc.cap > 0 && dStore !== wantStore) {
                bad.push(`t${c.g}: harvest fence store delta ${dStore} want ${wantStore}`);
            }
        }
    }
    if (ctx.expectPileDrop) {
        let firstDrop = null;
        for (const f of fs) {
            const c = creepAt(f, N);
            if (!c) continue;
            const near = dropsNear(f, c, 1).reduce((s, d) => s + d.amt, 0);
            if (near > 0 && firstDrop === null) firstDrop = { g: f.g, amt: near };
        }
        ctx.evidence.firstDrop = firstDrop;
        if (!firstDrop) bad.push('no dropped-energy row ever appeared near the no-CARRY harvester');
        else if (firstDrop.g < firstH) bad.push(`drop appeared t${firstDrop.g} before first harvest t${firstH}`);
        const c0 = creepAt(fs[0], N) || creepAt(fs[1], N);
        if (c0 && c0.cap !== 0) bad.push(`no-CARRY creep storeCapacity ${c0.cap} want 0`);
    }
    if (ctx.expectFullDrop) {
        let fillG = null, dropEv = null;
        for (const f of fs) {
            const c = creepAt(f, N);
            if (!c) continue;
            if (fillG === null && c.e >= c.cap && c.cap > 0) fillG = f.g;
            const near = dropsNear(f, c, 0);
            if (near.length && c.e === 0 && !dropEv) dropEv = { g: f.g, drops: near.map(d => ({ id: d.id, amt: d.amt })) };
        }
        ctx.evidence.fillG = fillG; ctx.evidence.dropEv = dropEv;
        if (fillG === null) bad.push('creep store never reached capacity (no full-store transition)');
        if (!dropEv) bad.push('no new drop row at creep cell with emptied store');
        else {
            const amt = dropEv.drops.reduce((s, d) => s + d.amt, 0);
            if (amt < 40) bad.push(`full-store drop amount ${amt} < 40`);
        }
    }
    const init = ctx.source1Initial;
    const last = lastFence(ctx);
    if (last.s1 && init !== null && init !== undefined) {
        const drain = init - last.s1.e;
        const want = 2 * work * harvestFs.length;
        if (drain !== want) bad.push(`cumulative source drain ${drain} want ${want} (${harvestFs.length} harvest fences)`);
        ctx.accounting.push({ kind: 'total', srcDrain: drain, harvests: harvestFs.length });
    }
    return bad;
}

// ---------------------------------------------------------------------------
// Oracle: ECO-01 controls (nosrc / emptysrc / spawning / no-creep)
// ---------------------------------------------------------------------------
function oracleEco01Negative(ctx) {
    const bad = [];
    const fs = fenceList(ctx);
    const N = ctx.creepName;
    ctx.characterizations = ctx.characterizations || [];
    ctx.evidence = ctx.evidence || {};
    bad.push(...spawnEnergyProblems(ctx, ctx.spawnPos));
    const kind = ctx.variant;
    if (kind === 'control') {
        for (const f of fs) if ((f.cr || []).length) bad.push(`t${f.g}: unexpected creep ${JSON.stringify(f.cr.map(c => c.n))}`);
    } else {
        const first = kind === 'spawning'
            ? (creepAt(fs[1], N) || creepAt(fs[0], N))
            : (creepAt(fs[0], N) || creepAt(fs[1], N));
        const pos0 = first && { x: first.x, y: first.y };
        for (const f of fs) {
            const c = creepAt(f, N);
            if (!c) { bad.push(`t${f.g}: creep ${N} missing`); continue; }
            if (kind === 'nosrc' || kind === 'spawning') {
                if (pos0 && (c.x !== pos0.x || c.y !== pos0.y)) bad.push(`t${f.g}: creep moved to ${c.x},${c.y} with ${kind} input`);
                if (c.act && Object.keys(c.act).length) bad.push(`t${f.g}: actionLog ${JSON.stringify(c.act)} with ${kind} input`);
            }
            if (kind === 'emptysrc') {
                if (c.act && c.act.harvest) bad.push(`t${f.g}: harvest actionLog on empty source`);
                if (c.e !== 0) bad.push(`t${f.g}: store ${c.e} != 0 on empty source`);
            } else if (c.e !== 0) bad.push(`t${f.g}: store ${c.e} != 0`);
        }
        if (kind === 'nosrc') ctx.characterizations.push('invalid source id: role returned silently every tick (no throw, no move, no harvest)');
        if (kind === 'spawning') ctx.characterizations.push('spawning:true creep: role returned silently every tick');
    }
    bad.push(...sourceProblems(ctx, 's1', {}, ctx.s1Pos));
    if (kind === 'emptysrc') {
        const last = lastFence(ctx);
        if (last.s1 && last.s1.e !== 0) bad.push(`empty source ended at ${last.s1.e} != 0`);
    }
    return bad;
}

// ---------------------------------------------------------------------------
// Oracle: ECO-02 dist delivery
// ---------------------------------------------------------------------------
function oracleEco02d(ctx) {
    const bad = [];
    const fs = fenceList(ctx);
    const N = ctx.creepName;
    ctx.characterizations = ctx.characterizations || [];
    ctx.evidence = ctx.evidence || {};
    ctx.accounting = ctx.accounting || [];

    bad.push(...spawnEnergyProblems(ctx, ctx.spawnPos));
    bad.push(...creepMoveProblems(ctx, N));

    const E = ctx.expect || {};
    const cmOf = f => (f.cm || {})[N] || null;
    const destOf = f => { const m = cmOf(f); return m && m.dest; };
    const stateOf = f => { const m = cmOf(f); return m && m.state; };
    const pendOf = (f) => {
        const mk = mgrKey(f, '_DlvM');
        const p = mk && f.mm[mk] && f.mm[mk].pend;
        return p ? p[N] || null : null;
    };
    const dlvOf = f => { const mk = mgrKey(f, '_DlvM'); return mk ? f.mm[mk] : null; };

    // -- chain fences ----------------------------------------------------------
    let destG = null, pickupG = null, storeG = null, planG = null, xferG = null, clearedG = null;
    const destSeq = [];
    fs.forEach((f, i) => {
        const d = destOf(f);
        destSeq.push({ g: f.g, d });
        if (destG === null && d && (E.destTypes || []).includes(d.t)) destG = f.g;
        const c = creepAt(f, N);
        if (pickupG === null && c && c.e > 0 && i > 0) {
            const pc = creepAt(fs[i - 1], N);
            if (pc && pc.e === 0) pickupG = f.g;
        }
        if (storeG === null && stateOf(f) === 'store') storeG = f.g;
        const p = pendOf(f);
        if (planG === null && p) planG = f.g;
        if (xferG === null && planG !== null && c && c.e === 0 && f.g > planG) xferG = f.g;
        if (clearedG === null && planG !== null && !p && f.g > planG) clearedG = f.g;
    });
    ctx.evidence.chain = { destG, pickupG, storeG, planG, xferG, clearedG };
    ctx.evidence.destSeq = destSeq.filter((x, i) => i === 0 || JSON.stringify(x.d) !== JSON.stringify(destSeq[i - 1].d));

    if (E.needsDest !== false && destG === null) {
        bad.push(`destination ${JSON.stringify(E.destTypes)} never written`);
    }
    if (E.pickup !== false && pickupG === null) bad.push('pickup fence (empty->nonempty store) never observed');
    if (E.storeState !== false && storeG === null) bad.push('state never became store');
    if (E.pending !== false) {
        if (planG === null) bad.push('plannedDeliveries entry never written');
        if (E.deliver !== false && xferG === null) bad.push('delivery (store->0 after planDelivery) never observed');
        if (E.clear !== false) {
            if (clearedG === null) bad.push('pending never cleared after empty store');
            else if (xferG !== null && clearedG > xferG + 2) bad.push(`pending cleared at ${clearedG} >2 fences after empty store at ${xferG}`);
        }
    }

    // -- destination content ---------------------------------------------------
    const written = destSeq.find(x => x.d && (E.destTypes || []).includes(x.d.t));
    if (written && E.destPos) {
        const dp = written.d.pos;
        if (!dp || dp.x !== E.destPos.x || dp.y !== E.destPos.y) {
            bad.push(`destination pos ${JSON.stringify(dp)} want ${JSON.stringify(E.destPos)}`);
        }
    }
    if (written && E.destId && written.d.id !== E.destId) {
        bad.push(`destination id ${written.d.id} want ${E.destId}`);
    }
    if (written && E.destRange !== undefined && written.d.range !== E.destRange) {
        bad.push(`destination range ${written.d.range} want ${E.destRange}`);
    }

    // -- pickup causal delta ----------------------------------------------------
    if (pickupG !== null) {
        const f = fenceAt(ctx, pickupG), p = fenceAt(ctx, pickupG - 1);
        const c = creepAt(f, N);
        const ids = E.pileIds || [];
        const b4 = p ? p.drops.filter(d => ids.includes(d.id)).reduce((s, x) => s + x.amt, 0) : null;
        const af = f.drops.filter(d => ids.includes(d.id)).reduce((s, x) => s + x.amt, 0);
        const lost = b4 === null ? null : b4 - af;
        ctx.accounting.push({ g: pickupG, kind: 'pickup', creepGain: c && c.e, pileDelta: lost });
        if (lost === null) bad.push('pile missing before pickup fence');
        else if (c && Math.abs(c.e - Math.min(lost, c.cap)) > 3) bad.push(`pickup: creep +${c.e} want ${Math.min(lost, c.cap)} (pile -${lost})`);
    }

    // -- pending exactly once ----------------------------------------------------
    const pendRows = [];
    for (const f of fs) {
        const dk = mgrKey(f, '_DlvM');
        const pendMap = dk && f.mm[dk] && f.mm[dk].pend;
        if (pendMap && Object.keys(pendMap).length > 1) bad.push(`t${f.g}: plannedDeliveries holds ${Object.keys(pendMap).length} entries ${JSON.stringify(Object.keys(pendMap))}`);
        const p = pendOf(f);
        if (p) pendRows.push({ g: f.g, p });
    }
    const pendGs = new Set(pendRows.map(x => x.g));
    for (const x of pendRows) {
        const f = fenceAt(ctx, x.g);
        const c = creepAt(f, N);
        if (c && c.e > 0 && x.p.amount !== c.e) bad.push(`t${x.g}: pending amount ${x.p.amount} != carried ${c.e}`);
        // deliveryCompleted clears the row on the DlvM.run AFTER the role
        // flips to collect — a single lagging fence is legitimate cleanup.
        if (stateOf(f) !== 'store' && pendGs.has(x.g + 1)) bad.push(`t${x.g}: pending present outside store state (${stateOf(f)})`);
        ctx.accounting.push({ g: x.g, kind: 'pending', amount: x.p.amount, dst: x.p.dst, carried: c && c.e });
    }
    if (E.dstName && pendRows.length && pendRows[0].p.dst !== E.dstName) {
        bad.push(`first pending dst ${pendRows[0].p.dst} want ${E.dstName}`);
    }

    // -- delivery causal delta ----------------------------------------------------
    if (xferG !== null) {
        const f = fenceAt(ctx, xferG), p = fenceAt(ctx, xferG - 1);
        const cc = creepAt(f, N), pc = p && creepAt(p, N);
        const lost = pc ? pc.e - (cc ? cc.e : 0) : null;
        if (E.transfer === 'spawn') {
            const d = f.se - p.se;
            ctx.accounting.push({ g: xferG, kind: 'transfer-spawn', creepDelta: lost, spawnDelta: d });
            const want = lost + (p.se < 300 ? 1 : 0);
            if (d !== want) bad.push(`transfer fence spawn +${d} want ${want} (creep -${lost} + regen)`);
        } else if (E.transfer === 'extension') {
            const eb = p.ext.find(e => e.id === E.transferId), ea = f.ext.find(e => e.id === E.transferId);
            const d = eb && ea ? ea.e - eb.e : null;
            ctx.accounting.push({ g: xferG, kind: 'transfer-ext', creepDelta: lost, extDelta: d });
            if (d === null) bad.push('extension missing at transfer fence');
            else if (d !== Math.min(lost, 50 - eb.e)) bad.push(`ext +${d} want ${Math.min(lost, 50 - eb.e)} (creep -${lost})`);
        } else if (E.transfer === 'ground') {
            const zone = E.transferZone;
            const pIn = p ? dropsNear(p, zone.pos, zone.range).reduce((s, x) => s + x.amt, 0) : 0;
            const cIn = dropsNear(f, zone.pos, zone.range).reduce((s, x) => s + x.amt, 0);
            ctx.accounting.push({ g: xferG, kind: 'drop-ground', creepDelta: lost, zoneDelta: cIn - pIn });
            if (Math.abs((cIn - pIn) - lost) > 4) bad.push(`drop zone +${cIn - pIn} want ${lost} (creep -${lost})`);
        }
    }

    // -- state machine shape ------------------------------------------------------
    const stateSeq = [];
    for (const f of fs) {
        const s = stateOf(f);
        if (!s) continue;
        if (!stateSeq.length || stateSeq[stateSeq.length - 1].s !== s) stateSeq.push({ g: f.g, s });
    }
    ctx.evidence.stateSeq = stateSeq;
    expectStateSeq(ctx, E, stateSeq, bad);

    // -- wait destination countdown -------------------------------------------------
    // role.mule's destination handler returns before the state blocks, so a
    // live wait destination is NOT re-written: `destination.time--` ticks
    // down each fence the creep is parked inside the wait range (out-of-
    // range walk ticks just moveTo). At time 0 the dest is deleted and the
    // state block re-plans — a fresh {time:10} while the underlying need
    // still holds (sawtooth cycle), or a real route once it clears.
    if (E.waitCount) {
        const times = destSeq.filter(x => x.d && x.d.t === 'wait').map(x => ({ g: x.g, t: x.d.time }));
        ctx.evidence.waitSeq = times;
        if (!times.length) bad.push('wait destination never observed');
        else {
            const vals = times.map(x => x.t);
            if (vals.some(v => v === null || v === undefined || v < 0 || v > 10)) {
                bad.push(`wait.time out of [0,10]: ${JSON.stringify(vals)}`);
            }
            const descends = vals.some((v, i) => i > 0 && v < vals[i - 1]);
            const restarts = vals.some((v, i) => i > 0 && v > vals[i - 1]);
            ctx.characterizations.push(`wait times ${JSON.stringify(vals)} — ` +
                (descends
                    ? `countdown decremented while parked${restarts ? ', re-planned sawtooth while the need held' : ''}`
                    : 'still walking to the wait point or freshly assigned (no decrement observed)'));
        }
    }
    return bad;
}

// ---------------------------------------------------------------------------
// Oracle: ECO-02 dist2 delivery (templates / entity / area / nearest)
// ---------------------------------------------------------------------------
function oracleEco02d2(ctx) {
    const bad = [];
    const fs = fenceList(ctx);
    const N = ctx.creepName;
    ctx.characterizations = ctx.characterizations || [];
    ctx.evidence = ctx.evidence || {};
    ctx.accounting = ctx.accounting || [];

    bad.push(...spawnEnergyProblems(ctx, ctx.spawnPos));
    bad.push(...creepMoveProblems(ctx, N));

    const E = ctx.expect || {};
    const cmOf = f => (f.cm || {})[N] || null;
    const stateOf = f => { const m = cmOf(f); return m && m.state; };

    const stateSeq = [];
    for (const f of fs) {
        const s = stateOf(f);
        if (!s) continue;
        if (!stateSeq.length || stateSeq[stateSeq.length - 1].s !== s) stateSeq.push({ g: f.g, s });
    }
    ctx.evidence.stateSeq = stateSeq;
    expectStateSeq(ctx, E, stateSeq, bad);
    for (const x of stateSeq) {
        if (!['idle', 'collecting', 'delivering'].includes(x.s)) bad.push(`illegal state ${x.s} at t${x.g}`);
    }

    let collectG = null, deliverG = null;
    const storeChanges = [];
    for (let i = 1; i < fs.length; i++) {
        const pc = creepAt(fs[i - 1], N), cc = creepAt(fs[i], N);
        if (!pc || !cc) continue;
        if (pc.e !== cc.e) storeChanges.push({ g: fs[i].g, from: pc.e, to: cc.e });
        if (collectG === null && pc.e === 0 && cc.e > 0) collectG = fs[i].g;
        if (collectG !== null && deliverG === null && cc.e === 0 && pc.e > 0) deliverG = fs[i].g;
    }
    ctx.evidence.collectG = collectG; ctx.evidence.deliverG = deliverG;
    ctx.evidence.storeChanges = storeChanges;
    if (E.collect !== false && collectG === null) bad.push('collect fence never observed');
    if (E.deliver !== false && deliverG === null) bad.push('deliver fence never observed');
    if (collectG !== null && deliverG !== null && deliverG <= collectG) bad.push(`deliver ${deliverG} <= collect ${collectG}`);

    if (collectG !== null) {
        const f = fenceAt(ctx, collectG), p = fenceAt(ctx, collectG - 1);
        const c = creepAt(f, N);
        if (E.collectSource === 'pile') {
            const ids = E.pileIds || [];
            const b4 = p ? p.drops.filter(d => ids.includes(d.id)).reduce((s, x) => s + x.amt, 0) : null;
            const af = f.drops.filter(d => ids.includes(d.id)).reduce((s, x) => s + x.amt, 0);
            ctx.accounting.push({ g: collectG, kind: 'pickup', creepGain: c && c.e, pileDelta: b4 === null ? null : b4 - af });
            if (b4 === null) bad.push('collect piles missing pre-fence');
            else if ((b4 - af) - c.e < 0 || (b4 - af) - c.e > 4) bad.push(`pickup: pile -${b4 - af} != creep +${c.e}`);
        } else if (E.collectSource === 'container') {
            const cb = p && p.cont.find(x => x.id === E.collectId), ca = f.cont.find(x => x.id === E.collectId);
            const d = cb && ca ? cb.e - ca.e : null;
            ctx.accounting.push({ g: collectG, kind: 'withdraw', creepGain: c && c.e, contDelta: d });
            if (d === null) bad.push('container missing at collect fence');
            else if (d !== c.e) bad.push(`withdraw: container -${d} != creep +${c.e}`);
        }
    }

    if (deliverG !== null) {
        const f = fenceAt(ctx, deliverG), p = fenceAt(ctx, deliverG - 1);
        const pc = p && creepAt(p, N);
        const lost = pc ? pc.e : null;
        if (E.deliverTarget === 'spawn') {
            const d = f.se - p.se;
            ctx.accounting.push({ g: deliverG, kind: 'transfer-spawn', creepDelta: lost, spawnDelta: d });
            const want = lost + (p.se < 300 ? 1 : 0);
            if (d !== want) bad.push(`transfer fence spawn +${d} want ${want}`);
        } else if (E.deliverTarget === 'extension') {
            const eb = p.ext.find(e => e.id === E.deliverId), ea = f.ext.find(e => e.id === E.deliverId);
            const d = eb && ea ? ea.e - eb.e : null;
            ctx.accounting.push({ g: deliverG, kind: 'transfer-ext', creepDelta: lost, extDelta: d });
            if (d === null) bad.push('extension missing at deliver fence');
            else if (d !== Math.min(lost, 50 - eb.e)) bad.push(`ext +${d} want ${Math.min(lost, 50 - eb.e)}`);
        } else if (E.deliverTarget === 'creep') {
            const rb = p.cr.find(x => x.id === E.deliverId), ra = f.cr.find(x => x.id === E.deliverId);
            const d = rb && ra ? ra.e - rb.e : null;
            ctx.accounting.push({ g: deliverG, kind: 'transfer-creep', creepDelta: lost, recvDelta: d });
            if (d === null) bad.push('recipient missing at deliver fence');
            else if (d !== lost) bad.push(`recipient +${d} want ${lost}`);
        } else if (E.deliverTarget === 'ground') {
            const zone = E.deliverZone;
            const pIn = p ? dropsNear(p, zone.pos, zone.range).reduce((s, x) => s + x.amt, 0) : 0;
            const cIn = dropsNear(f, zone.pos, zone.range).reduce((s, x) => s + x.amt, 0);
            ctx.accounting.push({ g: deliverG, kind: 'drop-ground', creepDelta: lost, zoneDelta: cIn - pIn });
            if (Math.abs((cIn - pIn) - lost) > 4) bad.push(`drop zone +${cIn - pIn} want ${lost}`);
        } else if (E.deliverTarget === 'anyStructure') {
            const extD = E.deliverIds || {};
            const sGain = (f.se - p.se) - (p.se < 300 ? 1 : 0);
            let eGain = 0;
            for (const id of Object.values(extD)) {
                const eb = p.ext.find(e => e.id === id), ea = f.ext.find(e => e.id === id);
                if (eb && ea) eGain += ea.e - eb.e;
            }
            ctx.accounting.push({ g: deliverG, kind: 'transfer-any', creepDelta: lost, spawnGain: sGain, extGain: eGain });
            if (sGain + eGain !== lost) bad.push(`structure deliveries +${sGain + eGain} want ${lost} (spawn ${sGain} + ext ${eGain})`);
        }
    }

    if (E.stuckIndex !== undefined) {
        for (const f of fs) {
            const m = cmOf(f);
            if (m && m.cti !== undefined && m.cti !== null && m.cti !== E.stuckIndex) {
                bad.push(`t${f.g}: taskIndex ${m.cti} want stuck at ${E.stuckIndex}`);
            }
        }
    }
    return bad;
}

// ---------------------------------------------------------------------------
// Oracle: ECO-03 upgrader
// ---------------------------------------------------------------------------
function oracleEco03(ctx) {
    const bad = [];
    const fs = fenceList(ctx);
    const N = ctx.creepName;
    ctx.characterizations = ctx.characterizations || [];
    ctx.evidence = ctx.evidence || {};
    ctx.accounting = ctx.accounting || [];

    bad.push(...spawnEnergyProblems(ctx, ctx.spawnPos));
    bad.push(...creepMoveProblems(ctx, N));
    const E = ctx.expect || {};
    const cmOf = f => (f.cm || {})[N] || null;
    const stateOf = f => { const m = cmOf(f); return m && m.state; };

    const stateSeq = [];
    for (const f of fs) {
        const s = stateOf(f);
        if (!s) continue;
        if (!stateSeq.length || stateSeq[stateSeq.length - 1].s !== s) stateSeq.push({ g: f.g, s });
    }
    ctx.evidence.stateSeq = stateSeq;
    expectStateSeq(ctx, E, stateSeq, bad);

    let fillG = null;
    for (let i = 1; i < fs.length; i++) {
        const pc = creepAt(fs[i - 1], N), cc = creepAt(fs[i], N);
        if (!pc || !cc) continue;
        if (fillG === null && pc.e === 0 && cc.e > 0) fillG = fs[i].g;
    }
    ctx.evidence.fillG = fillG;
    if (E.fill !== false && fillG === null) bad.push('energy fill fence never observed');

    let upTicks = 0;
    for (let i = 1; i < fs.length; i++) {
        const p = fs[i - 1], c = fs[i];
        if (!p.ctrl || !c.ctrl) continue;
        const dp = c.ctrl.prog - p.ctrl.prog;
        const pc = creepAt(p, N), cc = creepAt(c, N);
        if (!pc || !cc) continue;
        const de = cc.e - pc.e;
        if (dp > 0) {
            upTicks++;
            ctx.accounting.push({ g: c.g, kind: 'upgrade', progressDelta: dp, storeDelta: de });
            if (dp !== -de) bad.push(`t${c.g}: progress +${dp} != store drain ${-de}`);
            if (dp !== ctx.workParts) bad.push(`t${c.g}: progress +${dp} != work parts ${ctx.workParts}`);
            if (!(cc.act && cc.act.upgradeController)) bad.push(`t${c.g}: progress grew without upgradeController actionLog`);
            if (cheb(cc, ctx.ctrlPos) > 3) bad.push(`t${c.g}: upgrade at range ${cheb(cc, ctx.ctrlPos)} > 3`);
        } else if (dp < 0) {
            bad.push(`t${c.g}: controller.progress decreased ${p.ctrl.prog}->${c.ctrl.prog}`);
        }
    }
    ctx.evidence.upTicks = upTicks;
    if (E.upgrade !== false && upTicks === 0) bad.push('controller.progress never grew');

    if (fillG !== null && E.fillSource) {
        const f = fenceAt(ctx, fillG), p = fenceAt(ctx, fillG - 1);
        if (E.fillSource === 'pile') {
            const ids = E.pileIds || [];
            const b4 = p ? p.drops.filter(d => ids.includes(d.id)).reduce((s, x) => s + x.amt, 0) : null;
            const af = f.drops.filter(d => ids.includes(d.id)).reduce((s, x) => s + x.amt, 0);
            ctx.accounting.push({ g: fillG, kind: 'pickup', pileDelta: b4 === null ? null : b4 - af });
            if (b4 === null || b4 - af <= 0) bad.push('fill fence without pile loss');
        } else if (E.fillSource === 'container') {
            const cb = p && p.cont.find(x => x.id === E.fillId), ca = f.cont.find(x => x.id === E.fillId);
            const d = cb && ca ? cb.e - ca.e : null;
            ctx.accounting.push({ g: fillG, kind: 'withdraw', contDelta: d });
            if (d === null || d <= 0) bad.push('fill fence without container drain');
        }
    }
    return bad;
}

// ---------------------------------------------------------------------------
// Shared per-tick live checks
// ---------------------------------------------------------------------------
function creepAliveCheck(name) {
    return (rec, prev, ctx) => {
        const bad = [];
        const c = (rec.creeps || []).find(x => x.name === name);
        if (!c) bad.push(`creep ${name} missing`);
        else if (c.hits !== c.body.length * 100) bad.push(`creep hits ${c.hits} want ${c.body.length * 100}`);
        return bad;
    };
}
const TRIVIAL = () => [];

// Postcondition helpers — compact event checks on the current frame.
const evHarvestEvidence = (rec, ctx) => {
    const c = (rec.creeps || []).find(x => x.name === ctx.creepName);
    const s = (rec.sources || []).find(x => x.id === ctx.s1);
    const harv = (rec.actionLog || []).some(a => a.name === ctx.creepName && a.actionLog && a.actionLog.harvest);
    return !!(c && c.store && c.store.energy > 0 && s && s.energy < ctx.source1Initial && harv);
};
const evNocarryDrop = (rec, ctx) => {
    const c = (rec.creeps || []).find(x => x.name === ctx.creepName);
    const s = (rec.sources || []).find(x => x.id === ctx.s1);
    const drop = (rec.drops || []).some(d => c && Math.max(Math.abs(d.x - c.x), Math.abs(d.y - c.y)) <= 1);
    return !!(c && drop && s && s.energy < ctx.source1Initial);
};
const evFullDrop = (rec, ctx) => {
    const c = (rec.creeps || []).find(x => x.name === ctx.creepName);
    const drop = (rec.drops || []).some(d => c && d.x === c.x && d.y === c.y && (d.amount || d.energy) >= 40);
    return !!(c && c.store && c.store.energy === 0 && drop);
};
const evUpgrade = (rec, ctx) => {
    const ctrl = rec.controller || (rec.objects || []).find(x => x.type === 'controller');
    const c = (rec.creeps || []).find(x => x.name === ctx.creepName);
    const up = (rec.actionLog || []).some(a => a.name === ctx.creepName && a.actionLog && a.actionLog.upgradeController);
    return !!(ctrl && ctrl.progress >= 2 && c && up);
};

// dist2 template-memory builders for probe injection (runtime ids/pos).
const tplGround = (pos, range) => ({ type: 'area', entityType: 'ground', pos: { x: pos.x, y: pos.y }, range });
const tplEntity = (id) => ({ type: 'entity', id });
const tplStruct = (pos, range, types) => ({ type: 'area', entityType: 'structure', pos: { x: pos.x, y: pos.y }, range, structureTypes: types });
const tplCreepArea = (pos, range, roles) => ({ type: 'area', entityType: 'creep', pos: { x: pos.x, y: pos.y }, range, roles });
const muleMem = (collectTemplates, deliverTemplates) => ({ role: 'mule', collectTemplates, deliverTemplates });

// ---------------------------------------------------------------------------
// Mode table
// ---------------------------------------------------------------------------
const MODES = {
    'eco-00-refuse': {
        ports: [32440, 32441], scenario: 'ECO-00-REFUSE', maxSteps: 1, tree: 'dist',
        refuse: true, wcase: 120000,
    },
    // ---- ECO-01 harvest ----------------------------------------------------
    'eco-01-d': {
        ports: [32442, 32443], scenario: 'ECO-01-D', maxSteps: 35, tree: 'dist',
        creep: true, creepName: 'har1', body: ['work', 'carry', 'move'], workParts: 1,
        d: { creepMemory: { har1: { role: 'harvester', efficiency: 1, assignedSource: '__S1__' } }, doneT: 30 },
        oracle: oracleEco01, evPost: evHarvestEvidence,
        liveCheck: creepAliveCheck('har1'),
    },
    'eco-01-d-nocarry': {
        ports: [32444, 32445], scenario: 'ECO-01-D-NOCARRY', maxSteps: 35, tree: 'dist',
        creep: true, creepName: 'har1', body: ['move', 'work'], workParts: 1,
        d: { creepMemory: { har1: { role: 'harvester', efficiency: 1, assignedSource: '__S1__' } }, doneT: 30 },
        expectPileDrop: true,
        oracle: oracleEco01, evPost: evNocarryDrop,
        liveCheck: creepAliveCheck('har1'),
    },
    'eco-01-d2': {
        ports: [32446, 32447], scenario: 'ECO-01-D2', maxSteps: 60, tree: 'dist2',
        creep: true, creepName: 'har1', body: ['work', 'carry', 'move'], workParts: 1,
        d2: { creepMemory: { har1: { role: 'harvester', sourceId: '__S1__' } }, doneT: 55 },
        expectFullDrop: true,
        oracle: oracleEco01, evPost: evFullDrop,
        liveCheck: creepAliveCheck('har1'),
    },
    'eco-01-d-nosrc': {
        ports: [32448, 32449], scenario: 'ECO-01-D-NOSRC', maxSteps: 10, tree: 'dist',
        creep: true, creepName: 'har1', body: ['work', 'carry', 'move'], variant: 'nosrc',
        d: { creepMemory: { har1: { role: 'harvester', efficiency: 1, assignedSource: 'nosuchid000' } }, doneT: 8 },
        oracle: oracleEco01Negative, runFullBudget: true,
        liveCheck: creepAliveCheck('har1'),
    },
    'eco-01-d2-nosrc': {
        ports: [32440, 32441], scenario: 'ECO-01-D2-NOSRC', maxSteps: 10, tree: 'dist2',
        creep: true, creepName: 'har1', body: ['work', 'carry', 'move'], variant: 'nosrc',
        d2: { creepMemory: { har1: { role: 'harvester', sourceId: 'nosuchid000' } }, doneT: 8 },
        oracle: oracleEco01Negative, runFullBudget: true,
        liveCheck: creepAliveCheck('har1'),
    },
    'eco-01-d-emptysrc': {
        ports: [32442, 32443], scenario: 'ECO-01-D-EMPTYSRC', maxSteps: 14, tree: 'dist',
        creep: true, creepName: 'har1', body: ['work', 'carry', 'move'], variant: 'emptysrc',
        d: { creepMemory: { har1: { role: 'harvester', efficiency: 1, assignedSource: '__S1__' } }, doneT: 12 },
        beforeStep: { 1: 'source0' },
        oracle: oracleEco01Negative, runFullBudget: true,
        liveCheck: creepAliveCheck('har1'),
    },
    'eco-01-d2-emptysrc': {
        ports: [32444, 32445], scenario: 'ECO-01-D2-EMPTYSRC', maxSteps: 14, tree: 'dist2',
        creep: true, creepName: 'har1', body: ['work', 'carry', 'move'], variant: 'emptysrc',
        d2: { creepMemory: { har1: { role: 'harvester', sourceId: '__S1__' } }, doneT: 12 },
        beforeStep: { 1: 'source0' },
        oracle: oracleEco01Negative, runFullBudget: true,
        liveCheck: creepAliveCheck('har1'),
    },
    'eco-01-d-spawning': {
        ports: [32446, 32447], scenario: 'ECO-01-D-SPAWNING', maxSteps: 10, tree: 'dist',
        creep: true, creepName: 'har1', body: ['work', 'carry', 'move'], variant: 'spawning',
        d: { creepMemory: { har1: { role: 'harvester', efficiency: 1, assignedSource: '__S1__' } }, doneT: 8 },
        beforeStep: { 1: 'setSpawning' },
        oracle: oracleEco01Negative, runFullBudget: true,
        liveCheck: TRIVIAL,
    },
    'eco-01-d2-spawning': {
        ports: [32448, 32449], scenario: 'ECO-01-D2-SPAWNING', maxSteps: 10, tree: 'dist2',
        creep: true, creepName: 'har1', body: ['work', 'carry', 'move'], variant: 'spawning',
        d2: { creepMemory: { har1: { role: 'harvester', sourceId: '__S1__' } }, doneT: 8 },
        beforeStep: { 1: 'setSpawning' },
        oracle: oracleEco01Negative, runFullBudget: true,
        liveCheck: TRIVIAL,
    },
    'eco-01-control': {
        ports: [32450, 32451], scenario: 'ECO-01-CONTROL', maxSteps: 15, tree: 'dist',
        variant: 'control', runFullBudget: true,
        oracle: oracleEco01Negative,
    },
    // ---- ECO-02 dist delivery ----------------------------------------------
    'eco-02-d': {
        ports: [32452, 32453], scenario: 'ECO-02-D', maxSteps: 150, tree: 'dist',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        // Routes (priority-sorted desc): SrcM->SpnM(6), SrcM->StrM(4),
        // StrM->CtrlM(3). A SrcM mule only ever sees the first two — the
        // ctrl route's src is StorageManager, so no SrcM mule can deliver
        // to the controller. Queue demand makes SpnM.energyNeeded>0 so the
        // spawn route (highest priority) wins; StrM stays needy throughout
        // as the losing-route evidence.
        extra: [
            { kind: 'pile', near: 'source1', range: 1, amount: 200, keepAdjFree: false, pick: 'farSpawn' },
        ],
        d: {
            managers: true, consumers: ['ctrl', 'spn', 'str'], queueSeed: 1,
            muleSrc: 'SrcM', doneT: 140,
        },
        beforeStep: { 1: 'spawnEnergy:10' },
        expect: {
            destTypes: ['resource'], destPos: 'pile0', pickup: true, pending: true,
            dstName: '_SpnM', transfer: 'spawn', stateSeq: ['collect', 'store', 'collect'],
        },
        oracle: oracleEco02d,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            const needy = fs.some(f => { const k = mgrKey(f, '_StrM'); return k && f.mm[k].need > 0; });
            if (!needy) bad.push('StrM never needy — priority contest (SpnM 6 > StrM 4) not exercised');
            else ctx.characterizations.push('route priority: SpnM(6) chosen while StrM(4) also needy — real priority ordering');
            const ev = spawnEvents(ctx);
            if (ev.length) bad.push(`unexpected spawn events ${JSON.stringify(ev)}`);
            const qf = lastFence(ctx);
            const sk = mgrKey(qf, '_SpnM');
            if (!(sk && (qf.mm[sk].queue || []).some(q => q.n === 'harvester0'))) bad.push('queued harvester0 missing at end (queue should be retained, unspawned)');
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d-storage': {
        ports: [32454, 32455], scenario: 'ECO-02-D-STORAGE', maxSteps: 150, tree: 'dist',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        // SpnM queue empty -> need = 0-300-0 < 0 with a full spawn; the
        // SrcM mule skips SrcM->SpnM and takes SrcM->StrM -> ground drop
        // within r2 of StrM.pos (the spawn position). The StrM->CtrlM route
        // cannot match (src is StrM), so the controller is never a dst.
        extra: [
            { kind: 'pile', near: 'source1', range: 1, amount: 200, keepAdjFree: false, pick: 'farSpawn' },
        ],
        d: {
            managers: true, consumers: ['ctrl', 'spn', 'str'],
            muleSrc: 'SrcM', doneT: 140,
        },
        expect: {
            destTypes: ['resource'], destPos: 'pile0', pickup: true, pending: true,
            dstName: '_StrM', transfer: 'ground', transferZone: { pos: 'spawn', range: 2 },
            stateSeq: ['collect', 'store', 'collect'],
        },
        oracle: oracleEco02d,
        check: (ctx, bad) => {
            // DEFECT probe: pending energy counted TWICE inside StrM
            // energyNeeded = 3000 - (avail incl pending) - pending.
            const fs = fenceList(ctx);
            let saw = null;
            for (const f of fs) {
                const dk = mgrKey(f, '_DlvM'), sk = mgrKey(f, '_StrM');
                if (!dk || !sk) continue;
                const pend = (f.mm[dk].pend || {}).mule0;
                if (pend && pend.dst && pend.dst.includes('StrM')
                    && f.mm[sk].need !== undefined && f.mm[sk].avail !== undefined) {
                    saw = { g: f.g, need: f.mm[sk].need, avail: f.mm[sk].avail, pend: pend.amount };
                }
            }
            if (saw === null) bad.push('no fence with a live pending delivery to StrM — double-subtraction not observed');
            else {
                const wantSingle = 3000 - saw.avail;
                const wantDouble = 3000 - saw.avail - saw.pend;
                ctx.evidence.doubleSub = { ...saw, wantSingle, wantDouble };
                if (saw.need === wantDouble) {
                    ctx.characterizations.push(`DEFECT ECO-D1 (pending double-counted): StrM.energyNeeded=${saw.need} with pending=${saw.pend} avail=${saw.avail} — matches double-subtracted model (single would be ${wantSingle})`);
                } else if (saw.need === wantSingle) {
                    ctx.characterizations.push(`StrM.energyNeeded=${saw.need} single-counted pending (avail ${saw.avail} incl pend ${saw.pend})`);
                } else {
                    bad.push(`StrM.energyNeeded ${saw.need} matches neither single (${wantSingle}) nor double (${wantDouble}) model`);
                }
            }
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d-ctrl': {
        ports: [32456, 32457], scenario: 'ECO-02-D-CTRL', maxSteps: 150, tree: 'dist',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        // Second-tier delivery: StrM->CtrlM is the ONLY route a StrM-src
        // mule can take (CtrlM rulesTemplate producers=[StorageManager]).
        // The collect side is StrM.destination() = {ground, StrM.pos, r2}
        // — pickup from dropped energy within r2 of the spawn point — and
        // the store side drops within r2 of the controller.
        extra: [{ kind: 'pile', near: 'spawn', range: 2, amount: 200 }],
        d: {
            managers: true, consumers: ['ctrl', 'spn', 'str'],
            muleSrc: 'StrM', doneT: 140,
        },
        expect: {
            destTypes: ['ground'], destPos: 'spawn', destRange: 2, pickup: true, pending: true,
            dstName: '_CtrlM', transfer: 'ground', transferZone: { pos: 'controller', range: 2 },
            stateSeq: ['collect', 'store', 'collect'],
        },
        oracle: oracleEco02d,
        check: (ctx, bad) => {
            // Delivery destination must be ground{ctrlPos, range 2}.
            const cp = ctx.ctrlPos;
            const gd = (ctx.evidence.destSeq || []).filter(x => x.d && x.d.t === 'ground'
                && x.d.pos && x.d.pos.x === cp.x && x.d.pos.y === cp.y);
            if (!gd.length) bad.push('no ground delivery destination at the controller recorded');
            else if (gd[0].d.range !== 2) bad.push(`ground delivery range ${gd[0].d.range} want 2`);
            // CtrlM has the same double-subtraction shape as StrM, but its
            // save() does NOT persist availableEnergy — recompute the getter
            // probe-side: containers+drops within r2 of ctrl pos + pending.
            const fs = fenceList(ctx);
            for (const f of fs) {
                const dk = mgrKey(f, '_DlvM'), ck = mgrKey(f, '_CtrlM');
                if (!dk || !ck) continue;
                const pend = (f.mm[dk].pend || {}).mule0;
                if (pend && pend.dst && pend.dst.includes('CtrlM') && f.mm[ck].need !== undefined) {
                    const nearDrops = dropsNear(f, ctx.ctrlPos, 2).reduce((s, x) => s + x.amt, 0);
                    const nearCont = (f.cont || []).filter(x => cheb(x, ctx.ctrlPos) <= 2).reduce((s, x) => s + x.e, 0);
                    const availProbe = nearDrops + nearCont + pend.amount;
                    const wantDouble = 3000 - availProbe - pend.amount;
                    const wantSingle = 3000 - availProbe;
                    ctx.evidence.ctrlNeed = { g: f.g, need: f.mm[ck].need, availProbe, pend: pend.amount, wantSingle, wantDouble };
                    if (f.mm[ck].need === wantDouble) {
                        ctx.characterizations.push(`DEFECT ECO-D1 (CtrlM): energyNeeded=${f.mm[ck].need} with pending=${pend.amount} availProbe=${availProbe} — matches double-subtracted model (single would be ${wantSingle})`);
                    } else if (f.mm[ck].need === wantSingle) {
                        ctx.characterizations.push(`CtrlM.energyNeeded=${f.mm[ck].need} single-counted pending (availProbe ${availProbe})`);
                    } else {
                        bad.push(`CtrlM.energyNeeded ${f.mm[ck].need} matches neither single (${wantSingle}) nor double (${wantDouble}) probe model`);
                    }
                    break;
                }
            }
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d-wait': {
        ports: [32458, 32459], scenario: 'ECO-02-D-WAIT', maxSteps: 60, tree: 'dist',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        d: {
            managers: true, consumers: ['ctrl', 'spn', 'str'],
            muleSrc: 'SrcM', doneT: 55,
        },
        expect: {
            destTypes: ['wait'], pickup: false, pending: false, storeState: false,
            destPos: 'source1', destRange: 2, waitCount: true, stateSeq: ['collect'],
        },
        oracle: oracleEco02d,
        check: (ctx, bad) => {
            const c = creepAt(lastFence(ctx), 'mule0');
            if (c && c.e !== 0) bad.push(`mule store ${c.e} — energy appeared from nowhere`);
            if (!c) bad.push('mule missing');
            else {
                const d = cheb(c, ctx.s1Pos);
                const ds = ctx.evidence.destSeq || [];
                const tickingOutOfRange = ds.some(x => x.d && x.d.t === 'wait' && x.d.time !== undefined && x.d.time < 10);
                if (d > 2 && tickingOutOfRange) {
                    // ECO-D-WAITNAN: role.mule.js:17 calls
                    // creep.pos.getRangeTo(destination.pos) on a plain
                    // JSON {x,y} — fetchXYArguments returns undefined for
                    // non-RoomPosition objects → NaN → `NaN > range` false →
                    // the moveTo branch never runs; time-- counts down with
                    // the creep wherever it stands.
                    ctx.characterizations.push(`DEFECT ECO-D-WAITNAN: wait ${JSON.stringify(ds[0] && ds[0].d)} timed down to 0 while mule sat ${d} cells from source — getRangeTo(plain pos)=NaN skips moveTo; creep never reaches wait range`);
                } else if (d > 2) bad.push(`mule ended ${d} cells from source — never reached wait range 2`);
                else ctx.characterizations.push(`collect-side wait: mule parked ${d} cells from source; wait {source.pos,r2,time:10} counts down while parked, expires, re-plans a fresh wait — an idle 10-tick cycle while no resource exists`);
            }
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d-fulltarget': {
        ports: [32440, 32441], scenario: 'ECO-02-D-FULLTARGET', maxSteps: 115, tree: 'dist',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        // spawn 300/300 + extension 50/50 -> every structure slot full.
        // Queue demand keeps SpnM.energyNeeded > 0 so destination() can only
        // answer 'wait'; queue entries are consumed 1/tick by ERR_NAME_EXISTS
        // (8 living blocker creeps named harvester0..7, SpawnManager.run
        // shift()s the head before the failed spawnCreep — recorded as a
        // queue-drain characterization). ~8 ticks of need covers the mule's
        // collect walk; after the queue empties the wait countdown expires
        // and the pending dst switches to StrM (ground drop).
        extra: [
            { kind: 'pile', near: 'source1', range: 1, amount: 200, keepAdjFree: false, pick: 'closeCreep' },
            { kind: 'extension', near: 'spawn', range: 3, amount: 50 },
            { kind: 'creep', near: { x: 45, y: 45 }, range: 8, name: 'harvester0', body: ['move'], capacity: 0 },
            { kind: 'creep', near: { x: 45, y: 45 }, range: 8, name: 'harvester1', body: ['move'], capacity: 0 },
            { kind: 'creep', near: { x: 45, y: 45 }, range: 8, name: 'harvester2', body: ['move'], capacity: 0 },
            { kind: 'creep', near: { x: 45, y: 45 }, range: 8, name: 'harvester3', body: ['move'], capacity: 0 },
            { kind: 'creep', near: { x: 45, y: 45 }, range: 8, name: 'harvester4', body: ['move'], capacity: 0 },
            { kind: 'creep', near: { x: 45, y: 45 }, range: 8, name: 'harvester5', body: ['move'], capacity: 0 },
            { kind: 'creep', near: { x: 45, y: 45 }, range: 8, name: 'harvester6', body: ['move'], capacity: 0 },
            { kind: 'creep', near: { x: 45, y: 45 }, range: 8, name: 'harvester7', body: ['move'], capacity: 0 },
        ],
        d: {
            managers: true, consumers: ['ctrl', 'spn', 'str'], queueSeed: 8,
            muleSrc: 'SrcM', doneT: 105,
        },
        expect: {
            destTypes: ['resource'], destPos: 'pile0', pickup: true, pending: true,
            dstName: '_StrM', stateSeq: ['collect', 'store', 'collect'],
            waitCount: false, transfer: 'ground', transferZone: { pos: 'spawn', range: 2 },
        },
        oracle: oracleEco02d,
        check: (ctx, bad) => {
            const ev = spawnEvents(ctx);
            if (ev.length) bad.push(`unexpected spawn events ${JSON.stringify(ev)}`);
            const fs = fenceList(ctx);
            const qlens = fs.map(f => { const k = mgrKey(f, '_SpnM'); return k ? (f.mm[k].queue || []).length : null; });
            ctx.evidence.queueLens = qlens;
            const last = lastFence(ctx);
            const lastQ = qlens[qlens.length - 1];
            if (lastQ !== 0) bad.push(`queue not fully consumed (len ${lastQ}) — NAME_EXISTS drain characterization uncertain`);
            else ctx.characterizations.push('queue drained 1/tick: SpawnManager.run shift()s the head before the failed (ERR_NAME_EXISTS) spawnCreep — entry lost without spawning');
            const waits = (ctx.evidence.destSeq || []).filter(x => x.d && x.d.t === 'wait');
            const seq = (ctx.evidence.destSeq || []).map(x => x.d && (x.d.t === 'structure' ? `struct:${x.d.id === ctx.spawnId ? 'spawn' : '?'}` : x.d.t)).filter(Boolean);
            if (waits.length) ctx.characterizations.push(`full-target: SpnM.destination() returned wait (times ${JSON.stringify(waits.map(w => w.d.time))}) — the countdown ticks while parked; dst re-planned to StrM once queue need died`);
            else ctx.characterizations.push(`full-target drain-first: queue emptied before store entry — no wait window; dst sequence ${JSON.stringify(seq)} (StrM fallback after need died is the documented route-map order)`);
            const c = creepAt(last, 'mule0');
            if (!c) bad.push('mule missing at end');
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d-extremoved': {
        ports: [32442, 32443], scenario: 'ECO-02-D-EXTREMOVED', maxSteps: 30, tree: 'dist',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        extra: [
            { kind: 'pile', near: 'source1', range: 1, amount: 200, keepAdjFree: false, pick: 'farSpawn' },
        ],
        d: {
            managers: true, consumers: ['ctrl', 'spn', 'str'], queueSeed: 1,
            muleSrc: 'SrcM', doneT: 25,
        },
        // spawn drained to 40 + queue [harvester0@150] -> SpnM needy -> the
        // delivery structure destination is the SPAWN itself; memCond deletes
        // the spawn row as soon as the destination is written. role.mule's
        // 'structure' branch then calls creep.pos.getRangeTo(null).
        beforeStep: { 1: 'spawnEnergy:40' },
        memCond: { when: 'destIsStructure', act: 'delDestObj' },
        expect: {
            destTypes: ['resource'], destPos: 'pile0', pickup: true, pending: true,
            deliver: false, clear: false,
            dstName: '_SpnM', stateSeq: ['collect', 'store'],
        },
        oracle: oracleEco02d,
        check: (ctx, bad) => {
            // DEFECT: removed structure destination -> getObjectById(id) ->
            // null -> creep.pos.getRangeTo(null) -> TypeError every tick,
            // pending stranded, energy held.
            const lf = lastFence(ctx);
            const errs = (lf.eco && lf.eco.errs) || [];
            const te = errs.filter(e => e.k === 'TypeError');
            const errStr = lf.eco && lf.eco.err;
            if (!te.length && !(errStr && errStr.includes('TypeError'))) {
                // getObjectById returns null but does not throw: getRangeTo(null)
                // evaluates NaN (same class as ECO-D-WAITNAN) so moveTo(null)
                // fails silently every tick and the memory destination is
                // retained, never re-planned. The real defect: the
                // plannedDeliveries row stays stranded after the target's
                // removal — pending outlives its dst.
                ctx.characterizations.push(`DEFECT ECO-D2': removed structure destination -> getObjectById null does not throw (getRangeTo(null)=NaN, moveTo skipped, memory dest retained); the defect is the stranded pending row outliving re-plan`);
            } else {
                ctx.characterizations.push(`DEFECT ECO-D2 reproduced: removed structure destination -> role.mule TypeError (${te.length} role-caught` +
                    (errStr ? ` + entrypoint-level: ${errStr.slice(0, 80)}` : '') + `); energy held, pending stranded`);
            }
            const c = creepAt(lf, 'mule0');
            if (c && c.e === 0) bad.push('mule store emptied despite removed target');
            const dk = mgrKey(lf, '_DlvM');
            const pend = dk && lf.mm[dk].pend && lf.mm[dk].pend.mule0;
            if (!pend) bad.push('pending row gone — expected stranded pending for the wedged mule');
            else ctx.characterizations.push(`pending stranded: {amount:${pend.amount},dst:${pend.dst}} persists with a live wedged mule`);
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d-noroute': {
        ports: [32444, 32445], scenario: 'ECO-02-D-NOROUTE', maxSteps: 18, tree: 'dist',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        extra: [{ kind: 'pile', near: 'source1', range: 1, amount: 200, keepAdjFree: false, pick: 'farSpawn' }],
        d: {
            managers: true, consumers: [],
            muleSrc: 'SrcM', doneT: 16,
        },
        expect: {
            destTypes: ['resource'], destPos: 'pile0', pickup: true,
            pending: false, needsDest: false, stateSeq: ['collect', 'store'],
        },
        runFullBudget: true,
        oracle: oracleEco02d,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            for (const f of fs) {
                const dk = mgrKey(f, '_DlvM');
                const pend = dk && f.mm[dk].pend;
                if (pend && Object.keys(pend).length) bad.push(`t${f.g}: pending written with no routes`);
                const d = (f.cm || {}).mule0 && f.cm.mule0.dest;
                if (d && (d.t === 'structure' || d.t === 'ground')) bad.push(`t${f.g}: delivery destination ${d.t} written with no routes`);
            }
            const c = creepAt(lastFence(ctx), 'mule0');
            if (!c) bad.push('mule missing');
            else if (c.e !== 100) bad.push(`mule store ${c.e} want 100 retained (no route)`);
            else ctx.characterizations.push('no-route: planDelivery matched nothing; energy held >=4 fences, no pending, no destination');
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d-death': {
        ports: [32446, 32447], scenario: 'ECO-02-D-DEATH', maxSteps: 35, tree: 'dist',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        extra: [
            { kind: 'pile', near: 'source1', range: 1, amount: 200, keepAdjFree: false, pick: 'farSpawn' },
        ],
        d: {
            managers: true, consumers: ['ctrl', 'spn', 'str'], queueSeed: 1,
            muleSrc: 'SrcM', doneT: 30,
        },
        beforeStep: { 1: 'spawnEnergy:10' },
        memCond: { when: 'destIsStructure', act: 'delCreep' },
        expect: {
            // pending: the mule dies at the destIsStructure instant — the
            // pending row can be written and removed inside a single fence;
            // the check below verifies the death-cleanup contract directly.
            destTypes: ['resource'], destPos: 'pile0', pickup: true, pending: false,
            deliver: false,
            dstName: '_SpnM', stateSeq: ['collect', 'store'],
        },
        oracle: oracleEco02d,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            let deathG = null, clearedG = null;
            for (const f of fs) {
                if (deathG === null && !creepAt(f, 'mule0') && f.g > 2) deathG = f.g;
                const dk = mgrKey(f, '_DlvM');
                const pend = dk && f.mm[dk].pend && f.mm[dk].pend.mule0;
                if (deathG !== null && clearedG === null && !pend) clearedG = f.g;
            }
            if (deathG === null) bad.push('mule never removed (memCond delete did not fire)');
            else {
                if (clearedG === null) bad.push('pending for dead mule never cleared');
                else if (clearedG > deathG + 1) bad.push(`pending cleared at ${clearedG}, >1 fence after death ${deathG}`);
                else ctx.characterizations.push(`mule deleted at t~${deathG - 1}: pending row removed by DlvM.run within 1 fence (t${clearedG})`);
            }
        },
        liveCheck: TRIVIAL,
    },
    'eco-02-control': {
        ports: [32448, 32449], scenario: 'ECO-02-CONTROL', maxSteps: 15, tree: 'dist',
        variant: 'control', runFullBudget: true,
        extra: [{ kind: 'pile', near: 'source1', range: 1, amount: 200, keepAdjFree: false, pick: 'farSpawn' }],
        oracle: (ctx) => {
            const bad = [];
            const fs = fenceList(ctx);
            ctx.characterizations = ctx.characterizations || [];
            ctx.evidence = ctx.evidence || {};
            for (const f of fs) {
                if ((f.cr || []).length) bad.push(`t${f.g}: unexpected creep`);
            }
            bad.push(...spawnEnergyProblems(ctx, ctx.spawnPos));
            bad.push(...sourceProblems(ctx, 's1', {}, ctx.s1Pos));
            bad.push(...sourceProblems(ctx, 's2', {}, ctx.s2Pos));
            const ids = ctx.pileIds || [];
            const seq = fs.map(f => ({ g: f.g, amt: f.drops.filter(d => ids.includes(d.id)).reduce((s, x) => s + x.amt, 0) }));
            ctx.evidence.pileSeq = seq;
            const drift = seq.length ? seq[seq.length - 1].amt - seq[0].amt : 0;
            ctx.characterizations.push(`control pile drift over ${seq.length} fences: ${JSON.stringify(seq.map(x => x.amt))} (net ${drift})`);
            return bad;
        },
    },
    // ---- ECO-02 dist2 delivery ---------------------------------------------
    'eco-02-d2-area': {
        ports: [32450, 32451], scenario: 'ECO-02-D2-AREA', maxSteps: 70, tree: 'dist2',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        extra: [{ kind: 'pile', near: 'source1', range: 1, amount: 200, keepAdjFree: true }],
        d2: {
            useRoomCtrl: true, copyOrderFrom: 'mule_spawn',
            copyOrderMemory: { mule0: null }, roleOnly: ['mule0'], doneT: 62,
        },
        beforeStep: { 1: 'spawnEnergy:100' },
        expect: {
            stateSeq: ['collecting', 'delivering', 'collecting'],
            collectSource: 'pile', deliverTarget: 'spawn',
        },
        oracle: oracleEco02d2,
        check: (ctx, bad) => {
            const lf = lastFence(ctx);
            const orders = (lf.rm && lf.rm.creepOrder || []).map(o => o.id);
            const want = [`mule_spawn_${ctx.s1}`, `mule_controller_${ctx.s1}`, `upgrader_${ctx.s1}`,
                `mule_spawn_${ctx.s2}`, `mule_controller_${ctx.s2}`, `upgrader_${ctx.s2}`];
            for (const w of want) if (!orders.includes(w)) bad.push(`RoomController order ${w} missing (${JSON.stringify(orders)})`);
            for (const o of (lf.rm && lf.rm.creepOrder) || []) {
                if (o.st !== 'pending') bad.push(`order ${o.id} status ${o.st} (want pending — no reconcile in window)`);
            }
            const copied = (lf.eco || {}).copied;
            if (!copied || !copied.length) bad.push('order memory was not copied to the mule');
            else ctx.characterizations.push(`mule memory copied verbatim from real order ${copied[0].from}`);
            // RoomController emits structureTypes as a space-separated STRING
            // ('spawn extension'); role.mule calls .includes() on it, which is
            // String.includes -> substring match. 'spawn' and 'extension'
            // happen to match; any type whose name is not a substring (or is
            // a substring of another) breaks. Worth recording as evidence.
            ctx.characterizations.push('structureTypes is a string — mule .includes() does substring matching (works for spawn/extension by coincidence, fragile)');
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d2-ctrl': {
        ports: [32452, 32453], scenario: 'ECO-02-D2-CTRL', maxSteps: 65, tree: 'dist2',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        extra: [{ kind: 'pile', near: 'source1', range: 1, amount: 200, keepAdjFree: true }],
        d2: {
            useRoomCtrl: true, copyOrderFrom: 'mule_controller',
            copyOrderMemory: { mule0: null }, roleOnly: ['mule0'], doneT: 60,
        },
        expect: {
            stateSeq: ['collecting', 'delivering', 'collecting'],
            collectSource: 'pile', deliverTarget: 'ground',
            deliverZone: { pos: 'controller', range: 4 },
        },
        oracle: oracleEco02d2,
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d2-entity': {
        ports: [32454, 32455], scenario: 'ECO-02-D2-ENTITY', maxSteps: 62, tree: 'dist2',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        extra: [{ kind: 'container', near: 'creep', range: 2, amount: 100 }],
        probMem: ['mule0'],
        memInject: (ctx) => ({
            mule0: muleMem(
                [tplEntity(ctx.extra.containers[0].id)],
                [tplEntity(ctx.spawnId)]),
        }),
        d2: { roleOnly: ['mule0'], doneT: 58 },
        beforeStep: { 1: 'spawnEnergy:100' },
        expect: {
            stateSeq: ['collecting', 'delivering', 'collecting'],
            collectSource: 'container', collectId: 'container0', deliverTarget: 'spawn',
        },
        oracle: oracleEco02d2,
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d2-creep': {
        ports: [32456, 32457], scenario: 'ECO-02-D2-CREEP', maxSteps: 55, tree: 'dist2',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        extra: [
            { kind: 'pile', near: 'source1', range: 1, amount: 200, keepAdjFree: true },
            { kind: 'creep', near: 'source1', range: 3, name: 'upg1', body: ['carry', 'carry'], capacity: 100 },
        ],
        probMem: ['mule0'],
        memInject: (ctx) => ({
            mule0: muleMem(
                [tplGround(ctx.s1Pos, 3)],
                [tplCreepArea(ctx.s1Pos, 3, ['upgrader'])]),
        }),
        d2: {
            creepMemory: { upg1: { role: 'upgrader' } },
            roleOnly: ['mule0'], doneT: 50,
        },
        expect: {
            stateSeq: ['collecting', 'delivering', 'collecting'],
            collectSource: 'pile', deliverTarget: 'creep', deliverId: 'upg1',
        },
        oracle: oracleEco02d2,
        check: (ctx, bad) => {
            const lf = lastFence(ctx);
            const r = creepAt(lf, 'upg1');
            if (!r) bad.push('recipient creep missing at end');
            else if (r.e !== 100) bad.push(`recipient energy ${r.e} want 100`);
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d2-nearest': {
        ports: [32458, 32459], scenario: 'ECO-02-D2-NEAREST', maxSteps: 65, tree: 'dist2',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        extra: [
            { kind: 'pile', near: 'source1', range: 1, amount: 150, pick: 'closeCreep', keepAdjFree: true },
            { kind: 'pile', near: 'source1', range: 3, amount: 150, pick: 'farCreep', noAdj: true, minChebCreep: 'gtCreepNear0' },
            { kind: 'extension', near: 'source1', range: 4, amount: 0, pick: 'closeCreep' },
        ],
        probMem: ['mule0'],
        memInject: (ctx) => ({
            mule0: muleMem(
                [tplGround(ctx.s1Pos, 3)],
                [tplStruct(ctx.spawnPos, 50, 'spawn extension')]),
        }),
        d2: { roleOnly: ['mule0'], doneT: 60 },
        beforeStep: { 1: 'spawnEnergy:100' },
        expect: {
            stateSeq: ['collecting', 'delivering', 'collecting'],
            collectSource: 'pile', deliverTarget: 'anyStructure',
            deliverIds: { ext: 'extension0' },
        },
        oracle: oracleEco02d2,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            const nearId = ctx.pileIds && ctx.pileIds[0];
            const farId = ctx.pileIds && ctx.pileIds[1];
            let nearHit = null, farHit = null;
            for (const f of fs) {
                const nb = f.drops.find(d => d.id === nearId), fb = f.drops.find(d => d.id === farId);
                if (nearHit === null && (!nb || nb.amt < 50)) nearHit = f.g;
                if (farHit === null && (!fb || fb.amt < 50)) farHit = f.g;
            }
            if (nearHit === null) bad.push('near pile never collected');
            if (farHit !== null && nearHit !== null && farHit < nearHit) bad.push(`far pile drained t${farHit} before near t${nearHit}`);
            else if (nearHit !== null) ctx.characterizations.push(`nearest-first collect: near pile drained t${nearHit}, far ${farHit === null ? 'untouched in window' : 't' + farHit}`);
            // first delivery goes to the nearest structure (ext vs spawn)
            const sc = ctx.evidence.storeChanges || [];
            const firstDrop = sc.find(x => x.to < x.from);
            if (!firstDrop) bad.push('no delivery store-loss fence');
            else {
                const pf = fenceAt(ctx, firstDrop.g - 1), cf = fenceAt(ctx, firstDrop.g);
                const c = pf && creepAt(pf, 'mule0');
                const ext = ctx.extra.extensions && ctx.extra.extensions[0];
                const eb = pf.ext.find(e => e.id === (ext && ext.id)), ea = cf.ext.find(e => e.id === (ext && ext.id));
                const extGain = (ea && eb) ? ea.e - eb.e : 0;
                const spawnGain = (cf.se - pf.se) - (pf.se < 300 ? 1 : 0);
                if (extGain <= 0 && spawnGain <= 0) bad.push(`first store loss at t${firstDrop.g} matched no structure gain`);
                else if (c && ext) {
                    const dExt = cheb(c, ext), dSpawn = cheb(c, ctx.spawnPos);
                    const chose = extGain > 0 ? 'ext' : 'spawn';
                    const nearest = dExt <= dSpawn ? 'ext' : 'spawn';
                    if (chose !== nearest) bad.push(`delivered to ${chose} (d ext=${dExt} spawn=${dSpawn}) want nearest ${nearest}`);
                    else ctx.characterizations.push(`nearest structure chosen at first delivery: ${chose} (d ext=${dExt} spawn=${dSpawn})`);
                }
            }
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d2-removed': {
        ports: [32440, 32441], scenario: 'ECO-02-D2-REMOVED', maxSteps: 20, tree: 'dist2',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        d2: {
            creepMemory: { mule0: muleMem([tplEntity('deadbeefdeadbeef')], [tplEntity('deadbeefdeadbeef')]) },
            roleOnly: ['mule0'], doneT: 18,
        },
        runFullBudget: true,
        expect: { collect: false, deliver: false, stateSeq: ['collecting'], stuckIndex: 0 },
        oracle: oracleEco02d2,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            const c0 = creepAt(fs[1] || fs[0], 'mule0');
            for (const f of fs) {
                const c = creepAt(f, 'mule0');
                if (c && c0 && (c.x !== c0.x || c.y !== c0.y)) bad.push(`t${f.g}: mule moved to ${c.x},${c.y} with unreachable entity`);
                if (c && c.e !== 0) bad.push(`t${f.g}: store ${c.e} != 0`);
            }
            ctx.characterizations.push('removed collect target: collectFromEntity returns false each tick — mule stuck collecting at index 0, no movement, no crash');
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d2-fulltarget': {
        ports: [32442, 32443], scenario: 'ECO-02-D2-FULLTARGET', maxSteps: 25, tree: 'dist2',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        extra: [
            { kind: 'container', near: 'creep', range: 2, amount: 100 },
            { kind: 'extension', near: 'spawn', range: 3, amount: 50 },
        ],
        probMem: ['mule0'],
        memInject: (ctx) => ({
            mule0: muleMem(
                [tplEntity(ctx.extra.containers[0].id)],
                [tplEntity(ctx.extra.extensions[0].id)]),
        }),
        d2: { roleOnly: ['mule0'], doneT: 22 },
        runFullBudget: true,
        expect: {
            stateSeq: ['collecting', 'delivering'],
            collectSource: 'container', collectId: 'container0', deliver: false, stuckIndex: 0,
        },
        oracle: oracleEco02d2,
        check: (ctx, bad) => {
            const lf = lastFence(ctx);
            const c = creepAt(lf, 'mule0');
            if (!c) bad.push('mule missing');
            else if (c.e !== 100) bad.push(`mule store ${c.e} want 100 retained (ERR_FULL loop)`);
            else ctx.characterizations.push('full deliver target: transfer ERR_FULL each tick → success false, task index pinned at 0, energy retained — silent retry loop');
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d2-emptysrc': {
        ports: [32444, 32445], scenario: 'ECO-02-D2-EMPTYSRC', maxSteps: 15, tree: 'dist2',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        probMem: ['mule0'],
        memInject: (ctx) => ({
            mule0: muleMem(
                [tplGround(ctx.s1Pos, 3)],
                [tplEntity('deadbeefdeadbeef')]),
        }),
        d2: { roleOnly: ['mule0'], doneT: 13 },
        runFullBudget: true,
        expect: { collect: false, deliver: false, stateSeq: ['collecting'], stuckIndex: 0 },
        oracle: oracleEco02d2,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            const c0 = creepAt(fs[1] || fs[0], 'mule0');
            for (const f of fs) {
                const c = creepAt(f, 'mule0');
                if (c && c0 && (c.x !== c0.x || c.y !== c0.y)) bad.push(`t${f.g}: mule moved with empty collect area`);
            }
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    'eco-02-d2-death': {
        ports: [32446, 32447], scenario: 'ECO-02-D2-DEATH', maxSteps: 25, tree: 'dist2',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        extra: [{ kind: 'pile', near: 'source1', range: 1, amount: 200, keepAdjFree: true }],
        probMem: ['mule0'],
        memInject: (ctx) => ({
            mule0: muleMem(
                [tplGround(ctx.s1Pos, 3)],
                [tplEntity(ctx.spawnId)]),
        }),
        d2: {
            roleOnly: ['mule0'], kill: { t: 8, name: 'mule0' }, reconcileSpawn: true, doneT: 20,
        },
        expect: { collect: false, deliver: false, stateSeq: ['collecting'] },
        oracle: oracleEco02d2,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            let deathG = null, memGoneG = null;
            for (const f of fs) {
                if (deathG === null && f.g > 9 && !creepAt(f, 'mule0')) deathG = f.g;
                if (deathG !== null && memGoneG === null && f.cm && !('mule0' in f.cm)) memGoneG = f.g;
            }
            if (deathG === null) bad.push('mule never died');
            if (memGoneG === null) bad.push('Memory.creeps[mule0] never cleaned (reconcile at %10 did not remove it)');
            // The %10 reconcile runs at user Game.time=10; its memory write
            // lands in the post-step frame at gameTime 11 (user tick t ->
            // frame t+1, same as SPN's f11/f21/f31 reconcile evidence).
            else if (memGoneG !== 11) bad.push(`Memory.creeps[mule0] cleaned at f${memGoneG} want f11 (user tick 10 reconcile)`);
            else ctx.characterizations.push(`dead creep key removed at f${memGoneG} by the %10 SpawnController cleanup`);
        },
        liveCheck: TRIVIAL,
    },
    'eco-02-d2-notasks': {
        ports: [32448, 32449], scenario: 'ECO-02-D2-NOTASKS', maxSteps: 12, tree: 'dist2',
        creep: true, creepName: 'mule0', body: ['carry', 'carry', 'move'],
        d2: {
            creepMemory: { mule0: { role: 'mule' } },
            roleOnly: ['mule0'], directRole: { name: 'mule0', role: 'mule' }, doneT: 10,
        },
        expect: { collect: false, deliver: false, stateSeq: ['idle'] },
        oracle: oracleEco02d2,
        check: (ctx, bad) => {
            const lf = lastFence(ctx);
            const dr = (lf.eco || {}).direct;
            if (!dr) bad.push('direct CAP result missing');
            else if (!(dr.ok === false && dr.n === 'TypeError')) {
                bad.push(`direct call result ${JSON.stringify(dr)} want {ok:false,n:'TypeError'}`);
            } else {
                ctx.characterizations.push(`DEFECT ECO-D3 reproduced: role.mule idle without collectTemplates -> TypeError each tick (${dr.m}) — roles.run swallows it to console only`);
            }
        },
        liveCheck: creepAliveCheck('mule0'),
    },
    // ---- ECO-03 upgrader -----------------------------------------------------
    'eco-03-d': {
        ports: [32450, 32451], scenario: 'ECO-03-D', maxSteps: 75, tree: 'dist',
        creep: true, creepName: 'upg1', body: ['work', 'carry', 'move'], workParts: 1,
        extra: [{ kind: 'pile', near: 'controller', range: 2, amount: 100 }],
        d: { creepMemory: { upg1: { role: 'upgrader', state: 'collect' } }, doneT: 68 },
        expect: { stateSeq: ['collect', 'upgrade'], fillSource: 'pile' },
        oracle: oracleEco03, evPost: evUpgrade,
        liveCheck: creepAliveCheck('upg1'),
    },
    'eco-03-d2': {
        ports: [32452, 32453], scenario: 'ECO-03-D2', maxSteps: 75, tree: 'dist2',
        creep: true, creepName: 'upg1', body: ['work', 'carry', 'move'], workParts: 1,
        extra: [{ kind: 'pile', near: 'controller', range: 2, amount: 100 }],
        d2: { creepMemory: { upg1: { role: 'upgrader' } }, doneT: 68 },
        expect: { stateSeq: ['collecting', 'upgrading'], fillSource: 'pile' },
        oracle: oracleEco03, evPost: evUpgrade,
        liveCheck: creepAliveCheck('upg1'),
    },
    'eco-03-d2-container': {
        ports: [32454, 32455], scenario: 'ECO-03-D2-CONTAINER', maxSteps: 75, tree: 'dist2',
        creep: true, creepName: 'upg1', body: ['work', 'carry', 'move'], workParts: 1,
        extra: [{ kind: 'container', near: 'creep', range: 3, amount: 50 }],
        d2: { creepMemory: { upg1: { role: 'upgrader' } }, doneT: 68 },
        expect: { stateSeq: ['collecting', 'upgrading'], fillSource: 'container', fillId: 'container0' },
        oracle: oracleEco03, evPost: evUpgrade,
        liveCheck: creepAliveCheck('upg1'),
    },
    'eco-03-d2-both': {
        ports: [32456, 32457], scenario: 'ECO-03-D2-BOTH', maxSteps: 75, tree: 'dist2',
        creep: true, creepName: 'upg1', body: ['work', 'carry', 'move'], workParts: 1,
        extra: [
            { kind: 'pile', near: 'controller', range: 2, amount: 100 },
            { kind: 'container', near: 'creep', range: 3, amount: 50 },
        ],
        d2: { creepMemory: { upg1: { role: 'upgrader' } }, doneT: 68 },
        expect: { stateSeq: ['collecting', 'upgrading'], fillSource: 'pile' },
        oracle: oracleEco03, evPost: evUpgrade,
        check: (ctx, bad) => {
            const fillG = ctx.evidence.fillG;
            if (fillG === null || fillG === undefined) { bad.push('no fill fence'); return; }
            const cont = ctx.extra.containers && ctx.extra.containers[0];
            const f = fenceAt(ctx, fillG);
            const cb = f.cont.find(x => x.id === (cont && cont.id));
            if (!cb) bad.push('container missing at fill fence');
            else if (cb.e !== 50) bad.push(`container drained to ${cb.e} at fill fence — ground pile was not preferred`);
            else ctx.characterizations.push('dropped-energy pile preferred over container (container untouched at fill fence)');
        },
        liveCheck: creepAliveCheck('upg1'),
    },
    'eco-03-d-nopile': {
        ports: [32458, 32459], scenario: 'ECO-03-D-NOPILE', maxSteps: 12, tree: 'dist',
        creep: true, creepName: 'upg1', body: ['work', 'carry', 'move'], workParts: 1,
        d: { creepMemory: { upg1: { role: 'upgrader', state: 'collect' } }, doneT: 10 },
        runFullBudget: true,
        expect: { stateSeq: ['collect'], fill: false, upgrade: false },
        oracle: oracleEco03,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            const c0 = creepAt(fs[1] || fs[0], 'upg1');
            for (const f of fs) {
                const c = creepAt(f, 'upg1');
                if (c && c0 && (c.x !== c0.x || c.y !== c0.y)) bad.push(`t${f.g}: upgrader moved without pile`);
            }
            ctx.characterizations.push('dist early-return: no pile within 5 of controller -> role returns before any move (production difference preserved)');
        },
        liveCheck: creepAliveCheck('upg1'),
    },
    'eco-03-d2-noenergy': {
        ports: [32440, 32441], scenario: 'ECO-03-D2-NOENERGY', maxSteps: 12, tree: 'dist2',
        creep: true, creepName: 'upg1', body: ['work', 'carry', 'move'], workParts: 1,
        d2: { creepMemory: { upg1: { role: 'upgrader' } }, doneT: 10 },
        runFullBudget: true,
        expect: { stateSeq: ['collecting'], fill: false, upgrade: false },
        oracle: oracleEco03,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            const c0 = creepAt(fs[1] || fs[0], 'upg1');
            for (const f of fs) {
                const c = creepAt(f, 'upg1');
                if (c && c0 && (c.x !== c0.x || c.y !== c0.y)) bad.push(`t${f.g}: upgrader moved with no energy source`);
            }
        },
        liveCheck: creepAliveCheck('upg1'),
    },
    'eco-03-d2-nocontroller': {
        ports: [32442, 32443], scenario: 'ECO-03-D2-NOCONTROLLER', maxSteps: 75, tree: 'dist2',
        creep: true, creepName: 'upg1', body: ['work', 'carry', 'move'], workParts: 1,
        extra: [{ kind: 'pile', near: 'controller', range: 2, amount: 100 }],
        d2: { creepMemory: { upg1: { role: 'upgrader' } }, doneT: 68 },
        beforeStep: { 1: 'unclaim' },
        runFullBudget: true,
        expect: { stateSeq: ['collecting', 'upgrading'], fillSource: 'pile', upgrade: false },
        oracle: oracleEco03,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            const last = lastFence(ctx);
            if (last.ctrl && last.ctrl.prog !== 0) bad.push(`progress ${last.ctrl.prog} grew on unowned controller`);
            const c = creepAt(last, 'upg1');
            if (c && c.e === 0) bad.push('store drained on unowned controller');
            const upActs = fs.some(f => { const cc = creepAt(f, 'upg1'); return cc && cc.act && cc.act.upgradeController; });
            ctx.characterizations.push(`unowned controller: progress flat, store retained, upgradeController actionLog observed=${upActs}`);
        },
        liveCheck: creepAliveCheck('upg1'),
    },
    'eco-03-d2-spawning': {
        ports: [32444, 32445], scenario: 'ECO-03-D2-SPAWNING', maxSteps: 10, tree: 'dist2',
        creep: true, creepName: 'upg1', body: ['work', 'carry', 'move'], workParts: 1,
        extra: [{ kind: 'pile', near: 'controller', range: 2, amount: 50 }],
        d2: { creepMemory: { upg1: { role: 'upgrader' } }, doneT: 8 },
        beforeStep: { 1: 'setSpawning' },
        runFullBudget: true,
        expect: { fill: false, upgrade: false },
        oracle: oracleEco03,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            const c0 = creepAt(fs[1] || fs[0], 'upg1');
            for (const f of fs) {
                const c = creepAt(f, 'upg1');
                if (c && c0 && (c.x !== c0.x || c.y !== c0.y)) bad.push(`t${f.g}: spawning upgrader moved`);
                if (c && c.e !== 0) bad.push(`t${f.g}: spawning upgrader gained energy`);
            }
        },
        liveCheck: TRIVIAL,
    },
};

// ---------------------------------------------------------------------------
// Entrypoint cfg plumbing
// ---------------------------------------------------------------------------
function buildModules(def, fx, ctx0) {
    if (!def.creep && !def.d && !def.d2) return controlEntrypoint();
    const epCtx = { s1: ctx0.s1, s2: ctx0.s2, room: ctx0.room };
    const fill = (obj) => {
        for (const k of Object.keys(obj || {})) {
            if (obj[k] === '__S1__') obj[k] = ctx0.s1;
            else if (obj[k] === '__SRCM__') obj[k] = `${ctx0.room}_SrcM${ctx0.s1Pos.x}.${ctx0.s1Pos.y}`;
            else if (obj[k] === '__STRM__') obj[k] = `${ctx0.room}_StrM`;
        }
    };
    if (def.tree === 'dist') {
        const cfg = JSON.parse(JSON.stringify(def.d || {}));
        if (cfg.muleSrc) {
            cfg.creepMemory = cfg.creepMemory || {};
            cfg.creepMemory[def.creepName || 'mule0'] = {
                role: 'mule',
                src: cfg.muleSrc === 'StrM' ? `${ctx0.room}_StrM` : `${ctx0.room}_SrcM${ctx0.s1Pos.x}.${ctx0.s1Pos.y}`,
                state: 'collect', efficiency: 2,
            };
            delete cfg.muleSrc;
        }
        for (const mem of Object.values(cfg.creepMemory || {})) fill(mem);
        return dEntrypoint(epCtx, cfg);
    }
    const cfg = JSON.parse(JSON.stringify(def.d2 || {}));
    for (const n of def.probMem || []) delete (cfg.creepMemory || {})[n];
    for (const mem of Object.values(cfg.creepMemory || {})) fill(mem);
    if (cfg.copyOrderMemory) {
        for (const k of Object.keys(cfg.copyOrderMemory)) {
            cfg.copyOrderMemory[k] = `${cfg.copyOrderFrom}_${ctx0.s1}`;
        }
    }
    delete cfg.copyOrderFrom;
    return d2Entrypoint(epCtx, cfg);
}

// ---------------------------------------------------------------------------
// beforeStep interpreter (journaled injections)
// ---------------------------------------------------------------------------
function makeBeforeStep(def) {
    if (!def.beforeStep && !def.memCond && !def.memInject) return undefined;
    return async (i, { h, ctx, journal }) => {
        if (i === 1 && def.memInject) await memInject(h, ctx, journal, def);
        const act = def.beforeStep && def.beforeStep[i];
        if (act) {
            if (act.startsWith('spawnEnergy:')) {
                const n = Number(act.split(':')[1]);
                await h.dbUpdate('rooms.objects', { _id: ctx.spawnId }, { store: { energy: n } });
                journal.add('env', ctx.spawnId, 'update', { 'store.energy': n, injected: true });
            } else if (act === 'source0') {
                await h.dbUpdate('rooms.objects', { _id: ctx.s1 }, { energy: 0, ticksToRegeneration: 400 });
                journal.add('env', ctx.s1, 'update', { energy: 0, ticksToRegeneration: 400, injected: true });
            } else if (act === 'setSpawning') {
                // A bare spawning:true flag is engine-invalid: the processor
                // deletes spawning creeps not claimed by a spawn (SPN-D4
                // mechanism). Bind it via spawn.spawning with a far-future
                // spawnTime so the spawn never completes inside the budget.
                const gt = Number(JSON.parse((await h.eval('storage.env.get("gameTime")', 10000)) || '0'));
                const bind = { name: ctx.creepName, needTime: 1000, spawnTime: gt + 1000 };
                // Engine rule (creeps/tick.js): a spawning creep must sit ON
                // the spawn cell and the spawn's spawning.name must match it —
                // otherwise the row is removed / instantly born.
                await h.dbUpdate('rooms.objects', { _id: ctx.creepId },
                    { spawning: true, x: ctx.spawnPos.x, y: ctx.spawnPos.y });
                journal.add('env', ctx.creepId, 'update', { spawning: true, at: ctx.spawnPos, injected: true });
                await h.dbUpdate('rooms.objects', { _id: ctx.spawnId }, { spawning: bind });
                journal.add('env', ctx.spawnId, 'update', { spawning: bind, injected: true });
            } else if (act === 'unclaim') {
                await h.dbUpdate('rooms.objects', { _id: ctx.ctrlId }, { user: null, level: 0 });
                journal.add('env', ctx.ctrlId, 'update', { user: null, level: 0, injected: true });
            }
        }
        if (def.memCond) {
            const raw = await h.eval(`storage.env.get(${JSON.stringify('memory:' + ctx.userId)})`, 10000);
            const mem = JSON.parse(raw || '{}');
            const dest = mem.creeps && mem.creeps[ctx.creepName] && mem.creeps[ctx.creepName].destination;
            const mc = def.memCond;
            const hit =
                (mc.when === 'destIsExt' && dest && dest.type === 'structure' && ctx.extra.extensions && dest.id === ctx.extra.extensions[0].id) ||
                (mc.when === 'destIsStructure' && dest && dest.type === 'structure');
            if (hit && !ctx.memCondFired) {
                ctx.memCondFired = true;
                if (mc.act === 'delExt') {
                    await h.eval(`storage.db['rooms.objects'].removeWhere({_id:${JSON.stringify(ctx.extra.extensions[0].id)}})`, 15000);
                    journal.add('env', ctx.extra.extensions[0].id, 'delete', { injected: true, cond: mc.when });
                } else if (mc.act === 'delDestObj') {
                    await h.eval(`storage.db['rooms.objects'].removeWhere({_id:${JSON.stringify(dest.id)}})`, 15000);
                    journal.add('env', dest.id, 'delete', { injected: true, cond: mc.when });
                } else if (mc.act === 'delCreep') {
                    await h.eval(`storage.db['rooms.objects'].removeWhere({_id:${JSON.stringify(ctx.creepId)}})`, 15000);
                    journal.add('env', ctx.creepId, 'delete', { injected: true, cond: mc.when });
                }
            }
        }
    };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
    const def = MODES[MODE];
    if (!def) {
        console.error(`unknown mode '${MODE}' — expected one of: ${Object.keys(MODES).join(', ')}`);
        process.exitCode = 64;
        return;
    }
    const [httpPort, cliPort] = [HTTP_PORT || def.ports[0], CLI_PORT || def.ports[1]];
    const runId = `${MODE.replace(/-/g, '')}-${Date.now()}-${process.pid}`;
    const spec = def.refuse ? impossibleFixture() : fixtureF0();
    spec.expectCreep = !!def.creep;
    if (def.body) spec.creep.body = def.body;
    if (def.creepName) spec.creep.name = def.creepName;

    const res = await runScenario({
        runId, scenarioId: def.scenario, seedId,
        ports: { http: httpPort, cli: cliPort },
        fixtureSpec: spec,
        expectBlocked: def.refuse || undefined,
        runFullBudget: def.runFullBudget || undefined,
        budgets: { maxSteps: MAX_STEPS || def.maxSteps, WcaseMs: def.wcase || WCASE_MS },
        arrange: async (h, fx, journal) => {
            const ctx0 = {
                s1: fx.actual.source1.id, s2: fx.actual.source2.id, room: fx.room,
                s1Pos: { x: fx.actual.source1.x, y: fx.actual.source1.y },
                s2Pos: { x: fx.actual.source2.x, y: fx.actual.source2.y },
                ctrlPos: { x: fx.actual.controller.x, y: fx.actual.controller.y },
                ctrlId: fx.actual.controller.id,
                spawnPos: { x: fx.actual.spawn.x, y: fx.actual.spawn.y },
                source1Initial: fx.actual.source1.energy,
                source2Initial: fx.actual.source2.energy,
            };
            const { modules, hashes } = buildModules(def, fx, ctx0);
            const ctx = await arrangeBase(h, fx, journal, MODE, {
                modules, withCreep: spec.expectCreep, extra: def.extra,
            });
            Object.assign(ctx, ctx0);
            ctx.moduleHashes = hashes;
            ctx.workParts = def.workParts || 0;
            ctx.variant = def.variant;
            ctx.expectPileDrop = !!def.expectPileDrop;
            ctx.expectFullDrop = !!def.expectFullDrop;
            ctx.expect = Object.assign({}, def.expect);
            // resolve pos/id placeholders in expect
            if (ctx.expect.destPos === 'pile0' && ctx.extra.piles) ctx.expect.destPos = ctx.extra.piles[0];
            else if (ctx.expect.destPos === 'source1') ctx.expect.destPos = ctx.s1Pos;
            else if (ctx.expect.destPos === 'spawn') ctx.expect.destPos = ctx.spawnPos;
            if (ctx.expect.transferZone) {
                ctx.expect.transferZone = {
                    pos: ctx.expect.transferZone.pos === 'spawn' ? ctx.spawnPos : ctx.ctrlPos,
                    range: ctx.expect.transferZone.range,
                };
            }
            if (ctx.expect.deliverZone) {
                ctx.expect.deliverZone = {
                    pos: ctx.expect.deliverZone.pos === 'controller' ? ctx.ctrlPos : ctx.spawnPos,
                    range: ctx.expect.deliverZone.range,
                };
            }
            for (const key of ['dstName']) {
                if (typeof ctx.expect[key] === 'string' && ctx.expect[key].startsWith('_')) {
                    ctx.expect[key] = `${fx.room}${ctx.expect[key]}`;
                }
            }
            if (ctx.expect.transfer === 'extension') ctx.expect.transferId = ctx.extra.extensions && ctx.extra.extensions[0].id;
            if (ctx.expect.deliverId === 'upg1') ctx.expect.deliverId = ctx.extra.creeps && ctx.extra.creeps[0].id;
            if (ctx.expect.collectId === 'container0') ctx.expect.collectId = ctx.extra.containers && ctx.extra.containers[0].id;
            if (ctx.expect.fillId === 'container0') ctx.expect.fillId = ctx.extra.containers && ctx.extra.containers[0].id;
            if (ctx.expect.deliverIds) {
                for (const [k, v] of Object.entries(ctx.expect.deliverIds)) {
                    if (v === 'extension0') ctx.expect.deliverIds[k] = ctx.extra.extensions && ctx.extra.extensions[0].id;
                    else if (v === 'container0') ctx.expect.deliverIds[k] = ctx.extra.containers && ctx.extra.containers[0].id;
                    else if (v === 'spawn') ctx.expect.deliverIds[k] = 'spawn'; // resolved by fence pos
                }
            }
            ctx.pileIds = (ctx.extra.piles || []).map(p => p.id);
            if (!ctx.expect.pileIds) ctx.expect.pileIds = ctx.pileIds;
            const sp = await h.eval(`storage.db['rooms.objects'].findOne({$and:[{room:${JSON.stringify(fx.room)}},{type:'spawn'}]})`, 15000);
            ctx.spawnId = sp && sp._id;
            journal.add('env', 'spawn-id', 'measure', { spawnId: ctx.spawnId });
            return ctx;
        },
        supplemental,
        beforeStep: makeBeforeStep(def),
        perTickCheck: (rec, prev, ctx) => {
            const bad = [];
            const mem = rec.memory && rec.memory[ctx.userId];
            if (mem && mem.eco && mem.eco.err) bad.push(`entrypoint threw: ${mem.eco.err}`);
            if (Array.isArray(rec.errors) && rec.errors.length) bad.push(`${rec.errors.length} user error notifications`);
            if (rec.gameTime !== null) collectObs(rec, ctx);
            if (def.liveCheck) bad.push(...def.liveCheck(rec, prev, ctx));
            const eco = mem && mem.eco;
            const postHit = def.evPost && def.evPost(rec, ctx);
            // Evaluate the oracle on the done fence / postcondition hit, or at
            // the final budget frame for full-window modes with no done flag
            // (controls never set Memory.eco.done).
            const framesSeen = Object.keys(ctx.obs || {}).length;
            const lastFrame = framesSeen >= (MAX_STEPS || def.maxSteps);
            if (!ctx.oracleEvaluated && ((eco && eco.done) || postHit || lastFrame)) {
                ctx.oracleEvaluated = true;
                ctx.oracleResult = (def.oracle ? def.oracle(ctx) : []) || [];
                if (def.check) def.check(ctx, ctx.oracleResult);
                for (const b of ctx.oracleResult) bad.push(`oracle: ${b}`);
            }
            return bad;
        },
        postcondition: (rec, ctx) => {
            const mem = rec.memory && rec.memory[ctx.userId];
            return !!(mem && mem.eco && mem.eco.done) || !!(def.evPost && def.evPost(rec, ctx));
        },
    });

    try {
        fs.writeFileSync(path.join(res.runDir, 'oracle.json'), JSON.stringify({
            mode: MODE, runId, verdict: res.verdict, verdictReason: res.verdictReason,
            oracleFailures: res.ctx && res.ctx.oracleResult || null,
            characterizations: res.ctx && res.ctx.characterizations || [],
            evidence: res.ctx && res.ctx.evidence || null,
            accounting: res.ctx && res.ctx.accounting || null,
            regenEvents: res.ctx && res.ctx.regenEvents || null,
        }, null, 2), { mode: 0o600 });
        fs.writeFileSync(path.join(res.runDir, 'budgets.json'), JSON.stringify({
            mode: MODE, maxSteps: MAX_STEPS || def.maxSteps, WCASE_MS, ...res.stats,
        }, null, 2), { mode: 0o600 });
    } catch {}
    process.exitCode = VERDICT_EXIT[res.verdict] !== undefined ? VERDICT_EXIT[res.verdict] : 3;
}

main().catch(e => { console.error(e); process.exitCode = 3; });
