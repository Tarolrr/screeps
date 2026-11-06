'use strict';
// BLD suite — construction patterns / lifecycle / builder+repairer / target
// selection scenarios for GitHub issue #11, on top of the HAR harness.
//
// Mode-per-scenario runner. Each mode provisions a disposable F0 world, uploads
// the REAL production modules verbatim (SHA-256 per frame) plus a test `main`
// that drives real public methods on real Game objects, steps the world under
// the exclusive step gate, collects a compact per-fence projection in ctx.obs,
// and evaluates the recorded evidence against the oracle probe-side.
//
// Modes (ports 32460-32479):
//   bld-01-d2         dist2 constructionPatterns: all 8 registry patterns,
//                     index/direction/filled/terrain/name variants, path vs
//                     engine findPath, patternPlacer terrain string vs object
//   bld-02-d-rcl1     dist ConstructionManager (dormant) direct drive, RCL1
//   bld-02-d-rcl2     same at RCL2 (extensions path)
//   bld-02-d2         dist2 isolated BuildController+SpawnController+rm chain
//   bld-02-d2-main    dist2 UNPATCHED main.js, full budget to %100 reconcile
//   bld-03-d          dist role.builder + role.repairer (build+repair+thresholds)
//   bld-03-d-notarget same, no site / no eligible targets
//   bld-03-d-noenergy same inputs, no energy anywhere
//   bld-03-d2         dist2 ConstructionOrder lifecycle: apply->claim->sites->
//                     create codes->unblock retry->updateSpec->validate->delete
//   bld-04-d2         dist2 role.builder target selection/loss with real orders
//
// Usage: node e2e/bld/bld.js --mode bld-01-d2 [--http-port P --cli-port P]
//                            [--max-steps N] [--wcase-ms N]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runScenario, VERDICT_EXIT } = require('../har/harness');
const { fixtureF0 } = require('../har/fixture');
const E = require('./entrypoints');

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

// Arrange the F0 base: test user + modules + controller RCL + optional creep.
async function arrangeBase(h, fx, journal, label, { modules, withCreep, cpu = 100 }) {
    const username = `bld_${label}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    const userId = await h.createUser({
        username, modules, roomName: fx.room, cpu, spawn: true, spawnPos: fx.actual.spawn,
    });
    journal.add('user', userId, 'create', { username, cpu, modules: Object.keys(modules), spawnPos: fx.actual.spawn });
    await h.dbUpdate('rooms.objects', { $and: [{ room: fx.room }, { type: 'controller' }] }, { level: fx.spec.rcl });
    journal.add('controller', fx.actual.controller.id, 'update', { level: fx.spec.rcl });
    const ctx = { userId, room: fx.room };
    if (withCreep) {
        const inserted = await h.insertCreep({
            userId, room: fx.room, x: fx.actual.creep.x, y: fx.actual.creep.y,
            name: fx.spec.creep.name, parts: fx.spec.creep.body,
            store: fx.spec.creep.store || {}, capacity: 50, age: 1500,
        });
        ctx.creepId = inserted && inserted._id;
        ctx.creepName = fx.spec.creep.name;
        journal.add('creep', ctx.creepId || fx.spec.creep.name, 'create',
            { x: fx.actual.creep.x, y: fx.actual.creep.y, body: fx.spec.creep.body });
    }
    return ctx;
}

// One live world-state read for arrangement geometry (terrain + objects + gt).
async function roomState(h, room) {
    return h.eval(`(function(){
        return Promise.all([
            storage.db['rooms.terrain'].findOne({room:${JSON.stringify(room)}}),
            storage.db['rooms.objects'].find({room:${JSON.stringify(room)}}),
            storage.env.get('gameTime')
        ]).then(function(r){ return { terrain: r[0].terrain, objects: r[1], gameTime: Number(r[2]) }; });
    })()`, 20000);
}

// Free walkable cells sorted by chebyshev distance from `anchor`, plains first.
// `blockedExtra` = "x,y" keys the caller already consumed this arrangement.
function cellsByDistance(state, anchor, { minD = 0, maxD = 50, blockedExtra = [] } = {}) {
    const busy = new Set(state.objects.map(o => o.x + ',' + o.y));
    for (const k of blockedExtra) busy.add(k);
    const out = [];
    for (let y = 1; y < 49; y++) for (let x = 1; x < 49; x++) {
        const c = state.terrain.charAt(y * 50 + x);
        if (c === '1' || c === '3') continue;
        if (busy.has(x + ',' + y)) continue;
        const d = Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y));
        if (d < minD || d > maxD) continue;
        out.push({ x, y, d, swamp: c === '2' });
    }
    out.sort((a, b) => (a.d - b.d) || (a.swamp - b.swamp) || (a.x - b.x) || (a.y - b.y));
    return out;
}
function key(p) { return p.x + ',' + p.y; }
function wallCells(state) {
    const out = [];
    for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) {
        const c = state.terrain.charAt(y * 50 + x);
        if (c === '1' || c === '3') out.push({ x, y });
    }
    return out;
}
function edgeFreeCell(state) {
    const busy = new Set(state.objects.map(o => o.x + ',' + o.y));
    let best = null;
    for (let y = 1; y < 49; y++) for (let x = 1; x < 49; x++) {
        const c = state.terrain.charAt(y * 50 + x);
        if (c === '1' || c === '3' || busy.has(x + ',' + y)) continue;
        const edge = Math.min(x, 49 - x, y, 49 - y);
        if (!best || edge < best.edge) best = { x, y, edge };
    }
    return best;
}

async function insertObj(h, journal, room, obj, kind, label) {
    const doc = await h.dbInsert('rooms.objects', obj);
    journal.add(kind, (doc && doc._id) || obj.type + '@' + obj.x + ',' + obj.y, 'create',
        Object.assign({ x: obj.x, y: obj.y }, label));
    return doc;
}
const siteRow = (room, uid, pos, st, progress, progressTotal, name) =>
    ({ type: 'constructionSite', room, x: pos.x, y: pos.y, name: name || `site_${pos.x}_${pos.y}`,
        user: uid, structureType: st, progress, progressTotal, notifyWhenAttacked: false });
const roadRow = (room, pos, hits, gt) =>
    ({ type: 'road', room, x: pos.x, y: pos.y, hits, hitsMax: 5000,
        notifyWhenAttacked: false, decayTime: gt + 1000 });
const wallRow = (room, pos, hits, gt) =>
    ({ type: 'constructedWall', room, x: pos.x, y: pos.y, hits, hitsMax: 300000000,
        notifyWhenAttacked: false, decayTime: gt + 1000 });
const extRow = (room, uid, pos) =>
    ({ type: 'extension', room, x: pos.x, y: pos.y, user: uid,
        store: { energy: 50 }, storeCapacityResource: { energy: 50 },
        hits: 1000, hitsMax: 1000, notifyWhenAttacked: false });
const pileRow = (room, pos, energy) =>
    ({ type: 'energy', room, x: pos.x, y: pos.y, energy });

async function seedMemory(h, journal, userId, mem) {
    const raw = JSON.stringify(mem);
    await h.eval(`storage.env.set(${JSON.stringify('memory:' + userId)}, ${JSON.stringify(raw)})`, 15000);
    journal.add('env', 'memory:' + userId, 'seed', { bytes: raw.length });
}

// ---------------------------------------------------------------------------
// Per-fence observation collection (kept in ctx.obs; the trace file carries
// the full object projection — obs is the compact working set for oracles).
// ---------------------------------------------------------------------------

function memOf(rec, ctx) { return (rec.memory && rec.memory[ctx.userId]) || {}; }

function collectFrame(rec, ctx) {
    ctx.obs = ctx.obs || [];
    const mem = memOf(rec, ctx);
    const cm = mem.creeps || {};
    const creeps = (rec.creeps || []).map(c => ({
        n: c.name, x: c.x, y: c.y,
        e: (c.store && c.store.energy) || 0, sp: !!c.spawning, f: c.fatigue || 0,
        role: cm[c.name] && cm[c.name].role, st: cm[c.name] && cm[c.name].state,
        tgt: cm[c.name] && cm[c.name].targetSiteId,
        ab: !!(c.actionLog && c.actionLog.build),
        ar: !!(c.actionLog && c.actionLog.repair),
        ap: !!(c.actionLog && c.actionLog.pickup),
    }));
    // NB: structureType is not part of the object projection — site identity
    // is tracked by id/position instead.
    const sites = (rec.sites || []).map(s => ({
        id: s.id, x: s.x, y: s.y, p: s.progress, pt: s.progressTotal,
    }));
    const structs = (rec.objects || [])
        .filter(o => ['road', 'extension', 'constructedWall', 'container'].includes(o.type))
        .map(o => ({ id: o.id, t: o.type, x: o.x, y: o.y, h: o.hits, hm: o.hitsMax, u: !!o.user }));
    const drops = (rec.drops || []).filter(d => d.type === 'energy')
        .map(d => ({ id: d.id, x: d.x, y: d.y, e: d.energy !== undefined ? d.energy : d.amount }));
    const rmr = (mem.resourceManager && mem.resourceManager.resources) || {};
    const orders = Object.keys(rmr.constructionOrder || {}).map(id => {
        const o = rmr.constructionOrder[id];
        return { id, st: o.structureType, pri: o.priority, cnt: o.count,
            npos: Array.isArray(o.positions) ? o.positions.length : -1,
            own: (o.ownedStructureIds || []).length,
            wt: !!o.hasWrongTypeStructures, wp: !!o.hasWrongPositionStructures,
            hasCsites: 'constructionSites' in o };
    });
    const corders = Object.keys(rmr.creepOrder || {}).map(id => {
        const o = rmr.creepOrder[id];
        return { id, role: o.role, pri: o.priority, st: o.status, cn: o.creepName || null };
    });
    const spawnProcs = Object.keys(rmr.spawnProcess || {}).length;
    const spawnBusy = (rec.objects || []).some(o => o.type === 'spawn' && o.spawning);
    ctx.obs.push({ gt: rec.gameTime, creeps, sites, structs, drops, orders, corders,
        spawnProcs, spawnBusy, bld: mem.bld });
}

function commonTickCheck(rec, ctx) {
    const bad = [];
    const mem = memOf(rec, ctx);
    if (mem.bld && mem.bld.err) bad.push(`entrypoint threw: ${mem.bld.err}`);
    if (Array.isArray(rec.errors) && rec.errors.length) bad.push(`${rec.errors.length} user error notifications`);
    return bad;
}

// Oracle evaluation wiring: fires once when Memory.bld.done shows up, or on
// the final step for runFullBudget modes (evalStep). collectFrame runs on
// every frame first so the oracle sees the full ctx.obs series.
function makeCheck(oracle, { evalStep = null } = {}) {
    return (rec, prev, ctx) => {
        const bad = commonTickCheck(rec, ctx);
        if (rec.gameTime !== null) collectFrame(rec, ctx);
        if (!ctx.oracleEvaluated) {
            const bld = memOf(rec, ctx).bld;
            const fire = (bld && bld.done) || (evalStep !== null && rec.stepIndex === evalStep);
            if (fire) {
                ctx.oracleEvaluated = true;
                ctx.oracleResult = oracle(bld, ctx, rec) || [];
                for (const b of ctx.oracleResult) bad.push(`oracle: ${b}`);
            }
        }
        return bad;
    };
}
const donePostcondition = (rec, ctx) => !!(memOf(rec, ctx).bld && memOf(rec, ctx).bld.done);

function capErr(c) { return c && !c.ok ? `${c.n}: ${c.m}` : JSON.stringify(c); }
function char(ctx, s) { (ctx.characterizations = ctx.characterizations || []).push(s); }
function defect(ctx, id, s) { (ctx.defects = ctx.defects || []).push({ id, detail: s }); }
function pairsToSet(p) { const s = new Set(); for (let i = 0; i + 1 < p.length; i += 2) s.add(p[i] + ',' + p[i + 1]); return s; }

// ---------------------------------------------------------------------------
// Oracles — assert the observed evidence matches the contract. Where the
// contract documents a production defect, the oracle asserts the defect
// signature AND emits a defect record + characterization (RED evidence), so a
// masked or silently-fixed defect surfaces as an oracle failure, not as PASS.
// ---------------------------------------------------------------------------

// Expected geometry (mirrors the pattern contract; startPos-anchored X/line/
// ring/rect/parallelLines offsets are symmetric about their centroid).
function expectedCells(kind, sp) {
    const out = [];
    const push = (dx, dy) => out.push([sp.x + dx, sp.y + dy]);
    if (kind === 'cb') { push(-1, -1); push(-1, 1); push(0, 0); push(1, -1); push(1, 1); }
    if (kind === 'line') { push(-1, 0); push(0, 0); push(1, 0); }
    if (kind === 'ring') { push(-1, -1); push(0, -1); push(1, -1); push(-1, 0); push(1, 0); push(-1, 1); push(0, 1); push(1, 1); }
    if (kind === 'rect') { push(-1, -1); push(0, -1); push(1, -1); push(-1, 0); push(0, 0); push(1, 0); }
    if (kind === 'pll') { for (const y of [-2, -1, 1, 2]) for (const x of [-1, 0, 1]) push(x, y); }
    return out.map(p => p[0] + ',' + p[1]);
}

function oracleBld01(bld, ctx) {
    const bad = [];
    const r = (bld && bld.r) || {};
    const sp = ctx.spawn;
    const terrain = ctx.terrain;
    const at = (x, y) => terrain.charAt(y * 50 + x);
    const walkable = (x, y) => x >= 0 && x <= 49 && y >= 0 && y <= 49 && at(x, y) !== '1' && at(x, y) !== '3';
    const eqSet = (name, e, want) => {
        if (!e || e.e) { bad.push(`${name}: threw ${JSON.stringify(e && e.e)}`); return; }
        const got = pairsToSet(e.p || []);
        const w = new Set(want);
        const missing = [...w].filter(k => !got.has(k));
        const extra = [...got].filter(k => !w.has(k));
        if (missing.length || extra.length) bad.push(`${name}: missing=${missing.join(';')} extra=${extra.join(';')}`);
    };
    const inBounds = (name, e) => {
        if (!e || !e.p) return;
        for (let i = 0; i + 1 < e.p.length; i += 2) {
            if (e.p[i] < 0 || e.p[i] > 49 || e.p[i + 1] < 0 || e.p[i + 1] > 49) { bad.push(`${name}: out-of-bounds cell ${e.p[i]},${e.p[i + 1]}`); return; }
        }
    };
    const noDup = (name, e) => {
        if (!e || !e.p) return;
        if (pairsToSet(e.p).size !== e.p.length / 2) bad.push(`${name}: duplicate cells in positions`);
    };

    if (r.single0 && r.single0.p && r.single0.p.length === 2 &&
        r.single0.p[0] === sp.x && r.single0.p[1] === sp.y) {
        char(ctx, `single idx0 -> [${sp.x},${sp.y}]`);
    } else bad.push(`single0: ${JSON.stringify(r.single0)}`);
    if (r.single_oob && r.single_oob.o === 1 && (!r.single_oob.p || !r.single_oob.p.length)) {
        char(ctx, 'single idx1 -> oob empty');
    } else bad.push(`single_oob: ${JSON.stringify(r.single_oob)}`);
    if (r.single_edge && r.single_edge.p) char(ctx, `single@edge -> [${r.single_edge.p}] (recorded bounds)`);
    else bad.push(`single_edge: ${JSON.stringify(r.single_edge)}`);

    eqSet('cb_all(size3)', r.cb_all, expectedCells('cb', sp));
    // Indexed getPositions re-centers every subset onto startPos, so ANY valid
    // index of a multi-cell pattern returns the anchor cell — evidenced by
    // cb_i0 == cb_i4 == [startPos]. Distinct indices cannot address distinct
    // cells; per-index site placement degenerates. Recorded as a defect, and
    // the check fails if the behavior silently changes.
    if (r.cb_i0 && r.cb_i4 && r.cb_i0.p && r.cb_i4.p &&
        JSON.stringify(r.cb_i0.p) === JSON.stringify([sp.x, sp.y]) &&
        JSON.stringify(r.cb_i4.p) === JSON.stringify([sp.x, sp.y])) {
        char(ctx, 'checkboard idx0 == idx4 == [startPos] (indexed results re-center onto the anchor)');
        defect(ctx, 'BLD-PAT-IDX', 'getPositions re-centers each indexed subset via offsetPositions — every valid index of a multi-cell pattern returns the same startPos cell; index-based addressing cannot select distinct cells');
    } else bad.push(`cb_i0/cb_i4 unexpected: i0=${JSON.stringify(r.cb_i0)} i4=${JSON.stringify(r.cb_i4)}`);
    if (r.cb_oob && r.cb_oob.o === 1) char(ctx, 'checkboard idx5 oob (size3 has 5 cells)');
    else bad.push(`cb_oob: ${JSON.stringify(r.cb_oob)}`);

    eqSet('line_all(size3)', r.line_all, expectedCells('line', sp));
    // direction is accepted by the production signature but ignored by the
    // implementation — the contract requires this recorded as a defect.
    if (r.line_r && r.line_b && r.line_all &&
        JSON.stringify(r.line_r.p) === JSON.stringify(r.line_b.p) &&
        JSON.stringify(r.line_b.p) === JSON.stringify(r.line_all.p)) {
        char(ctx, 'line direction={RIGHT(1),BOTTOM(5),default} -> identical positions');
        defect(ctx, 'BLD-PAT-DIR', 'LinePattern accepts `direction` but ignores it: direction RIGHT/BOTTOM/default produce identical output');
    } else {
        char(ctx, `line direction variants differ (r=${JSON.stringify(r.line_r && r.line_r.p)} b=${JSON.stringify(r.line_b && r.line_b.p)})`);
    }
    if (r.line_oob && r.line_oob.o === 1 && (!r.line_oob.p || !r.line_oob.p.length)) {
        char(ctx, 'line idx3 oob (size3 has 3 cells)');
    } else bad.push(`line_oob: ${JSON.stringify(r.line_oob)}`);
    // index -1: no position produced but outOfBounds stays false — recorded.
    if (r.line_neg) {
        if (r.line_neg.o === 0 && (!r.line_neg.p || !r.line_neg.p.length)) {
            char(ctx, 'line idx-1 -> {positions:[], outOfBounds:false} (empty-but-not-oob)');
        } else char(ctx, `line idx-1 -> ${JSON.stringify(r.line_neg)}`);
    }

    eqSet('ring(radius3)', r.ring_all, expectedCells('ring', sp));
    if (r.ring_oob && r.ring_oob.o === 1) char(ctx, 'ring idx8 oob (r1 ring has 8 cells)');
    else bad.push(`ring_oob: ${JSON.stringify(r.ring_oob)}`);

    eqSet('rect(3x2,hollow)', r.rect_h, expectedCells('rect', sp));
    // `filled` is accepted but ignored — contract records this as a defect.
    if (r.rect_f && r.rect_h && JSON.stringify(r.rect_f.p) === JSON.stringify(r.rect_h.p)) {
        char(ctx, 'rectangle filled=true produces identical positions to filled=false');
        defect(ctx, 'BLD-PAT-FILL', 'RectanglePattern accepts `filled` but ignores it: filled=true/false produce identical output');
    } else {
        char(ctx, `rect filled differs: h=${JSON.stringify(r.rect_h && r.rect_h.p)} f=${JSON.stringify(r.rect_f && r.rect_f.p)}`);
    }
    if (r.rect_oob && r.rect_oob.o === 1) char(ctx, 'rect idx6 oob (3x2 has 6 cells)');
    else bad.push(`rect_oob: ${JSON.stringify(r.rect_oob)}`);

    eqSet('pll(size3)', r.pll_all, expectedCells('pll', sp));
    if (r.pll_oob && r.pll_oob.o === 1) char(ctx, 'parallelLines idx12 oob (size3 has 12 cells)');
    else bad.push(`pll_oob: ${JSON.stringify(r.pll_oob)}`);

    // path — engine findPath evidence.
    const w1 = r.pathW1 && r.pathW1.v;
    if (w1 && w1.e) bad.push(`path flat enumeration threw at idx ${w1.e.i}: ${w1.e.n}: ${w1.e.m}`);
    else if (w1) {
        const L = w1.n;
        char(ctx, `path flat width1: ${L} cells, outOfBounds at index ${w1.oob}, enum cpu=${r.pathW1.c}`);
        ctx.budgetFacts = ctx.budgetFacts || {};
        ctx.budgetFacts.pathLen = L; ctx.budgetFacts.pathEnumCpu = r.pathW1.c;
        if (L === 0) bad.push('path flat enumeration found no path (findPath empty or unreachable)');
        if (w1.oob !== L) bad.push(`path width1 outOfBounds boundary: got idx ${w1.oob}, want ${L}`);
        if (L > 0) {
            // every returned cell walkable + adjacent + reachability of `to`.
            for (let i = 0; i + 1 < w1.seq.length; i += 2) {
                if (!walkable(w1.seq[i], w1.seq[i + 1])) bad.push(`path cell ${w1.seq[i]},${w1.seq[i + 1]} is wall`);
                if (i >= 2 && Math.max(Math.abs(w1.seq[i] - w1.seq[i - 2]), Math.abs(w1.seq[i + 1] - w1.seq[i - 1])) > 1) {
                    bad.push(`path discontinuity ${w1.seq[i - 2]},${w1.seq[i - 1]} -> ${w1.seq[i]},${w1.seq[i + 1]}`);
                }
            }
            const lx = w1.seq[w1.seq.length - 2], ly = w1.seq[w1.seq.length - 1];
            if (Math.max(Math.abs(lx - ctx.pathTo.x), Math.abs(ly - ctx.pathTo.y)) > 1) {
                bad.push(`path last cell ${lx},${ly} not within range 1 of target ${ctx.pathTo.x},${ctx.pathTo.y}`);
            }
        }
    } else bad.push('path flat enumeration missing');
    if (r.pathW2_last && r.pathW2_last.o === 0 && r.pathW2_last.p && r.pathW2_last.p.length === 2 &&
        walkable(r.pathW2_last.p[0], r.pathW2_last.p[1])) {
        char(ctx, `path width2 last valid index ${(w1 && 2 * w1.n - 1)} -> [${r.pathW2_last.p}]`);
    } else bad.push(`pathW2_last: ${JSON.stringify(r.pathW2_last)}`);
    if (r.pathW2_oob && r.pathW2_oob.o === 1) char(ctx, 'path width2 index 2L -> outOfBounds');
    else bad.push(`pathW2_oob: ${JSON.stringify(r.pathW2_oob)}`);
    if (r.path_big && r.path_big.o === 1) char(ctx, 'path idx1000 -> outOfBounds');
    else bad.push(`path_big: ${JSON.stringify(r.path_big)}`);

    const nest = r.pathNested && r.pathNested.v;
    if (nest && nest.e) char(ctx, `path nested-opts enumeration threw at idx ${nest.e.i}: ${nest.e.n}: ${nest.e.m}`);
    else if (nest && w1) {
        if (JSON.stringify(nest.seq) !== JSON.stringify(w1.seq)) {
            char(ctx, `path nested-opts differs from flat-opts (nested=${nest.n} cells vs flat=${w1.n}) — production drops params.opts; BuildController's spec shape takes the default-cost route`);
            defect(ctx, 'BLD-PAT-OPTS', "PathPattern destructures only flat pathOpts — `params.opts` (the shape BuildController actually sends) is silently dropped; nested-opts path differs from flat-opts path");
        } else {
            char(ctx, `path nested-opts == flat-opts on this fixture (${nest.n} cells) — defect masked for this geometry, recorded`);
        }
        ctx.budgetFacts.pathNestedCpu = r.pathNested.c;
    } else bad.push('path nested enumeration missing');
    if (r.path_noroom && r.path_noroom.e) {
        char(ctx, `path nonexistent room -> ${r.path_noroom.e.n}: ${r.path_noroom.e.m}`);
        defect(ctx, 'BLD-PAT-ROOMCHK', `PathPattern reads room.getTerrain() before the !room guard — unreachable room throws ${r.path_noroom.e.n} instead of {positions:[],outOfBounds:true}`);
    } else bad.push(`path_noroom did not throw: ${JSON.stringify(r.path_noroom)}`);
    if (r.path_wall) {
        if (r.path_wall.o === 1) char(ctx, 'path to wall cell -> outOfBounds (findPath could not reach)');
        else char(ctx, `path to wall cell -> positions=${JSON.stringify(r.path_wall.p)} oob=${r.path_wall.o}`);
    }
    if (r.path_def && r.path_def.p && r.path_def.p.length === 2) char(ctx, `path default-opts idx0 -> [${r.path_def.p}]`);

    // patternPlacer — terrain representation variants.
    for (const id of ['pl_str', 'pl_obj', 'pl_wall_str', 'pl_wall_obj', 'pl_i1', 'pl_i5']) {
        const e = r[id];
        if (e && e.p) {
            inBounds(id, e); noDup(id, e);
            const walls = [];
            for (let i = 0; i + 1 < e.p.length; i += 2) if (!walkable(e.p[i], e.p[i + 1])) walls.push(e.p[i] + ',' + e.p[i + 1]);
            if (id.endsWith('str') && walls.length) bad.push(`${id}: positions on walls: ${walls.join(';')}`);
            if (id === 'pl_wall_str' && walls.length) bad.push(`pl_wall_str returned wall cells: ${walls.join(';')}`);
        }
    }
    if (r.pl_wall_str && r.pl_wall_obj) {
        const a = JSON.stringify(r.pl_wall_str.p || []), b = JSON.stringify(r.pl_wall_obj.p || []);
        if (a !== b) {
            char(ctx, `patternPlacer@wall: string-terrain -> ${a}; object-terrain -> ${b}`);
            defect(ctx, 'BLD-PAT-TERRAIN', 'PatternPlacer/isValidPosition indexes terrain as a string — a RoomTerrain object yields undefined cells (walls invisible); BuildController passes room.getTerrain() so wall checks never fire');
        } else {
            char(ctx, `patternPlacer@wall identical for both terrain representations: ${a}`);
        }
    } else bad.push('patternPlacer wall cases missing');
    if (r.pl_str && r.pl_obj && JSON.stringify(r.pl_str.p) !== JSON.stringify(r.pl_obj.p)) {
        char(ctx, `patternPlacer@spawn line3 also differs: str=${JSON.stringify(r.pl_str.p)} obj=${JSON.stringify(r.pl_obj.p)}`);
    }
    if (r.pl_unknown && r.pl_unknown.e && r.pl_unknown.e.n === 'Error' && /Unknown pattern/.test(r.pl_unknown.e.m)) {
        char(ctx, `patternPlacer unknown pattern -> ${r.pl_unknown.e.m}`);
    } else bad.push(`pl_unknown: ${JSON.stringify(r.pl_unknown)}`);
    if (r.reg_unknown && r.reg_unknown.e) char(ctx, `registry missing name -> ${r.reg_unknown.e.n}: ${r.reg_unknown.e.m}`);
    else bad.push(`reg_unknown: ${JSON.stringify(r.reg_unknown)}`);
    if (r.reg_checkerboard && r.reg_checkerboard.e) {
        char(ctx, `registry 'checkerboard' (correct spelling) -> ${r.reg_checkerboard.e.n}: ${r.reg_checkerboard.e.m} — implemented name is 'checkboard'`);
        defect(ctx, 'BLD-PAT-NAME', "registry exposes 'checkboard' (misspelled); 'checkerboard' lookups fail");
    } else bad.push(`reg_checkerboard unexpectedly succeeded: ${JSON.stringify(r.reg_checkerboard)}`);
    return bad;
}

function oracleBld02D(bld, ctx) {
    const bad = [];
    if (!bld) { bad.push('no Memory.bld'); return bad; }
    const rcl = ctx.rcl;
    if (bld.fresh && bld.fresh.ok === false && bld.fresh.n === 'TypeError') {
        char(ctx, `fresh constructor -> ${bld.fresh.n}: ${bld.fresh.m}`);
        defect(ctx, 'BLD-CM-CTOR', `ConstructionManager fresh path throws ${bld.fresh.n} (${bld.fresh.m}) — this.controller is never assigned (Manager only sets room/parent)`);
    } else bad.push(`fresh ctor expected TypeError, got ${JSON.stringify(bld.fresh)}`);
    if (bld.load && bld.load.ok === true) char(ctx, 'seeded manager row -> load() path reached');
    else bad.push(`load ctor: ${JSON.stringify(bld.load)}`);
    if (bld.fields) {
        if (bld.fields.priIsArr === true) {
            char(ctx, 'load(): manager.priority is the queue ARRAY (load assigns queue to priority)');
            defect(ctx, 'BLD-CM-LOAD', 'load() overwrites this.priority with the saved queue array (line assigns Memory.managers[name].queue to priority)');
        } else bad.push(`load fields: priority type ${JSON.stringify(bld.fields)}`);
        if (bld.fields.qLen === -1) {
            char(ctx, 'load(): this.queue is undefined — load() restores priority/pos/creepOwner but never the queue');
            defect(ctx, 'BLD-CM-QUEUE', 'load() never assigns this.queue — the saved row carries `queue` but only priority/pos/creepOwner are restored; run() then throws on this.queue.filter');
        } else bad.push(`load fields: queue len ${bld.fields.qLen} (expected -1/undefined)`);
    }
    if (bld.qe) {
        if (rcl === 1) {
            // 0 extensions allowed at RCL1 -> the defect is masked by the
            // controller level; record that honestly.
            if (bld.qe.ok === true) {
                char(ctx, `queueExtension at RCL1 returned cleanly (0 allowed extensions -> findExtensionPos never reached; defect masked by RCL) cpu=${bld.qe.c}`);
                defect(ctx, 'BLD-CM-EXT', 'findExtensionPos ReferenceError is masked at RCL1 — queueExtension no-ops when the RCL extension cap is 0 (see bld-02-d-rcl2 for the live throw)');
            } else bad.push(`queueExtension at RCL1 threw: ${JSON.stringify(bld.qe)}`);
        } else if (bld.qe.ok === false) {
            char(ctx, `queueExtension at RCL${rcl} -> ${bld.qe.n}: ${bld.qe.m} (bounded cpu ${bld.qe.c})`);
            defect(ctx, 'BLD-CM-EXT', `queueExtension/findExtensionPos throws ${bld.qe.n}: ${bld.qe.m} — the ring-candidate object is block-scoped inside the inner loop, so the post-loop pos.x read is a ReferenceError; downstream bugs (pos.t typo for pos.y, inverted !lookFor(LOOK_STRUCTURES), single-candidate-per-ring testing) are all masked behind it`);
        } else bad.push(`queueExtension unexpectedly succeeded at RCL${rcl}`);
    } else bad.push('queueExtension result missing');
    if (bld.cn) {
        if (bld.cn.ok === false && /DeliveryManager|not defined/i.test(bld.cn.m || '')) {
            char(ctx, `creepNeeded -> ${bld.cn.n}: ${bld.cn.m}`);
            defect(ctx, 'BLD-CM-DEPS', `creepNeeded/availableEnergy references bare DeliveryManager (never imported): ${bld.cn.n}: ${bld.cn.m}`);
        } else bad.push(`creepNeeded: ${JSON.stringify(bld.cn)}`);
    } else bad.push('creepNeeded result missing');
    if (bld.run) {
        if (bld.run.ok === false) {
            char(ctx, `run() at RCL${rcl} -> ${bld.run.n}: ${bld.run.m} (cpu=${bld.run.c}) — run() dies on this.queue.filter before any construction logic; the RCL1/RCL2 extension path is unreachable behind it`);
            defect(ctx, 'BLD-CM-RUN', `run() throws ${bld.run.n}: ${bld.run.m} — this.queue is undefined because load() never restores it; all construction behavior behind run() is dead code`);
        } else bad.push(`run() at RCL${rcl} unexpectedly succeeded: ${JSON.stringify(bld.run)}`);
    } else bad.push('run result missing');
    if (bld.sv) {
        if (bld.sv.ok === false) char(ctx, `save -> ${bld.sv.n}: ${bld.sv.m} (energyNeeded getter also hits DeliveryManager)`);
        else bad.push(`save unexpectedly succeeded: ${JSON.stringify(bld.sv)}`);
    }
    return bad;
}

function oracleBld02D2(bld, ctx) {
    const bad = [];
    if (!bld || !bld.init || bld.init.ok !== true) { bad.push(`init: ${JSON.stringify(bld && bld.init)}`); return bad; }
    char(ctx, `buildController.initialize at t${bld.init.t}`);
    for (const t of [2, 4, 6]) {
        const h = bld['hcs' + t];
        if (!h) bad.push(`handleConstructionSites@${t} missing`);
        else if (!h.ok) bad.push(`handleConstructionSites@${t} threw ${h.n}: ${h.m}`);
    }
    // every fence: >=6 construction orders, ALL with empty positions, 0 sites.
    let sawOrders = 0, sitesEver = 0, maxT = 0;
    for (const o of ctx.obs || []) {
        maxT = Math.max(maxT, o.gt || 0);
        sitesEver += o.sites.length;
        const co = o.orders.filter(od => od.id.startsWith('extensions_') || od.id.startsWith('road_'));
        sawOrders = Math.max(sawOrders, co.length);
        for (const od of co) {
            if (od.npos !== 0) bad.push(`gt${o.gt}: order ${od.id} positions=${od.npos} (defect expected: 0)`);
        }
    }
    if (sawOrders >= 6) {
        char(ctx, `${sawOrders} construction orders queued (3 extensions, 2 road_source, 1 road_controller); ALL positions=[] every fence`);
        defect(ctx, 'BLD-D2-GENPOS', "resources.constructionOrder.generatePositions() always returns [] — `patterns[type]` indexes the module exports object {patterns:{...}} instead of a pattern map, so patternFunc is undefined and every order carries empty positions; BuildController.handleConstructionSites therefore creates 0 sites");
    } else bad.push(`construction orders present: ${sawOrders} < 6`);
    if (sitesEver === 0) char(ctx, `0 construction sites at every fence up to t${maxT} (consistent with empty positions)`);
    else bad.push(`${sitesEver} site observations — sites created despite empty positions`);
    if (bld.sites !== 0) bad.push(`final siteCount ${bld.sites}`);
    if (bld.born) char(ctx, `builder creep born at t${bld.born} via real creepOrder->spawnProcess->spawnCreep chain`);
    else bad.push('builder never born — spawn chain did not complete inside budget');
    const lastObs = (ctx.obs || []).slice(-1)[0] || {};
    const co = (lastObs.corders || []).find(c => c.id === 'builder_' + ctx.room);
    if (co && co.st === 'active') char(ctx, `builder order status: ${co.st} (pending->spawning->active chain observed)`);
    else bad.push(`builder order status: ${co && co.st}`);
    if (bld.sp && Object.keys(bld.sp).length) bad.push(`spawnController errors: ${JSON.stringify(bld.sp)}`);
    if (bld.rec && Object.keys(bld.rec).length) bad.push(`reconcile errors: ${JSON.stringify(bld.rec)}`);
    return bad;
}

function oracleBld02D2Main(bld, ctx) {
    const bad = [];
    const obs = ctx.obs || [];
    let sitesEver = 0, coCount = new Set(), sawReconcile = false;
    // reconcile fires on absolute Game.time%100 — derive the next boundary
    // from the first observed engine tick rather than assuming gt starts at 1.
    const firstGt = (obs[0] && obs[0].gt) || 1;
    const reconT = Math.ceil(firstGt / 100) * 100 || 100;
    for (const o of obs) {
        sitesEver += o.sites.length;
        for (const od of o.orders) {
            if (!(od.id.startsWith('extensions_') || od.id.startsWith('road_'))) continue;
            coCount.add(od.id);
            if (od.npos !== 0) bad.push(`gt${o.gt}: order ${od.id} positions=${od.npos}`);
        }
        if (o.gt > reconT && o.sites.length === 0) sawReconcile = true;
    }
    if (coCount.size >= 6) {
        char(ctx, `raw main: ${coCount.size} construction orders applied at init; positions=[] at every fence`);
        defect(ctx, 'BLD-D2-GENPOS', 'raw main reproduces empty-positions defect: all construction orders carry positions=[] from initialize() through the %100 reconcile; handleConstructionSites creates 0 sites');
    } else bad.push(`raw main construction orders: ${coCount.size}`);
    if (sitesEver === 0) char(ctx, `0 construction sites across ${obs.length} fences incl. the %100 reconcile`);
    else bad.push(`${sitesEver} site observations in raw main`);
    if (sawReconcile) char(ctx, `fences after the %100 reconcile (gt>${reconT}) observed: still 0 sites`);
    else if (reconT > firstGt + obs.length) char(ctx, `no %100 reconcile inside budget (start gt${firstGt}, next at ${reconT}) — reconcile coverage absent`);
    else bad.push('no post-%100 fence observed');
    const bornCreeps = new Set();
    let builderSt = null;
    for (const o of obs) {
        for (const c of o.creeps) bornCreeps.add(c.n);
        const co = (o.corders || []).find(c => c.id === 'builder_' + ctx.room);
        if (co) builderSt = co.st;
    }
    if (bornCreeps.size >= 1) char(ctx, `${bornCreeps.size} creeps born via real order chain (spawn pipeline healthy)`);
    else bad.push('no creeps born inside budget');
    char(ctx, `builder order status at end: ${builderSt}`);
    const coStable = obs.every(o => o.orders.filter(od => od.id.startsWith('extensions_') || od.id.startsWith('road_')).length === coCount.size);
    if (coStable) char(ctx, 'construction order count stable across %100 re-apply (annotation match -> no duplicates)');
    else char(ctx, 'construction order count changed across fences (recorded)');
    return bad;
}

function oracleBld03D(bld, ctx) {
    const bad = [];
    const obs = ctx.obs || [];
    if (bld && bld.errs && Object.keys(bld.errs).length) {
        bad.push(`role.run threw: ${JSON.stringify(bld.errs).slice(0, 200)}`);
    }
    const siteId = ctx.siteId;
    let trips = 0, built = false, repGrew = false, repMax = 0;
    let prevSite = null, prevB = null, prevRep = null;
    let totalPickup = 0, totalSpent = 0;
    const ineligible = {};
    if (ctx.thrId) ineligible[ctx.thrId] = 4000;
    if (ctx.w2Id) ineligible[ctx.w2Id] = 300500;
    for (const o of obs) {
        const site = o.sites.find(s => s.id === siteId);
        const b = o.creeps.find(c => c.n === 'b1');
        const rep = o.structs.find(s => s.id === ctx.repId);
        if (site) {
            if (site.pt !== 300) bad.push(`gt${o.gt}: site progressTotal=${site.pt} (engine fact expected 300)`);
            if (prevSite && site.p < prevSite.p) bad.push(`gt${o.gt}: site progress decreased ${prevSite.p} -> ${site.p}`);
            if (prevSite && site.p - prevSite.p > 5) bad.push(`gt${o.gt}: progress +${site.p - prevSite.p} > BUILD_POWER*WORK (5)`);
            if (site.p > site.pt) bad.push(`gt${o.gt}: progress ${site.p} > progressTotal`);
            prevSite = site;
        } else if (prevSite && !built) {
            // Site gone — legitimate only when it completed: a road must now
            // stand at sitePos (the fence at p=300 already shows no site).
            const rd = o.structs.some(s => s.t === 'road' && s.x === ctx.sitePos.x && s.y === ctx.sitePos.y);
            if (!rd && prevSite.p < 300) {
                bad.push(`gt${o.gt}: site disappeared at progress ${prevSite.p} < 300 without a structure`);
            }
        }
        if (!site && !built) {
            built = o.structs.some(s => s.t === 'road' && s.x === ctx.sitePos.x && s.y === ctx.sitePos.y);
            if (built) char(ctx, `gt${o.gt}: site converted to real road structure at ${ctx.sitePos.x},${ctx.sitePos.y}`);
        }
        if (b && prevB) {
            const de = b.e - prevB.e;
            if (de > 0) totalPickup += de;
            if (de < 0 && b.ab) totalSpent -= de;
            if (b.st === 'build' && prevB.st !== 'build') trips++;
            // actionLog.build persists a tick after the last applied build —
            // only range-check when energy actually decreased (real build).
            if (b.ab && de < 0 && site && Math.max(Math.abs(b.x - site.x), Math.abs(b.y - site.y)) > 3) {
                bad.push(`gt${o.gt}: build applied out of range`);
            }
        }
        if (b) prevB = b;
        if (rep) {
            if (prevRep && rep.h > prevRep.h) {
                repGrew = true;
                const dh = rep.h - prevRep.h;
                repMax = Math.max(repMax, dh);
                if (dh > 100) bad.push(`gt${o.gt}: repair +${dh} > REPAIR_POWER*WORK (100)`);
            }
            prevRep = rep;
        }
        for (const [id, want] of Object.entries(ineligible)) {
            const s = o.structs.find(x => x.id === id);
            // Only hits GROWTH is repair evidence on an ineligible structure;
            // a drop is natural decay (roads/walls decay), recorded once.
            if (s && s.h > want) bad.push(`gt${o.gt}: ineligible target ${id} hits ${s.h} > ${want} (repairer grew threshold-failing structure)`);
            else if (s && s.h < want && !ctx._decayNoted) {
                ctx._decayNoted = {};
                char(ctx, `gt${o.gt}: ineligible ${id} decayed ${want} -> ${s.h} (natural decay, not repairer touch)`);
            }
        }
    }
    if (trips >= 3) char(ctx, `builder made ${trips} collect->build transitions (several real trips)`);
    else bad.push(`builder trips ${trips} < 3`);
    if (built) char(ctx, 'site->structure conversion observed');
    else bad.push('site never converted to structure inside budget');
    if (repGrew) char(ctx, `eligible repair target grew hits (max +${repMax}/tick, REPAIR_POWER bound 100)`);
    else bad.push('repairer never grew any eligible target hits');
    char(ctx, `energy: total picked up ~${totalPickup}, spent on build ~${totalSpent}`);
    return bad;
}

function oracleBld03Neg(bld, ctx, variant) {
    const bad = [];
    const obs = ctx.obs || [];
    if (bld && bld.errs && Object.keys(bld.errs).length) {
        bad.push(`role.run threw: ${JSON.stringify(bld.errs).slice(0, 200)}`);
    }
    let buildActions = 0, repairActions = 0, maxB = -1, maxR = -1;
    for (const o of obs) {
        for (const c of o.creeps) {
            if (c.ab) buildActions++;
            if (c.ar) repairActions++;
            if (c.n === 'b1') maxB = Math.max(maxB, c.e);
            if (c.n === 'r1') maxR = Math.max(maxR, c.e);
        }
    }
    if (variant === 'notarget') {
        if (buildActions !== 0) bad.push(`build intents on absent site: ${buildActions}`);
        if (repairActions !== 0) bad.push(`repair intents on ineligible targets: ${repairActions}`);
        if (maxB !== 50 || maxR !== 50) bad.push(`creeps failed to fill stores from pile (b1=${maxB}, r1=${maxR})`);
        else char(ctx, 'creeps filled stores (50) then held: builder stuck in build state, repairer in repair state, zero build/repair intents');
        const last = obs.slice(-1)[0] || {};
        if ((last.sites || []).length) bad.push('site object appeared despite absent-target invariant');
    } else {
        if (buildActions !== 0) bad.push(`build intents with no energy: ${buildActions}`);
        if (repairActions !== 0) bad.push(`repair intents with no energy: ${repairActions}`);
        if (maxB !== 0 || maxR !== 0) bad.push(`creeps gained energy from nowhere (b1=${maxB}, r1=${maxR})`);
        else char(ctx, 'no energy anywhere: creeps stayed at store 0 in collect state, zero intents');
        const last = obs.slice(-1)[0] || {};
        const site = (last.sites || []).find(s => s.id === ctx.siteId);
        if (site && site.p !== ctx.siteProgress) bad.push(`site progress moved ${ctx.siteProgress} -> ${site.p} with no energy`);
        else char(ctx, `site progress flat at ${ctx.siteProgress} throughout`);
    }
    return bad;
}

function oracleBld03D2(bld, ctx) {
    const bad = [];
    if (!bld) { bad.push('no Memory.bld'); return bad; }
    const eq = (name, got, want) => { if (got !== want) bad.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
    eq('applyA id', bld.apA && bld.apA.v, 'bldA');
    eq('applyB id', bld.apB && bld.apB.v, 'bldL');
    if (bld.claim && bld.claim.ok) char(ctx, 'claimStructures returned');
    else bad.push(`claim threw ${bld.claim && capErr(bld.claim)}`);
    eq('owned after claim', JSON.stringify(bld.owned), JSON.stringify([ctx.extId]));
    char(ctx, `claim: only the compatible extension was claimed; wall/cells ignored`);
    // create codes — recorded as primary evidence.
    if (bld.genB && bld.genB.ok === true && bld.genB.v === 6) {
        char(ctx, 'generateConstructionSitePositions(6) on the road order returned all 6 free positions');
    } else bad.push(`genB: ${JSON.stringify(bld.genB)}`);
    if (Array.isArray(bld.createB)) {
        const okN = bld.createB.filter(c => c === 0).length;
        const errN = bld.createB.filter(c => c !== 0).length;
        if (okN === 6 && errN === 0) char(ctx, `createB road codes ${JSON.stringify(bld.createB)} — all 6 site creates OK (roads unlimited at RCL2)`);
        else bad.push(`createB road codes: ${JSON.stringify(bld.createB)} (${okN} OK, ${errN} errors)`);
    } else bad.push('createB missing');
    // RCL-limit evidence: tower requires RCL3 -> non-OK code at RCL2.
    if (bld.rcl && bld.rcl.ok === true && bld.rcl.v !== 0 && bld.rcl.v !== null) {
        char(ctx, `createConstructionSite(tower) at RCL2 -> ${bld.rcl.v} (RCL limit rejects the site type)`);
    } else bad.push(`RCL-limit probe: ${JSON.stringify(bld.rcl)}`);
    const genAv = bld.genA && bld.genA.ok === true ? bld.genA.v : null;
    if (Array.isArray(genAv)) {
        const s = pairsToSet(genAv);
        const want = new Set([ctx.wallPos, ctx.posA[2], ctx.posA[3]].map(key));
        const missing = [...want].filter(k => !s.has(k));
        const extra = [...s].filter(k => !want.has(k));
        if (missing.length || extra.length) bad.push(`genA positions mismatch: missing=${missing} extra=${extra} (owned-struct exclusion evidence)`);
        else char(ctx, 'generateConstructionSitePositions excluded the owned-structure cell');
    } else bad.push(`genA: ${JSON.stringify(bld.genA)}`);
    if (Array.isArray(bld.createA) && bld.createA.length === 3) {
        const [w, p3, p4] = bld.createA;
        if (w === 0) bad.push(`create at wall cell returned OK (expected error)`);
        else char(ctx, `create at blocked (wall) cell -> ${JSON.stringify(w)}`);
        if (p3 !== 0 || p4 !== 0) bad.push(`create at free cells -> ${JSON.stringify([p3, p4])}`);
        else char(ctx, 'create at free cells -> OK sites created');
    } else bad.push(`createA: ${JSON.stringify(bld.createA)}`);
    if (Array.isArray(bld.retry) && bld.retry.length >= 1) {
        if (bld.retry[0] === 0) char(ctx, 'retry after controlled unblock -> OK site created at the freed cell');
        else bad.push(`retry after unblock -> ${JSON.stringify(bld.retry)}`);
    } else bad.push(`retry: ${JSON.stringify(bld.retry)}`);
    if (bld.upd) {
        eq('updateSpec re-apply id', bld.upd.v, 'bldA');
        if (bld.after) {
            if (bld.after.pos === 0) {
                char(ctx, 'updateSpec regenerated positions -> [] (same generatePositions defect) then removeExcessStructures destroyed owned structures');
                defect(ctx, 'BLD-D2-GENPOS', 'updateSpec->onSpecUpdate->generatePositions returns [] (patterns[type] lookup on module exports object) — every spec change drops all planned positions and destroys owned structures not in []');
            } else bad.push(`positions after spec change: ${bld.after.pos}`);
            if (bld.after.st !== 'road') bad.push(`structureType after update: ${bld.after.st}`);
            if (bld.after.cnt !== 1) bad.push(`count after update: ${bld.after.cnt}`);
        } else bad.push('after-update fields missing');
    }
    // fence evidence: ext@P1 destroyed after the updateSpec fence.
    const obs = ctx.obs || [];
    let extGone = false;
    for (const o of obs) {
        const ids = new Set(o.structs.map(s => s.id));
        if (ctx.extId && !ids.has(ctx.extId)) extGone = true;
    }
    if (extGone) char(ctx, 'owned extension destroyed by removeExcessStructures after wrong-position flag');
    else bad.push('owned extension never destroyed (removeExcessStructures did not act)');
    if (bld.val && bld.val.ok) char(ctx, 'validateOwnedStructures returned');
    else bad.push(`validate: ${bld.val && capErr(bld.val)}`);
    if (JSON.stringify(bld.owned6) === '[]') char(ctx, 'ownedStructureIds emptied by validate (dead id filtered)');
    else bad.push(`owned6: ${JSON.stringify(bld.owned6)}`);
    eq('deleteResource', bld.del, true);
    eq('order row gone', bld.row, false);
    return bad;
}

function oracleBld04D2(bld, ctx) {
    const bad = [];
    const obs = ctx.obs || [];
    if (!bld || !bld.init) { bad.push('no init'); return bad; }
    if (bld.lo && bld.lo.ok && bld.lo.v === 'bld_lo' && bld.hi && bld.hi.ok && bld.hi.v === 'bld_hi') {
        char(ctx, 'orders bld_lo(pri10,near) + bld_hi(pri90,far) applied via real resourceManager');
    } else bad.push(`order apply: lo=${JSON.stringify(bld.lo)} hi=${JSON.stringify(bld.hi)}`);
    // priority-map emptiness: constructionSites field absent on every order row.
    let csitesSeen = false;
    for (const o of obs) for (const od of o.orders) if (od.hasCsites) csitesSeen = true;
    if (!csitesSeen) {
        char(ctx, 'no constructionOrder ever carried a `constructionSites` field -> role priority map always empty');
        defect(ctx, 'BLD-D2-PRIO', 'role.builder.findHighestPrioritySite reads order.constructionSites — nothing ever sets it; sitePriorities is always {}, so ALL sites get priority 0 and selection degenerates to nearest-distance regardless of order priority');
    }
    const N = ctx.siteNId, F = ctx.siteFId;
    let firstTarget = null, afterRemove = null, sawIdle = false;
    const gone = new Set();
    for (const o of obs) {
        const c = o.creeps.find(x => x.n === 'b1');
        if (!c) continue;
        const present = new Set(o.sites.map(s => s.id));
        for (const id of [N, F]) if (id && !present.has(id)) gone.add(id);
        if (c.st === 'BUILDING') ctx._buildingSeen = true;
        if (firstTarget === null && c.tgt) firstTarget = c.tgt;
        if (gone.size === 1 && c.tgt && !gone.has(c.tgt) && afterRemove === null) {
            afterRemove = c.tgt;
        }
        if (gone.size === 2 && c.st === 'IDLE' && !c.tgt) sawIdle = true;
        // stale-id check: a target pointing at a removed site must be cleaned
        // the next BUILDING fence — handleBuildingState resolves it every tick.
        // While COLLECTING the role never validates the field, so a dead id
        // survives arbitrarily many fences: recorded as defect BLD-D2-STALE.
        if (c.tgt && !present.has(c.tgt)) {
            if (c.st === 'BUILDING') {
                bad.push(`gt${o.gt}: targetSiteId ${c.tgt} points at a removed site while BUILDING (stale id not cleaned)`);
            } else if (!ctx._staleCounted) {
                ctx._staleCounted = true;
                char(ctx, `gt${o.gt}: targetSiteId ${c.tgt} points at a removed site while state=${c.st}`);
                defect(ctx, 'BLD-D2-STALE', 'role.builder validates targetSiteId only in handleBuildingState — while COLLECTING a dead site id persists across fences (observed 18+ fences); cleanup happens only on the BUILDING path');
            }
        }
    }
    if (firstTarget === N) {
        char(ctx, `first target = near site ${N} (pri-10 order) NOT far site ${F} (pri-90 order)`);
        defect(ctx, 'BLD-D2-SELECT', 'builder selected the nearer low-priority site — order priorities never influence target choice (priority map empty)');
    } else if (firstTarget === F) {
        char(ctx, `first target = far/high-priority site ${F} (priority honored — unexpected)`);
    } else bad.push('builder never acquired a targetSiteId');
    if (afterRemove && [N, F].includes(afterRemove)) {
        char(ctx, `after controlled removal, remaining site ${afterRemove} re-selected`);
    } else if (gone.size >= 1 && ctx._buildingSeen) {
        bad.push(`no re-selection after first removal (afterRemove=${afterRemove})`);
    } else if (gone.size >= 1) {
        char(ctx, `re-selection unexercised: creep never reached BUILDING while a site remained (coverage gap, not a mechanics fail)`);
    }
    if (sawIdle) char(ctx, 'after both removals: state IDLE, targetSiteId cleared');
    else if (gone.size === 2 && ctx._buildingSeen) bad.push('builder never returned to IDLE with no sites');
    else if (gone.size === 2) char(ctx, 'IDLE-with-no-sites unexercised: BUILDING path never reached');
    return bad;
}

// ---------------------------------------------------------------------------
// Mode definitions
// ---------------------------------------------------------------------------

// Anchor cells that will be occupied by F0 objects once the user exists —
// placement helpers must never land an input object on them.
function anchorKeys(fx) {
    const out = [key(fx.actual.spawn), key(fx.actual.controller),
        key(fx.actual.source1), key(fx.actual.source2)];
    if (fx.actual.creep) out.push(key(fx.actual.creep));
    return out;
}

const MODES = {
    'bld-01-d2': {
        ports: [32460, 32461], scenario: 'BLD-01-D2', maxSteps: 7, creep: false, cpu: 300,
        build: (ctx) => E.bld01Entrypoint(ctx),
        oracle: oracleBld01,
        ctxFromFx: () => ({}),
        preBuild: async (h, fx, epCtx, journal) => {
            const st = await roomState(h, fx.room);
            const walls = wallCells(st).sort((a, b) =>
                (Math.max(Math.abs(a.x - fx.actual.spawn.x), Math.abs(a.y - fx.actual.spawn.y))) -
                (Math.max(Math.abs(b.x - fx.actual.spawn.x), Math.abs(b.y - fx.actual.spawn.y))));
            epCtx.wall = walls[0] || { x: 0, y: 0 };
            epCtx.edge = edgeFreeCell(st) || { x: 1, y: 1 };
            epCtx.spawn = { x: fx.actual.spawn.x, y: fx.actual.spawn.y };
            epCtx.pathFrom = epCtx.spawn;
            epCtx.pathTo = { x: fx.actual.source1.x, y: fx.actual.source1.y };
            epCtx.terrain = st.terrain;
            journal.add('env', 'bld01-geometry', 'measure', { wall: epCtx.wall, edge: epCtx.edge });
        },
    },
    'bld-02-d-rcl1': {
        ports: [32462, 32463], scenario: 'BLD-02-D', maxSteps: 4, creep: false, rcl: 1,
        build: (ctx) => E.bld02DEntrypoint(ctx),
        oracle: oracleBld02D,
        ctxFromFx: (fx) => ({ room: fx.room, ctrl: { x: fx.actual.controller.x, y: fx.actual.controller.y }, rcl: 1 }),
    },
    'bld-02-d-rcl2': {
        ports: [32464, 32465], scenario: 'BLD-02-D', maxSteps: 4, creep: false,
        build: (ctx) => E.bld02DEntrypoint(ctx),
        oracle: oracleBld02D,
        ctxFromFx: (fx) => ({ room: fx.room, ctrl: { x: fx.actual.controller.x, y: fx.actual.controller.y }, rcl: 2 }),
    },
    'bld-02-d2': {
        ports: [32466, 32467], scenario: 'BLD-02-D2', maxSteps: 30, creep: false,
        build: (ctx) => E.bld02D2Entrypoint(ctx),
        oracle: oracleBld02D2,
        ctxFromFx: (fx) => ({ room: fx.room, doneAt: 26 }),
    },
    'bld-02-d2-main': {
        ports: [32468, 32469], scenario: 'BLD-02-D2', maxSteps: 105, creep: false,
        build: () => E.bld02D2MainEntrypoint(),
        oracle: oracleBld02D2Main, evalStep: 105, runFullBudget: true, wcase: 600000,
        ctxFromFx: (fx) => ({ room: fx.room }),
    },
    'bld-03-d': {
        ports: [32470, 32471], scenario: 'BLD-03-D', maxSteps: 200, creep: true,
        creepName: 'b1', creepBody: ['work', 'carry', 'move'], wcase: 600000, seedMem: true,
        build: (ctx) => E.bld03DEntrypoint(ctx),
        oracle: oracleBld03D,
        ctxFromFx: () => ({}),
        preBuild: async (h, fx, epCtx, journal) => {
            const st = await roomState(h, fx.room);
            const used = anchorKeys(fx);
            const creepPos = fx.actual.creep, spawnPos = fx.actual.spawn;
            const siteCell = cellsByDistance(st, creepPos, { minD: 2, maxD: 3, blockedExtra: used })[0];
            used.push(key(siteCell));
            const piles = cellsByDistance(st, spawnPos, { minD: 2, maxD: 5, blockedExtra: used });
            const pile1 = piles[0]; used.push(key(pile1));
            const pile2 = piles[1]; used.push(key(pile2));
            const repCell = cellsByDistance(st, creepPos, { minD: 3, maxD: 5, blockedExtra: used })[0];
            used.push(key(repCell));
            // r1 must sit inside the spawn-anchored findInRange(5) the dist
            // repairer uses to reach the energy piles.
            const r1Cell = cellsByDistance(st, spawnPos, { minD: 1, maxD: 4, blockedExtra: used })[0];
            used.push(key(r1Cell));
            const far = cellsByDistance(st, repCell, { minD: 4, maxD: 8, blockedExtra: used });
            const thrCell = far[0]; used.push(key(thrCell));
            const w1Cell = far[1]; used.push(key(w1Cell));
            const w2Cell = far[2]; used.push(key(w2Cell));
            if (!siteCell || !pile1 || !pile2 || !repCell || !r1Cell || !thrCell || !w1Cell || !w2Cell) {
                throw new Error('fixture cannot supply required cells for bld-03-d');
            }
            Object.assign(epCtx, {
                sitePos: { x: siteCell.x, y: siteCell.y }, repPos: { x: repCell.x, y: repCell.y },
                repHits: 1000, doneAt: 195,
            });
            epCtx.plan = { siteCell, pile1, pile2, repCell, r1Cell, thrCell, w1Cell, w2Cell };
            journal.add('env', 'bld03d-plan', 'measure', epCtx.plan);
        },
        arrangeExtra: async (h, fx, ctx, journal) => {
            const st = await roomState(h, fx.room);
            const gt = st.gameTime, P = ctx.plan;
            const site = await insertObj(h, journal, fx.room,
                siteRow(fx.room, ctx.userId, P.siteCell, 'road', 150, 300, 'bld_site'), 'site', { structureType: 'road', progress: 150 });
            const p1 = await insertObj(h, journal, fx.room, pileRow(fx.room, P.pile1, 400), 'pile', { energy: 400 });
            const p2 = await insertObj(h, journal, fx.room, pileRow(fx.room, P.pile2, 400), 'pile', { energy: 400 });
            const rep = await insertObj(h, journal, fx.room, roadRow(fx.room, P.repCell, 1000, gt), 'structure', { t: 'road', hits: 1000 });
            const thr = await insertObj(h, journal, fx.room, roadRow(fx.room, P.thrCell, 4000, gt), 'structure', { t: 'road', hits: 4000, threshold: 'hitsMax-1000' });
            const w1 = await insertObj(h, journal, fx.room, wallRow(fx.room, P.w1Cell, 299500, gt), 'structure', { t: 'constructedWall', hits: 299500 });
            const w2 = await insertObj(h, journal, fx.room, wallRow(fx.room, P.w2Cell, 300500, gt), 'structure', { t: 'constructedWall', hits: 300500, threshold: 'hits>=300000' });
            const r1 = await h.insertCreep({ userId: ctx.userId, room: fx.room, x: P.r1Cell.x, y: P.r1Cell.y,
                name: 'r1', parts: ['work', 'carry', 'move'], store: {}, capacity: 50, age: 1500 });
            journal.add('creep', r1 && r1._id, 'create', { x: P.r1Cell.x, y: P.r1Cell.y, body: ['work', 'carry', 'move'], role: 'repairer' });
            await seedMemory(h, journal, ctx.userId, { creeps: {
                b1: { role: 'builder', state: 'collect' },
                r1: { role: 'repairer', state: 'collect' },
            } });
            ctx.siteId = site && site._id; ctx.siteProgress = 150;
            ctx.repId = rep && rep._id;
            ctx.thrId = thr && thr._id; ctx.w1Id = w1 && w1._id; ctx.w2Id = w2 && w2._id;
            ctx.pileIds = [p1 && p1._id, p2 && p2._id];
        },
    },
    'bld-03-d-notarget': {
        ports: [32472, 32473], scenario: 'BLD-03-D', maxSteps: 40, creep: true,
        creepName: 'b1', creepBody: ['work', 'carry', 'move'], seedMem: true,
        build: (ctx) => E.bld03DEntrypoint(ctx),
        oracle: (bld, ctx) => oracleBld03Neg(bld, ctx, 'notarget'),
        ctxFromFx: () => ({}),
        preBuild: async (h, fx, epCtx, journal) => {
            const st = await roomState(h, fx.room);
            const used = anchorKeys(fx);
            const creepPos = fx.actual.creep, spawnPos = fx.actual.spawn;
            const pile = cellsByDistance(st, spawnPos, { minD: 2, maxD: 5, blockedExtra: used })[0];
            used.push(key(pile));
            const r1Cell = cellsByDistance(st, spawnPos, { minD: 1, maxD: 4, blockedExtra: used })[0];
            used.push(key(r1Cell));
            const far = cellsByDistance(st, creepPos, { minD: 3, maxD: 8, blockedExtra: used });
            const thrCell = far[0]; used.push(key(thrCell));
            const w2Cell = far[1]; used.push(key(w2Cell));
            if (!pile || !thrCell || !w2Cell || !r1Cell) throw new Error('fixture cannot supply cells for bld-03-d-notarget');
            epCtx.doneAt = 35;
            epCtx.plan = { pile, thrCell, w2Cell, r1Cell };
            journal.add('env', 'bld03nt-plan', 'measure', epCtx.plan);
        },
        arrangeExtra: async (h, fx, ctx, journal) => {
            const st = await roomState(h, fx.room);
            const P = ctx.plan;
            await insertObj(h, journal, fx.room, pileRow(fx.room, P.pile, 400), 'pile', { energy: 400 });
            const thr = await insertObj(h, journal, fx.room, roadRow(fx.room, P.thrCell, 4000, st.gameTime), 'structure', { t: 'road', hits: 4000, threshold: 'hitsMax-1000' });
            const w2 = await insertObj(h, journal, fx.room, wallRow(fx.room, P.w2Cell, 300500, st.gameTime), 'structure', { t: 'constructedWall', hits: 300500, threshold: 'hits>=300000' });
            const r1 = await h.insertCreep({ userId: ctx.userId, room: fx.room, x: P.r1Cell.x, y: P.r1Cell.y,
                name: 'r1', parts: ['work', 'carry', 'move'], store: {}, capacity: 50, age: 1500 });
            journal.add('creep', r1 && r1._id, 'create', { x: P.r1Cell.x, y: P.r1Cell.y, role: 'repairer' });
            await seedMemory(h, journal, ctx.userId, { creeps: {
                b1: { role: 'builder', state: 'collect' },
                r1: { role: 'repairer', state: 'collect' },
            } });
            ctx.thrId = thr && thr._id; ctx.w2Id = w2 && w2._id;
        },
    },
    'bld-03-d-noenergy': {
        ports: [32474, 32475], scenario: 'BLD-03-D', maxSteps: 14, creep: true,
        creepName: 'b1', creepBody: ['work', 'carry', 'move'], seedMem: true,
        build: (ctx) => E.bld03DEntrypoint(ctx),
        oracle: (bld, ctx) => oracleBld03Neg(bld, ctx, 'noenergy'),
        ctxFromFx: () => ({}),
        preBuild: async (h, fx, epCtx, journal) => {
            const st = await roomState(h, fx.room);
            const used = anchorKeys(fx);
            const creepPos = fx.actual.creep, spawnPos = fx.actual.spawn;
            const siteCell = cellsByDistance(st, creepPos, { minD: 2, maxD: 3, blockedExtra: used })[0];
            used.push(key(siteCell));
            const repCell = cellsByDistance(st, creepPos, { minD: 3, maxD: 5, blockedExtra: used })[0];
            used.push(key(repCell));
            const r1Cell = cellsByDistance(st, spawnPos, { minD: 1, maxD: 4, blockedExtra: used })[0];
            used.push(key(r1Cell));
            if (!siteCell || !repCell || !r1Cell) throw new Error('fixture cannot supply cells for bld-03-d-noenergy');
            Object.assign(epCtx, { sitePos: { x: siteCell.x, y: siteCell.y }, repPos: { x: repCell.x, y: repCell.y }, repHits: 1000, doneAt: 10 });
            epCtx.plan = { siteCell, repCell, r1Cell };
            journal.add('env', 'bld03ne-plan', 'measure', epCtx.plan);
        },
        arrangeExtra: async (h, fx, ctx, journal) => {
            const st = await roomState(h, fx.room);
            const P = ctx.plan;
            const site = await insertObj(h, journal, fx.room,
                siteRow(fx.room, ctx.userId, P.siteCell, 'road', 100, 300, 'bld_site'), 'site', { structureType: 'road', progress: 100 });
            const rep = await insertObj(h, journal, fx.room, roadRow(fx.room, P.repCell, 1000, st.gameTime), 'structure', { t: 'road', hits: 1000 });
            const r1 = await h.insertCreep({ userId: ctx.userId, room: fx.room, x: P.r1Cell.x, y: P.r1Cell.y,
                name: 'r1', parts: ['work', 'carry', 'move'], store: {}, capacity: 50, age: 1500 });
            journal.add('creep', r1 && r1._id, 'create', { x: P.r1Cell.x, y: P.r1Cell.y, role: 'repairer' });
            await seedMemory(h, journal, ctx.userId, { creeps: {
                b1: { role: 'builder', state: 'collect' },
                r1: { role: 'repairer', state: 'collect' },
            } });
            ctx.siteId = site && site._id; ctx.siteProgress = 100; ctx.repId = rep && rep._id;
        },
    },
    'bld-03-d2': {
        ports: [32476, 32477], scenario: 'BLD-03-D2', maxSteps: 9, creep: false,
        build: (ctx) => E.bld03D2Entrypoint(ctx),
        oracle: oracleBld03D2,
        ctxFromFx: () => ({}),
        preBuild: async (h, fx, epCtx, journal) => {
            const st = await roomState(h, fx.room);
            const used = anchorKeys(fx);
            const spawnPos = fx.actual.spawn;
            const cells = cellsByDistance(st, spawnPos, { minD: 2, maxD: 5, blockedExtra: used });
            if (cells.length < 4) throw new Error(`fixture cannot supply posA cells (${cells.length})`);
            const posA = cells.slice(0, 4).map(p => ({ x: p.x, y: p.y }));
            for (const p of posA) used.push(key(p));
            const more = cellsByDistance(st, spawnPos, { minD: 2, maxD: 6, blockedExtra: used });
            if (more.length < 6) throw new Error(`fixture cannot supply posB cells (${more.length})`);
            const posB = more.slice(0, 6).map(p => ({ x: p.x, y: p.y }));
            epCtx.posA = posA; epCtx.posB = posB;
            epCtx.wallPos = posA[1];
            journal.add('env', 'bld03d2-positions', 'measure', { posA, posB });
        },
        arrangeExtra: async (h, fx, ctx, journal) => {
            const st = await roomState(h, fx.room);
            const ext = await insertObj(h, journal, fx.room, extRow(fx.room, ctx.userId, ctx.posA[0]), 'structure', { t: 'extension', input: 'compatible' });
            const wall = await insertObj(h, journal, fx.room, wallRow(fx.room, ctx.posA[1], 1000, st.gameTime), 'structure', { t: 'constructedWall', input: 'incompatible+blocker' });
            ctx.extId = ext && ext._id; ctx.wallId = wall && wall._id;
            ctx.inputObjectIds = [ctx.extId, ctx.wallId];
        },
        beforeStep: async (i, { h, ctx, journal }) => {
            if (i === 4 && ctx.wallId) {
                await h.dbRemove('rooms.objects', { _id: ctx.wallId });
                journal.add('structure', ctx.wallId, 'remove', { controlled: 'unblock for order retry' });
                ctx.wallId = null;
            }
        },
    },
    'bld-04-d2': {
        ports: [32478, 32479], scenario: 'BLD-04-D2', maxSteps: 60, creep: true,
        creepName: 'b1', creepBody: ['work', 'carry', 'move'], wcase: 300000, seedMem: true,
        build: (ctx) => E.bld04D2Entrypoint(ctx),
        oracle: oracleBld04D2,
        ctxFromFx: () => ({}),
        preBuild: async (h, fx, epCtx, journal) => {
            const st = await roomState(h, fx.room);
            const used = anchorKeys(fx);
            const creepPos = fx.actual.creep, spawnPos = fx.actual.spawn;
            const near = cellsByDistance(st, creepPos, { minD: 2, maxD: 3, blockedExtra: used })[0];
            used.push(key(near));
            const far = cellsByDistance(st, creepPos, { minD: 6, maxD: 10, blockedExtra: used })[0];
            used.push(key(far));
            const pileCell = cellsByDistance(st, spawnPos, { minD: 2, maxD: 5, blockedExtra: used })[0];
            used.push(key(pileCell));
            if (!near || !far || !pileCell) throw new Error('fixture cannot supply cells for bld-04-d2');
            epCtx.siteN = { x: near.x, y: near.y }; epCtx.siteF = { x: far.x, y: far.y };
            epCtx.doneAt = 55;
            epCtx.plan = { near, far, pileCell };
            journal.add('env', 'bld04-plan', 'measure', epCtx.plan);
        },
        arrangeExtra: async (h, fx, ctx, journal) => {
            const P = ctx.plan;
            const siteN = await insertObj(h, journal, fx.room,
                siteRow(fx.room, ctx.userId, P.near, 'road', 0, 300, 'bld_near'), 'site', { structureType: 'road', label: 'near+low-priority' });
            const siteF = await insertObj(h, journal, fx.room,
                siteRow(fx.room, ctx.userId, P.far, 'road', 0, 300, 'bld_far'), 'site', { structureType: 'road', label: 'far+high-priority' });
            await insertObj(h, journal, fx.room, pileRow(fx.room, P.pileCell, 400), 'pile', { energy: 400 });
            await seedMemory(h, journal, ctx.userId, { creeps: {
                b1: { role: 'builder',
                    collectTemplates: [{ type: 'area', entityType: 'ground',
                        pos: { x: fx.actual.spawn.x, y: fx.actual.spawn.y }, range: 5 }] },
            } });
            ctx.siteNId = siteN && siteN._id; ctx.siteFId = siteF && siteF._id;
        },
        beforeStep: async (i, { h, ctx, journal }) => {
            if (i === 10) {
                const last = (ctx.obs || []).slice(-1)[0];
                const tgt = last && last.creeps && last.creeps[0] && last.creeps[0].tgt;
                const id = tgt || ctx.siteNId;
                await h.dbRemove('rooms.objects', { _id: id });
                journal.add('site', id, 'remove', { controlled: 'remove selected site' });
            }
            // Second removal is state-triggered: wait until the creep reaches
            // BUILDING while a site is still alive, so the re-selection path is
            // actually exercised. A fixed step can land while the creep is
            // still COLLECTING (observed: swamp collect ran ~28 ticks, both
            // sites gone before the first BUILDING tick -> no evidence).
            if (i > 10 && !ctx._rm2) {
                const last = (ctx.obs || []).slice(-1)[0];
                const c = last && last.creeps && last.creeps[0];
                const have = new Set(((last && last.sites) || []).map(s => s.id));
                const rest = [ctx.siteNId, ctx.siteFId].filter(id => id && have.has(id));
                if (c && c.st === 'BUILDING' && rest.length) {
                    await h.dbRemove('rooms.objects', { _id: rest[0] });
                    journal.add('site', rest[0], 'remove', { controlled: 'remove remaining site on BUILDING entry' });
                    ctx._rm2 = true;
                }
            }
        },
    },
};

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
    const spec = fixtureF0();
    spec.expectCreep = def.creep !== false;
    if (def.rcl) spec.rcl = def.rcl;
    if (def.creepName) spec.creep.name = def.creepName;
    if (def.creepBody) spec.creep.body = def.creepBody;
    // modes that seed user Memory as a declared input waive the empty check
    if (def.seedMem) spec.memoryMustBeEmpty = false;

    const res = await runScenario({
        runId, scenarioId: def.scenario, seedId,
        ports: { http: httpPort, cli: cliPort },
        fixtureSpec: spec,
        budgets: { maxSteps: MAX_STEPS || def.maxSteps, WcaseMs: WCASE_MS || def.wcase || 300000 },
        arrange: async (h, fx, journal) => {
            // 1. geometry first (positions the entrypoint bakes in)
            const epCtx = Object.assign({ room: fx.room }, def.ctxFromFx(fx));
            if (def.preBuild) await def.preBuild(h, fx, epCtx, journal);
            // 2. module closure + main source
            const { modules, hashes } = def.build(epCtx);
            // 3. user + spawn + controller + optional fixture creep
            const ctx = await arrangeBase(h, fx, journal, MODE, {
                modules, withCreep: def.creep !== false, cpu: def.cpu || 100,
            });
            Object.assign(ctx, epCtx);
            ctx.moduleHashes = hashes;
            // 4. input objects / seeded Memory (need userId for owned rows)
            if (def.arrangeExtra) await def.arrangeExtra(h, fx, ctx, journal);
            return ctx;
        },
        supplemental,
        perTickCheck: makeCheck(def.oracle, { evalStep: def.evalStep || null }),
        postcondition: def.runFullBudget ? null : donePostcondition,
        runFullBudget: def.runFullBudget || false,
        beforeStep: def.beforeStep || null,
    });

    try {
        fs.writeFileSync(path.join(res.runDir, 'oracle.json'), JSON.stringify({
            mode: MODE, runId, verdict: res.verdict, verdictReason: res.verdictReason,
            oracleFailures: res.ctx && res.ctx.oracleResult || null,
            characterizations: res.ctx && res.ctx.characterizations || [],
            defects: res.ctx && res.ctx.defects || [],
            budgetFacts: res.ctx && res.ctx.budgetFacts || null,
        }, null, 2), { mode: 0o600 });
    } catch {}
    process.exitCode = VERDICT_EXIT[res.verdict] !== undefined ? VERDICT_EXIT[res.verdict] : 3;
}

main().catch(e => { console.error(e); process.exitCode = 3; });
