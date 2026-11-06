'use strict';
// SPN suite — spawn/ownership/recovery scenarios on top of the HAR harness.
//
// Mode-per-scenario runner. Each mode spins up a disposable F0 world, uploads
// the REAL production modules (verbatim, sha256 recorded per frame) plus a
// test `main` driving real public methods, steps the world under the
// exclusive gate, collects per-fence state from frame Memory + objects, and
// evaluates it against the oracle table probe-side.
//
// Scenarios:
//   SPN-01  plan+selection — order queue/spawn fence evidence, variants:
//           free/occupied spawn, energy 0 vs sufficient, two priorities,
//           name-already-exists, and (dist2) impossible-priority starvation.
//   SPN-02  ownership transition — real queue -> spawn -> name -> ID ->
//           source owner, runtime reload persistence.
//   SPN-03  recovery — API order during real spawn, dead/deleted creep,
//           missing spawn, spawning-without-process, expiry near T.
//
// Usage: node e2e/spn/spn.js --mode spn-01-d [--http-port 32400 --cli-port 32401]
//                            [--max-steps N] [--wcase-ms N]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runScenario, VERDICT_EXIT } = require('../har/harness');
const { fixtureF0 } = require('../har/fixture');
const { dEntrypoint, d2Entrypoint } = require('./entrypoints');

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
// dist2 utils.priority.js formula (offset 0): floor(parseInt(last6hex,16)*100)
const d2Priority = (id) => Math.floor(parseInt(String(id).slice(-6), 16) * 100);

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

async function arrangeBase(h, fx, journal, label, { modules, withCreep }) {
    const username = `spn_${label}_${process.pid}`;
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

// ---------------------------------------------------------------------------
// Per-fence observation collected from frame data (never stored in Memory).
// ---------------------------------------------------------------------------
function collectObs(rec, ctx) {
    ctx.obs = ctx.obs || {};
    const mem = (rec.memory || {})[ctx.userId] || null;
    const o = { se: null, sp: null, cr: [], mm: null, rm: null, cm: null, spn: null };
    const spawn = (rec.objects || []).find(x => x.type === 'spawn' && x.user === ctx.userId);
    if (spawn) {
        o.se = spawn.store ? spawn.store.energy : null;
        o.sp = spawn.spawning ? { n: spawn.spawning.name, nt: spawn.spawning.needTime, st: spawn.spawning.spawnTime } : null;
    }
    o.cr = (rec.creeps || []).map(c => ({
        id: c.id, n: c.name, sp: !!c.spawning, hits: c.hits,
        b: (c.body || []).map(x => x.type), x: c.x, y: c.y,
    }));
    if (mem) {
        o.spn = mem.spn || null;
        if (mem.managers) {
            o.mm = {};
            for (const [k, v] of Object.entries(mem.managers)) {
                o.mm[k] = {
                    c: v.creeps,
                    q: (v.creepsQueued || []).map(x => x && ({ n: x.name, c: x.cost, p: x.parts })),
                    queue: (v.queue || []).map(x => x && ({ n: x.name, c: x.cost, p: x.parts })),
                };
            }
        }
        if (mem.resourceManager && mem.resourceManager.resources) {
            o.rm = {};
            for (const [t, m] of Object.entries(mem.resourceManager.resources)) {
                o.rm[t] = Object.entries(m).map(([id, v]) => ({
                    id, st: v.status, cn: v.creepName, ex: v.expiryTime, pr: v.priority,
                    oid: v.orderId, sid: v.spawnId, src: v.sourceId,
                }));
            }
        }
        if (mem.creeps) {
            o.cm = {};
            for (const [n, v] of Object.entries(mem.creeps)) {
                o.cm[n] = { role: v.role, as: v.assignedSource, sid: v.sourceId, eff: v.efficiency };
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
function spawnEvents(ctx) {
    const ev = []; let prev = null;
    for (const f of fenceList(ctx)) {
        const cur = f.sp ? f.sp.n : null;
        if (cur !== prev && cur) ev.push({ g: f.g, name: cur, needTime: f.sp.nt, spawnTime: f.sp.st, se: f.se });
        prev = cur;
    }
    return ev;
}
function findCreepAnywhere(ctx, name) {
    for (const f of fenceList(ctx)) {
        const c = (f.cr || []).find(x => x.n === name);
        if (c) return c;
    }
    return null;
}
function creepAt(f, name) { return (f.cr || []).find(c => c.n === name) || null; }
function costOf(parts) { return (parts || []).reduce((s, p) => s + (BODYPART_COST[p] || 0), 0); }
function lastFence(ctx) { const fs = fenceList(ctx); return fs[fs.length - 1] || {}; }
function fenceAt(ctx, g) { return ctx.obs[g] || null; }
function mgrKey(o, frag) { return Object.keys(o.mm || {}).find(k => k.includes(frag)) || null; }

// Spawn energy conservation (calibrated against engine spn01d-1793663593552):
// the intent charge is applied by room/intents BEFORE the spawn's tick regen,
// so at a spawn-event fence the delta is -cost + 1 (regen always runs, since
// the post-charge store is < 300); at other fences delta = prev<300 ? +1 : 0.
function energyProblems(ctx) {
    const bad = [];
    const fs = fenceList(ctx);
    const evG = {};
    for (const e of spawnEvents(ctx)) evG[e.g] = e;
    for (let i = 1; i < fs.length; i++) {
        const p = fs[i - 1], c = fs[i];
        if (p.se === null || c.se === null || p.se === undefined || c.se === undefined) continue;
        const d = c.se - p.se;
        // injected energy writes (energy0/energyFull) are journaled world
        // writes, not engine deltas — the pair whose later frame first shows
        // the injection (beforeStep(i) lands in tick i -> frame i+1) is
        // skipped; deltas inside and after the window are still checked.
        const injected = ctx.skipEnergyDeltaG && ctx.skipEnergyDeltaG.has(c.g);
        const ev = evG[c.g];
        if (!injected && ev) {
            const cr = findCreepAnywhere(ctx, ev.name);
            const cost = costOf(cr && cr.b);
            if (!cost) { bad.push(`t${c.g}: spawn ${ev.name} has no body for cost check`); continue; }
            const want = -cost + 1;
            if (d !== want) bad.push(`t${c.g}: spawn.energy delta ${d} want ${want} (spawn ${ev.name} cost ${cost})`);
        } else if (!injected) {
            const want = p.se < 300 ? 1 : 0;
            if (d !== want) bad.push(`t${c.g}: spawn.energy delta ${d} want ${want} (regen model)`);
        }
        if (c.se < 0 || c.se > 300) bad.push(`t${c.g}: spawn.energy ${c.se} out of [0,300]`);
    }
    return bad;
}

// ---------------------------------------------------------------------------
// Mode oracle evaluation
// ---------------------------------------------------------------------------
function capErr(c) { return c && !c.ok ? `${c.n}: ${c.m}` : JSON.stringify(c); }

function oracleDistQueue(ctx) {
    // SPN-01 dist base/priority/occupied + SPN-02 dist shared chain checks.
    const bad = [];
    const fs = fenceList(ctx);
    const E = ctx.expectName;
    const ev = spawnEvents(ctx);
    ctx.characterizations = ctx.characterizations || [];

    // queue appearance
    let queueG = null, spawnG = null, bornG = null, promotedG = null;
    const OWN = ctx.ownerKey || '_SrcM';
    const spnK = k => Object.keys((ctx.obs[k] || {}).mm || {}).find(x => x.includes('_SpnM'));
    const srcK = k => Object.keys((ctx.obs[k] || {}).mm || {}).find(x => x.includes(OWN));
    for (const f of fs) {
        if (!f.mm) continue;
        const sk = spnK(f.g), mk = srcK(f.g);
        if (queueG === null && sk && f.mm[sk] && (f.mm[sk].queue || []).some(q => q.n === E)) queueG = f.g;
        if (spawnG === null && f.sp && f.sp.n === E) spawnG = f.g;
        if (promotedG === null && mk && f.mm[mk] && (f.mm[mk].c || []).includes(E)) promotedG = f.g;
        if (bornG === null) { const c = creepAt(f, E); if (c && !c.sp) bornG = f.g; }
    }
    ctx.evidence = Object.assign(ctx.evidence || {}, { queueG, spawnG, bornG, promotedG });

    if (queueG === null) { bad.push(`${E} never entered spawn queue`); return bad; }
    if (spawnG === null) { bad.push(`${E} never spawned`); return bad; }
    if (spawnG <= queueG) bad.push(`spawn fence ${spawnG} <= queue fence ${queueG}`);
    // queue entry content
    const qf = fenceList(ctx).find(f => { const sk = spnK(f.g); return sk && f.mm[sk].queue.some(q => q.n === E); });
    const qe = qf.mm[spnK(qf.g)].queue.find(q => q.n === E);
    ctx.evidence.queueEntry = qe;
    const wantBody = ctx.expectBody;
    if (wantBody && JSON.stringify(qe.p) !== JSON.stringify(wantBody)) {
        bad.push(`queued body ${JSON.stringify(qe.p)} want ${JSON.stringify(wantBody)}`);
    }
    if (ctx.expectCost !== undefined && qe.c !== ctx.expectCost) {
        bad.push(`queued cost ${qe.c} want ${ctx.expectCost}`);
    }
    // promotion into creeps[] no later than the spawn frame (Game.creeps holds
    // spawning creeps, so the same-tick creepOwner.run must bind it)
    if (promotedG === null) bad.push(`${E} never promoted into creepOwner.creeps`);
    else if (promotedG > spawnG) bad.push(`${E} promoted at ${promotedG} > spawn fence ${spawnG} (lost binding window)`);
    // no lost binding: name must live in queue|creepsQueued|creeps|objects at every fence
    for (const f of fs) {
        if (!f.mm || f.g < queueG) continue;
        const sk = spnK(f.g), mk = srcK(f.g);
        const inQ = sk && (f.mm[sk].queue || []).some(q => q.n === E);
        const inQQ = mk && (f.mm[mk].q || []).some(q => q.n === E);
        const inC = mk && (f.mm[mk].c || []).includes(E);
        const inObj = !!creepAt(f, E);
        const dead = ctx.expectDeath && bornG !== null && f.g > bornG && !inObj;
        if (!dead && !inQ && !inQQ && !inC && !inObj) bad.push(`t${f.g}: ${E} lost from queue/creepsQueued/creeps/objects`);
        if (inQ && inObj) bad.push(`t${f.g}: ${E} simultaneously queued and spawned`);
    }
    if (bornG === null) bad.push(`${E} never born (spawning:false creep)`);
    else {
        const c = creepAt(ctx.obs[bornG], E);
        if (c.hits !== c.b.length * 100) bad.push(`born hits ${c.hits} want ${c.b.length * 100}`);
        ctx.evidence.bornBody = c.b;
        if (wantBody && JSON.stringify(c.b) !== JSON.stringify(wantBody)) {
            bad.push(`born body ${JSON.stringify(c.b)} want ${JSON.stringify(wantBody)}`);
        }
        const cm = ctx.obs[bornG].cm && ctx.obs[bornG].cm[E];
        if (!cm) bad.push(`Memory.creeps['${E}'] absent at birth`);
        else if (ctx.expectSourceId && cm.as !== undefined && cm.as !== ctx.expectSourceId) {
            bad.push(`born creep assignedSource ${cm.as} want ${ctx.expectSourceId}`);
        }
        ctx.evidence.bornMemory = cm;
    }
    bad.push(...energyProblems(ctx));
    return bad;
}

function oracleDistNoSpawn(ctx) {
    // noenergy / nameexists: order must never produce a spawn or energy spend.
    const bad = [];
    const fs = fenceList(ctx);
    const ev = spawnEvents(ctx);
    ctx.characterizations = ctx.characterizations || [];
    if (ev.length) bad.push(`unexpected spawn events: ${ev.map(e => `${e.name}@${e.g}`).join(',')}`);
    for (const f of fs) if (f.sp) bad.push(`t${f.g}: spawn.spawning present (${JSON.stringify(f.sp)})`);
    const E = ctx.expectName;
    // order must still be queued (no fake completion, no silent removal for
    // energy-0); for nameexists the queue entry is consumed by the failed
    // spawn — that is the defect under observation, so queue loss is asserted
    // by the caller's expect block instead.
    if (ctx.variant === 'noenergy') {
        let sawQueued = false;
        for (const f of fs) {
            const mk = mgrKey(f, '_SpnM');
            if (mk && (f.mm[mk].queue || []).some(q => q.n === E)) sawQueued = true;
        }
        if (!sawQueued) bad.push(`${E} never observed queued`);
        const last = lastFence(ctx);
        const mk = mgrKey(last, '_SpnM');
        if (!(mk && (last.mm[mk].queue || []).some(q => q.n === E))) bad.push(`${E} not queued at end (silent loss?)`);
        const sk2 = mgrKey(last, '_SrcM');
        if (!(sk2 && (last.mm[sk2].q || []).some(q => q.n === E))) bad.push(`${E} not in creepsQueued at end`);
    }
    bad.push(...energyProblems(ctx));
    return bad;
}

function oracleDist2Chain(ctx) {
    // SPN-01-d2 base/priority + SPN-02-d2 + SPN-03-d2-{api,kill,orphan} shared
    // order->spawn->process->born->active chain checks.
    const bad = [];
    const fs = fenceList(ctx);
    const ev = spawnEvents(ctx);
    ctx.characterizations = ctx.characterizations || [];
    const OID = ctx.expectOrder;                       // annotation == resource id
    const wantName = OID + '_0';
    const wantBody = ctx.expectBody;
    const wantSrc = ctx.expectSourceId;

    const orderRow = f => (f.rm && f.rm.creepOrder || []).find(x => x.id === OID) || null;
    const procRows = f => ((f.rm && f.rm.spawnProcess) || []).filter(p => p.oid === OID);

    // status sequence must be a subsequence of pending -> spawning -> active
    let stG = { pending: null, spawning: null, active: null };
    for (const f of fs) {
        const o = orderRow(f);
        if (o && stG[o.st] === null && stG[o.st] !== undefined) stG[o.st] = f.g;
    }
    ctx.evidence = Object.assign(ctx.evidence || {}, { stG });
    if (!stG.pending) bad.push(`order ${OID} never seen pending`);
    if (!stG.active) bad.push(`order ${OID} never became active`);
    if (!ctx.skipSeq) {
        if (stG.pending && stG.spawning && stG.spawning <= stG.pending) bad.push(`spawning(${stG.spawning}) <= pending(${stG.pending})`);
        if (stG.spawning && stG.active && stG.active <= stG.spawning) bad.push(`active(${stG.active}) <= spawning(${stG.spawning})`);
    }

    // expected number of spawn events with the order's engine name
    const wantCount = ctx.expectSpawnCount || 1;
    const evO = ev.filter(e => e.name === wantName);
    if (evO.length !== wantCount) bad.push(`spawn events for ${wantName}: ${evO.length} (want ${wantCount}) ${JSON.stringify(ev)}`);
    else {
        const e = evO[0];
        if (stG.pending && e.g <= stG.pending) bad.push(`spawn fence ${e.g} <= pending fence ${stG.pending}`);
        ctx.evidence.spawn = e;
        if (e.needTime !== wantBody.length * 3) bad.push(`needTime ${e.needTime} want ${wantBody.length * 3}`);
    }
    // no other spawn events at all unless allowed
    if (!ctx.allowOtherSpawns) {
        const others = ev.filter(e => e.name !== wantName);
        if (others.length) bad.push(`unexpected spawn events: ${JSON.stringify(others)}`);
    }

    // process presence during the spawning window, deleted on completion
    const procSeen = [];
    for (const f of fs) {
        const ps = procRows(f);
        if (ps.length) procSeen.push({ g: f.g, p: ps[0] });
    }
    if (evO.length) {
        if (!procSeen.length) bad.push('no spawnProcess row ever observed');
        else {
            const p = procSeen[0].p;
            if (p.sid !== ctx.spawnId) bad.push(`spawnProcess.spawnId ${p.sid} want ${ctx.spawnId}`);
            if (p.cn !== wantName) bad.push(`spawnProcess.creepName ${p.cn} want ${wantName}`);
            if (stG.spawning && procSeen[0].g < stG.spawning) bad.push(`process before 'spawning' status`);
            if (!ctx.multiCycle && stG.active && procSeen[procSeen.length - 1].g >= stG.active) bad.push('process still present at/after activation');
        }
    }
    // while status='spawning' the order must have a live process reference.
    // ctx.forcedSpawnWindowEnd exempts only frames <= that gameTime for the
    // probed order — spn-03-d2-orphan ARRANGES 'spawning'-without-process as
    // the input (journaled forced write at t1); the system's response (reset
    // to pending at the %10 reconcile, then a real spawn) is still asserted.
    for (const f of fs) {
        const o = orderRow(f);
        if (o && o.st === 'spawning' && !procRows(f).length &&
            !(ctx.forcedSpawnWindowEnd && f.g <= ctx.forcedSpawnWindowEnd)) {
            bad.push(`t${f.g}: order 'spawning' without spawnProcess`);
        }
    }
    // activation fields
    if (stG.active) {
        const f = fenceList(ctx).find(x => { const o = orderRow(x); return o && o.st === 'active'; });
        const o = orderRow(f);
        if (o.cn !== wantName) bad.push(`active order creepName ${o.cn} want ${wantName}`);
        // expiryTime set to user Game.time + 1500 at the %10 reconcile tick
        const userT = f.g - 1;
        if (o.ex !== userT + 1500) bad.push(`expiryTime ${o.ex} want ${userT + 1500} (act tick +1500)`);
    }
    // born creep with body + memory link (first non-spawning observation)
    let cr = null;
    for (const f of fs) { const c = creepAt(f, wantName); if (c && !c.sp) { cr = c; break; } }
    if (!cr) bad.push(`creep ${wantName} never observed born`);
    else {
        if (wantBody && JSON.stringify(cr.b) !== JSON.stringify(wantBody)) {
            bad.push(`creep body ${JSON.stringify(cr.b)} want ${JSON.stringify(wantBody)}`);
        }
        if (cr.hits !== cr.b.length * 100) bad.push(`creep hits ${cr.hits} want ${cr.b.length * 100}`);
    }
    const fLast = lastFence(ctx);
    const cm = fLast.cm && fLast.cm[wantName];
    if (!cm) bad.push(`Memory.creeps['${wantName}'] absent at end`);
    else if (wantSrc && cm.sid !== wantSrc) bad.push(`creep memory sourceId ${cm.sid} want ${wantSrc}`);

    // secondary orders that must remain pending for the whole window
    for (const oid of ctx.pendingStay || []) {
        const o = (fLast.rm && fLast.rm.creepOrder || []).find(x => x.id === oid);
        if (!o) bad.push(`secondary order ${oid} missing at end`);
        else if (o.st !== 'pending') bad.push(`secondary order ${oid} status ${o.st} want pending`);
    }

    bad.push(...energyProblems(ctx));
    return bad;
}

function oracleDist2NoSpawn(ctx) {
    const bad = [];
    const fs = fenceList(ctx);
    const ev = spawnEvents(ctx);
    ctx.characterizations = ctx.characterizations || [];
    if (ev.length) bad.push(`unexpected spawn events: ${JSON.stringify(ev)}`);
    for (const f of fs) if (f.sp) bad.push(`t${f.g}: spawn.spawning present ${JSON.stringify(f.sp)}`);
    for (const f of fs) {
        for (const p of (f.rm && f.rm.spawnProcess) || []) {
            bad.push(`t${f.g}: spawnProcess ${p.id} present despite no spawn`);
        }
    }
    // every declared order stays pending the whole run
    for (const oid of ctx.pendingOrders || []) {
        for (const f of fs) {
            const o = (f.rm && f.rm.creepOrder || []).find(x => x.id === oid);
            if (o && o.st !== 'pending') bad.push(`t${f.g}: order ${oid} status ${o.st} (want pending)`);
        }
        const lf = lastFence(ctx);
        const o = (lf.rm && lf.rm.creepOrder || []).find(x => x.id === oid);
        if (!o) bad.push(`order ${oid} missing at end`);
    }
    bad.push(...energyProblems(ctx));
    return bad;
}

// ---------------------------------------------------------------------------
// Mode table
// ---------------------------------------------------------------------------
// SPN-D6 note on schema.ratio: CreepOrder.calculateBodyParts divides
// remainingEnergy by ratioSetCost — an empty `ratio:{}` (the createSchema
// default) makes ratioSetCost=0 -> maxSets=Infinity -> infinite loop ->
// user script hard timeout at the first %10 reconcile (three quarantined
// acks: spn02d2-…69837, spn03d2api-…69944, spn03d2kill-…70057). The orders
// below therefore carry `ratio:{work:1}` with `maxCost` clamped to the
// constant cost: the real ratio path runs (set-cost computed, maxSets
// derived, maxCost clamp applied) yet 0 sets are added, keeping the
// intended constant-only bodies ([work,move] / [move]) unchanged.
const D2_FIRST_ORDER = {
    role: 'harvester', priority: 5,
    schema: { constant: ['work', 'move'], ratio: { work: 1 }, maxCost: 150 },
    roomName: null, memory: { role: 'harvester' }, metadata: { annotation: 'first' },
};
const D2_API_ORDER = {
    role: 'probe', priority: 4,
    schema: { constant: ['move'], ratio: { work: 1 }, maxCost: 50 },
    roomName: null, memory: { role: 'probe' }, metadata: { annotation: 'api_rec' },
};
const D2_ORPH_ORDER = {
    role: 'probe', priority: 1,
    schema: { constant: ['move'], ratio: { work: 1 }, maxCost: 50 },
    roomName: null, memory: { role: 'probe' }, metadata: { annotation: 'orph' },
};
const D2_IMPOSSIBLE_ORDER = {
    role: 'x', priority: 1e15,
    schema: { constant: ['work', 'work', 'work', 'work'], ratio: {}, maxCost: 0 },
    roomName: null, memory: { role: 'x' }, metadata: { annotation: 'top_impossible' },
};
const D2_LOWPRI_ORDER = {
    role: 'probe', priority: 1,
    schema: { constant: ['move'], ratio: { work: 1 }, maxCost: 50 },
    roomName: null, memory: { role: 'probe' }, metadata: { annotation: 'probe_low' },
};

const MODES = {
    // ---- SPN-01 dist -------------------------------------------------------
    'spn-01-d': {
        ports: [32400, 32401], scenario: 'SPN-01-D', maxSteps: 15, tree: 'dist',
        variant: 'base', expectName: 'harvester0',
        expectBody: ['work', 'move'], expectCost: 150, done: 0,
        oracle: oracleDistQueue,
    },
    'spn-01-d-occupied': {
        ports: [32402, 32403], scenario: 'SPN-01-D', maxSteps: 15, tree: 'dist',
        variant: 'occupied', expectName: 'harvester0',
        expectBody: ['work', 'move'], expectCost: 150, done: 13,
        oracle: oracleDistQueue,
        check: (ctx, bad) => {
            const ev = spawnEvents(ctx);
            if (ev.length !== 2 || ev[0].name !== 'occ' || ev[1].name !== 'harvester0') {
                bad.push(`spawn events ${JSON.stringify(ev.map(e => e.name))} want [occ, harvester0]`);
            }
            // harvester0 must wait for the occupied spawn
            const spn = ctx.evidence && ctx.evidence.spawnG;
            if (spn !== null && spn <= 2) bad.push(`harvester0 spawned at ${spn} while spawn should be occupied`);
        },
    },
    'spn-01-d-noenergy': {
        ports: [32404, 32405], scenario: 'SPN-01-D', maxSteps: 10, tree: 'dist',
        variant: 'noenergy', expectName: 'harvester0', done: 8,
        oracle: oracleDistNoSpawn,
        beforeStep: { 1: 'energy0' },
    },
    'spn-01-d-priority': {
        ports: [32406, 32407], scenario: 'SPN-01-D', maxSteps: 26, tree: 'dist',
        variant: 'priority', stub: true, expectName: 'mule0',
        expectBody: ['carry', 'carry', 'move', 'carry', 'carry', 'move'], expectCost: 300, done: 0,
        oracle: oracleDistQueue,
        check: (ctx, bad) => {
            // highest-priority stub order must be dequeued/spawned first
            const fs = fenceList(ctx);
            const first = fs.find(f => { const k = mgrKey(f, '_SpnM'); return k && (f.mm[k].queue || []).length; });
            if (!first) { bad.push('no queue frame'); return; }
            const q = (first.mm[mgrKey(first, '_SpnM')].queue || []).map(x => x.n);
            if (q[0] !== 'mule0') bad.push(`queue head ${q[0]} want mule0 (priority 8 > 5) — full queue ${JSON.stringify(q)}`);
        },
    },
    'spn-01-d-nameexists': {
        ports: [32408, 32409], scenario: 'SPN-01-D', maxSteps: 12, tree: 'dist',
        variant: 'nameexists', expectName: 'harvester0', done: 6, creep: 'harvester0',
        oracle: oracleDistNoSpawn,
        check: (ctx, bad) => {
            // defect reproduction: queue entry consumed by ERR_NAME_EXISTS, the
            // foreign living creep adopted into creepOwner.creeps, zero spend.
            const fs = fenceList(ctx);
            const mk = f => mgrKey(f, '_SrcM');
            let adopted = null;
            for (const f of fs) {
                const k = mk(f);
                if (adopted === null && k && (f.mm[k].c || []).includes('harvester0')) adopted = f.g;
            }
            if (adopted === null) bad.push('foreign harvester0 never adopted into creepOwner.creeps (defect not reproduced)');
            else ctx.characterizations.push(`DEFECT SPN-D1 reproduced: foreign 'harvester0' adopted at t${adopted}; queue entry consumed without spawn/energy spend`);
            const last = lastFence(ctx);
            const sk = mgrKey(last, '_SpnM');
            if (sk && (last.mm[sk].queue || []).some(q => q.n === 'harvester0')) {
                bad.push('harvester0 still in spawn queue at end (defect: entry should have been consumed)');
            }
        },
    },
    // ---- SPN-01 dist2 ------------------------------------------------------
    'spn-01-d2': {
        ports: [32410, 32411], scenario: 'SPN-01-D2', maxSteps: 35, tree: 'dist2',
        variant: 'base', d2: { useSrcCtrl: true, done: 33 },
        oracle: oracleDist2Chain, srcCtrlOrders: true,
        expectBody: ['move', 'carry', 'work', 'work'],
    },
    'spn-01-d2-occupied': {
        ports: [32412, 32413], scenario: 'SPN-01-D2', maxSteps: 20, tree: 'dist2',
        variant: 'occupied',
        d2: { useSrcCtrl: true, directSpawn: [{ t: 7, name: 'occ1', body: ['move', 'work'] }], done: 15 },
        oracle: oracleDist2NoSpawnExcept, srcCtrlOrders: true, allowSpawn: ['occ1'],
    },
    'spn-01-d2-noenergy': {
        ports: [32414, 32415], scenario: 'SPN-01-D2', maxSteps: 15, tree: 'dist2',
        variant: 'noenergy', d2: { useSrcCtrl: true, done: 13 },
        oracle: oracleDist2NoSpawn, srcCtrlOrders: true,
        beforeStep: { 1: 'energy0' },
    },
    'spn-01-d2-priority': {
        ports: [32416, 32417], scenario: 'SPN-01-D2', maxSteps: 35, tree: 'dist2',
        variant: 'priority',
        d2: { useSrcCtrl: true, apiOrders: [{ t: 1, spec: 'probeLow' }], done: 33 },
        oracle: oracleDist2Chain, srcCtrlOrders: true, extraOrders: ['probe_low'],
        expectBody: ['move', 'carry', 'work', 'work'],
    },
    'spn-01-d2-nameexists': {
        ports: [32418, 32419], scenario: 'SPN-01-D2', maxSteps: 15, tree: 'dist2',
        variant: 'nameexists', d2: { useSrcCtrl: true, done: 13 },
        oracle: oracleDist2NoSpawn, srcCtrlOrders: true, creepByTop: true,
    },
    'spn-01-d2-starve': {
        ports: [32400, 32401], scenario: 'SPN-01-D2', maxSteps: 35, tree: 'dist2',
        variant: 'starve',
        d2: { useSrcCtrl: true, apiOrders: [{ t: 1, spec: 'impossible' }], done: 33 },
        oracle: oracleDist2NoSpawn, srcCtrlOrders: true, extraOrders: ['top_impossible'],
        starve: true,
        check: (ctx, bad) => {
            // starvation defect: impossible top-priority order blocks all
            // lower orders across >=2 reconcile windows (f11/f21/f31...)
            const fences11 = fenceList(ctx).filter(f => f.g >= 11 && (f.g - 1) % 10 === 0);
            if (fences11.length < 2) bad.push(`only ${fences11.length} reconcile fences observed (want >=2)`);
            ctx.characterizations.push(`DEFECT SPN-D2 reproduced: impossible top-priority order starved ${fences11.length} reconcile windows — zero spawns, all orders pending`);
        },
    },
    // ---- SPN-02 ------------------------------------------------------------
    'spn-02-d': {
        ports: [32402, 32403], scenario: 'SPN-02-D', maxSteps: 15, tree: 'dist',
        variant: 'base', expectName: 'harvester0',
        expectBody: ['work', 'move'], expectCost: 150, done: -1,
        oracle: oracleDistQueue,
        check: (ctx, bad) => {
            const S = lastFence(ctx).spn || {};
            if (!S.rl) { bad.push('runtime reload evidence missing (S.rl)'); return; }
            if (!(S.rl.c || []).includes(ctx.expectName)) bad.push(`post-reload creeps ${JSON.stringify(S.rl.c)} missing ${ctx.expectName}`);
            ctx.characterizations.push(`runtime reload at t${S.rl.t}: creeps=${JSON.stringify(S.rl.c)} queued=${JSON.stringify(S.rl.q)}`);
        },
    },
    'spn-02-d2': {
        ports: [32404, 32405], scenario: 'SPN-02-D2', maxSteps: 35, tree: 'dist2',
        variant: 'base',
        d2: { apiOrders: [{ t: 1, spec: 'first' }], expectOrder: 'first', reloadLag: 1, done: 34 },
        oracle: oracleDist2Chain, expectOrder: 'first',
        expectBody: ['work', 'move'], expectSourceId: 's1',
        check: (ctx, bad) => {
            const S = lastFence(ctx).spn || {};
            if (!S.rl) { bad.push('runtime reload evidence missing (S.rl)'); return; }
            if (S.rl.st !== 'active' || S.rl.cn !== 'first_0' || S.rl.inst !== true || S.rl.alive !== true) {
                bad.push(`post-reload order state ${JSON.stringify(S.rl)} want active/first_0/instanceof/alive`);
            } else ctx.characterizations.push(`runtime reload at t${S.rl.t}: order stays active, instanceof CreepOrder, creep alive`);
        },
    },
    // ---- SPN-03 ------------------------------------------------------------
    'spn-03-d2-api': {
        ports: [32406, 32407], scenario: 'SPN-03-D2', maxSteps: 35, tree: 'dist2',
        variant: 'api',
        d2: { apiOrders: [{ t: 1, spec: 'first' }, { t: 12, spec: 'apiRec' }], expectOrder: 'api_rec', done: 33 },
        oracle: oracleDist2Chain, expectOrder: 'api_rec',
        expectBody: ['move'], allowOtherSpawns: true,
        check: (ctx, bad) => {
            // api_rec applied at t=12 while 'first' spawn in flight: it must
            // stay pending until the first process completed, never fake active.
            const ev = spawnEvents(ctx).map(e => e.name);
            const i1 = ev.indexOf('first_0'), i2 = ev.indexOf('api_rec_0');
            if (i1 === -1 || i2 === -1) bad.push(`spawn events ${JSON.stringify(ev)} want first_0 then api_rec_0`);
            else if (i2 < i1) bad.push('api_rec_0 spawned before first_0');
            const fs = fenceList(ctx);
            const actG = fs.find(f => (f.rm && f.rm.creepOrder || []).some(o => o.id === 'first' && o.st === 'active'));
            const apiSpawn = spawnEvents(ctx).find(e => e.name === 'api_rec_0');
            if (actG && apiSpawn && apiSpawn.g < actG.g) bad.push(`api_rec spawned at ${apiSpawn.g} before 'first' completed (${actG.g})`);
            // never pending->active without living creep
            for (const f of fs) {
                const o = (f.rm && f.rm.creepOrder || []).find(x => x.id === 'api_rec');
                if (o && o.st === 'active' && !creepAt(f, o.cn)) bad.push(`t${f.g}: api_rec active but creep ${o.cn} absent`);
            }
        },
    },
    'spn-03-d2-kill': {
        // energy0 drain at t30 + energyFull restore at t35: the reconcile
        // cleanup (dead Memory.creeps key delete + active-order->pending,
        // SpawnController.js:11-32) runs while the order loop's spawnCreep
        // fails ERR_NOT_ENOUGH_ENERGY (verified: spn-01-d2-noenergy) — the
        // dead key stays observably absent and the order observably pending
        // through frames 31-40. Restoring energy before the t40 reconcile
        // re-spawns first_0 normally -> born ~t46, active at the t50
        // reconcile (frame 51). The earlier 'blocker' directSpawn design
        // could not work: both the CAP and the reconcile spawn intents land
        // in the same tick and the later (reconcile) intent wins — first_0
        // re-spawned anyway and the intent-time Memory.creeps write made the
        // cleanup unobservable (run spn03d2kill-1793925015982-690469).
        ports: [32408, 32409], scenario: 'SPN-03-D2', maxSteps: 58, tree: 'dist2',
        variant: 'kill',
        d2: { apiOrders: [{ t: 1, spec: 'first' }], expectOrder: 'first', kill: { t: 25, name: 'first_0' }, done: 55 },
        beforeStep: { 30: 'energy0', 35: 'energyFull' },
        oracle: oracleDist2Chain, expectOrder: 'first',
        expectBody: ['work', 'move'], expectSourceId: 's1',
        expectSpawnCount: 2, multiCycle: true,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            const S = lastFence(ctx).spn || {};
            if (!S.kill || !S.kill.ok) bad.push(`suicide call failed: ${JSON.stringify(S.kill)}`);
            // after death: Memory.creeps key must be removed by the %10
            // cleanup, order must go pending (transiently) and re-spawn.
            const ev = spawnEvents(ctx).filter(e => e.name === 'first_0');
            if (ev.length !== 2) bad.push(`spawn events for first_0: ${ev.length} want 2 (re-spawn after death)`);
            if (!ev.length) return;
            const w2 = (ev[1] || { g: 1e9 }).g;
            const dead = fs.some(f => f.g > ev[0].g && f.g < w2 && !creepAt(f, 'first_0'));
            if (!dead) bad.push('creep first_0 never absent between spawns');
            // Memory.creeps cleanup + transient pending are observable only
            // inside the energy-drained window between the two spawn intents
            const memGone = fs.some(f => f.g > ev[0].g && f.g < w2 && f.cm && !('first_0' in f.cm));
            if (!memGone) bad.push('Memory.creeps[first_0] never observed removed after death');
            else ctx.characterizations.push('Memory.creeps[first_0] removed by the %10 cleanup while drained energy deferred the re-spawn');
            const pendWin = fs.some(f => f.g > ev[0].g && f.g < w2 &&
                (f.rm && f.rm.creepOrder || []).some(o => o.id === 'first' && o.st === 'pending'));
            if (!pendWin) bad.push("order 'first' never observed pending between death and re-spawn");
            else ctx.characterizations.push("order 'first' reverted to pending for the drain window, then re-spawned and re-activated");
            // second-cycle re-activation: the last activation must be after
            // the second spawn with creepName bound and expiry = tick+1500
            const acts = fs.filter(f => f.g > w2 &&
                (f.rm && f.rm.creepOrder || []).some(o => o.id === 'first' && o.st === 'active'));
            if (!acts.length) bad.push("order 'first' never re-activated after re-spawn");
            else {
                const o2 = (acts[0].rm.creepOrder || []).find(x => x.id === 'first');
                if (o2.cn !== 'first_0') bad.push(`re-activation creepName ${o2.cn} want first_0`);
                if (o2.ex !== acts[0].g - 1 + 1500) bad.push(`re-activation expiryTime ${o2.ex} want ${acts[0].g - 1 + 1500} (act tick +1500)`);
                const dangle2 = fs.some(f => f.g >= acts[0].g && (f.rm && f.rm.spawnProcess || []).length);
                if (dangle2) bad.push('spawnProcess dangling at/after second activation');
            }
        },
    },
    'spn-03-d2-nospawn': {
        ports: [32410, 32411], scenario: 'SPN-03-D2', maxSteps: 28, tree: 'dist2',
        variant: 'nospawn',
        d2: { apiOrders: [{ t: 1, spec: 'first' }], expectOrder: 'first', done: 26 },
        oracle: (ctx) => {
            const bad = [];
            const fs = fenceList(ctx);
            ctx.characterizations = ctx.characterizations || [];
            bad.push(...energyProblems(ctx));
            const ev = spawnEvents(ctx).filter(e => e.name === 'first_0');
            if (ev.length !== 1) bad.push(`spawn events: ${JSON.stringify(spawnEvents(ctx))} want one first_0`);
            // Engine fact (run spn03d2nospawn-1793925092930-690905): deleting
            // the spawn row mid-spawn removes the still-spawning creep too —
            // there is no ghost creep, so SPN-D4's predicted false-active
            // path cannot occur in this engine. The next %10 reconcile then
            // fails+removes the process and resets the order to pending; the
            // order stalls forever (no spawn exists). The contract asserted
            // here is the spec's real one: never a fabricated active.
            const row = f => (f.rm && f.rm.creepOrder || []).find(x => x.id === 'first');
            const gone = fs.filter(f => f.g >= 14 && !creepAt(f, 'first_0'));
            if (ev.length && !gone.length) bad.push('creep first_0 still present after spawn deletion (ghost creep?)');
            else if (ev.length) ctx.characterizations.push('engine deletes the spawning creep together with its spawn (no ghost) — SPN-D4 premise impossible');
            for (const f of fs) {
                const o = row(f);
                if (o && o.st === 'active') bad.push(`t${f.g}: order 'first' falsely active`);
            }
            const last = lastFence(ctx);
            const lo = row(last);
            if (!lo || lo.st !== 'pending') bad.push(`order 'first' end status ${lo && lo.st} want pending`);
            if (lo && lo.cn) bad.push(`order 'first' retains creepName ${lo.cn} after failed spawn`);
            // process AND Memory.creeps key must be removed by the first %10
            // reconcile after the deletion (tick 13 -> reconcile Game.time=20
            // -> frame 21); the spec contract is "удаление process и
            // Memory.creeps", both are asserted.
            const dangling = fs.some(f => f.g > 21 && (f.rm && f.rm.spawnProcess || []).length);
            if (dangling) bad.push('spawnProcess still present after the post-deletion reconcile');
            else ctx.characterizations.push('spawnProcess failed+removed at the first %10 reconcile after deletion; order reset pending forever');
            const memGone = fs.some(f => f.g >= 21 && f.cm && !('first_0' in f.cm));
            if (!memGone) bad.push('Memory.creeps[first_0] never observed removed after spawn deletion');
            const lateSpawning = fs.some(f => f.g > 21 && (o => o && o.st === 'spawning')(row(f)));
            if (lateSpawning) bad.push("order 'first' observed 'spawning' after the post-deletion reconcile (no spawn exists)");
            return bad;
        },
        beforeStep: { 13: 'deleteSpawn' },
    },
    'spn-03-d2-orphan': {
        ports: [32412, 32413], scenario: 'SPN-03-D2', maxSteps: 35, tree: 'dist2',
        variant: 'orphan',
        d2: {
            apiOrders: [{ t: 1, spec: 'first' }, { t: 1, spec: 'orph' }],
            forced: [{ t: 1, id: 'orph', fields: { status: 'spawning' } }],
            expectOrder: 'orph', done: 33,
        },
        oracle: oracleDist2Chain, expectOrder: 'orph',
        expectBody: ['move'], allowOtherSpawns: true, skipSeq: true,
        forcedSpawnWindowEnd: 11, // arranged input: forced 'spawning' until the t10 reconcile (frame 11)
        check: (ctx, bad) => {
            // 'orph' was forced status='spawning' with NO process: the %10
            // reconcile must reset it to pending (SpawnController.js:36-43)
            // before it can ever be spawned for real.
            const fs = fenceList(ctx);
            const preSpawning = fs.some(f => f.g > 1 && f.g <= 11 &&
                (f.rm && f.rm.creepOrder || []).some(o => o.id === 'orph' && o.st === 'spawning'));
            if (!preSpawning) bad.push('orph never observed in forced spawning state pre-reconcile');
            const resetG = fs.find(f => f.g > 1 &&
                (f.rm && f.rm.creepOrder || []).some(o => o.id === 'orph' && o.st === 'pending'));
            if (!resetG) bad.push('orph never reset to pending');
            else ctx.characterizations.push(`orphan 'spawning' (no process) reset to pending at t${resetG.g}, then spawned normally`);
            // no process may exist for orph while its status was forced-spawning
            for (const f of fs) {
                const o = (f.rm && f.rm.creepOrder || []).find(x => x.id === 'orph');
                const p = (f.rm && f.rm.spawnProcess || []).find(x => x.oid === 'orph');
                if (o && o.st === 'spawning' && !p) {
                    // allowed only for the forced pre-reset window
                    if (f.g > 11) bad.push(`t${f.g}: orph 'spawning' without process after reset window`);
                }
            }
        },
    },
    'spn-03-d2-expiry': {
        ports: [32414, 32415], scenario: 'SPN-03-D2', maxSteps: 55, tree: 'dist2',
        variant: 'expiry',
        d2: {
            apiOrders: [{ t: 1, spec: 'first' }], expectOrder: 'first',
            forced: [{ t: 25, id: 'first', fields: { expiryAdd: 30 } }], done: 53,
        },
        oracle: (ctx) => {
            const bad = [];
            const fs = fenceList(ctx);
            ctx.characterizations = ctx.characterizations || [];
            bad.push(...energyProblems(ctx));
            const ev = spawnEvents(ctx).filter(e => e.name === 'first_0');
            if (ev.length !== 1) bad.push(`spawn events: ${JSON.stringify(spawnEvents(ctx))} want exactly one first_0`);
            // activation at ~t=20 sets expiry 1520; forced expiryTime=t+30 at
            // t=25 makes the next %10 reconcile reset the order to pending;
            // re-spawn then collides with the living 'first_0' (ERR_NAME_EXISTS)
            // -> permanent stall. That is the defect under observation.
            const row = f => (f.rm && f.rm.creepOrder || []).find(x => x.id === 'first');
            const act = fs.filter(f => { const o = row(f); return o && o.st === 'active'; });
            if (!act.length) bad.push('order never active');
            const pend = fs.filter(f => f.g > (act.length ? act[act.length - 1].g : 0) && (o => o && o.st === 'pending')(row(f)));
            if (pend.length < 2) bad.push(`order pending after expiry on ${pend.length} fences (want >=2 reconcile windows)`);
            else ctx.characterizations.push(`DEFECT SPN-D5: expiry reset at t~30 -> order pending for ${pend.length} fences while living creep 'first_0' blocks its own re-spawn (ERR_NAME_EXISTS stall)`);
            const last = lastFence(ctx);
            if (!creepAt(last, 'first_0')) bad.push('original creep first_0 lost');
            const o = row(last);
            if (o && o.st === 'active') bad.push('order wrongly re-activated');
            // no process may exist during the post-expiry stall — a fabricated
            // spawnProcess without a spawn event would evade the ev count check
            for (const f of fs) {
                const oo = row(f);
                if (oo && oo.st === 'pending' && (f.rm && f.rm.spawnProcess || []).length) {
                    bad.push(`t${f.g}: spawnProcess present while order pending in stall window`);
                }
            }
            return bad;
        },
    },
    'spn-03-d-deadq': {
        ports: [32416, 32417], scenario: 'SPN-03-D', maxSteps: 15, tree: 'dist',
        variant: 'deadq', expectName: 'harvester0',
        expectBody: ['work', 'move'], expectCost: 150, done: 0,
        oracle: oracleDistQueue,
        check: (ctx, bad) => {
            const fs = fenceList(ctx);
            const S = lastFence(ctx).spn || {};
            if (!S.kill || !S.kill.ok) bad.push(`suicide call failed: ${JSON.stringify(S.kill)}`);
            // dead name must leave the saved creeps[]/creepsQueued and the
            // source must re-queue (defect-free part of the recovery path).
            const bornG = ctx.evidence && ctx.evidence.bornG;
            const after = fs.filter(f => bornG === null || f.g >= bornG);
            const last = lastFence(ctx);
            const srcK2 = mgrKey(last, '_SrcM');
            const saved = last.mm && last.mm[srcK2] || {};
            if ((saved.c || []).includes('harvester0')) bad.push('dead harvester0 still in saved creeps[]');
            if ((saved.q || []).some(q => q.n === 'harvester0')) bad.push('dead harvester0 still in saved creepsQueued');
            const spnK2 = mgrKey(last, '_SpnM');
            const q = (last.mm && last.mm[spnK2] && last.mm[spnK2].queue || []).map(x => x.n);
            if (!q.length) bad.push('no re-queue after death (queue empty at end)');
            else ctx.characterizations.push(`dead creep removed from saved owner state; re-queued ${JSON.stringify(q)}`);
        },
    },
};

// ---------------------------------------------------------------------------

function d2Spec(name, room, s1) {
    const specs = {
        first: () => ({ ...D2_FIRST_ORDER, roomName: room, memory: { role: 'harvester', sourceId: s1 } }),
        apiRec: () => ({ ...D2_API_ORDER, roomName: room }),
        orph: () => ({ ...D2_ORPH_ORDER, roomName: room }),
        impossible: () => ({ ...D2_IMPOSSIBLE_ORDER, roomName: room }),
        probeLow: () => ({ ...D2_LOWPRI_ORDER, roomName: room }),
    };
    return specs[name]();
}

function oracleDist2NoSpawnExcept(ctx) {
    const bad = [];
    const fs = fenceList(ctx);
    const ev = spawnEvents(ctx);
    ctx.characterizations = ctx.characterizations || [];
    const allow = ctx.allowSpawn || [];
    const unexpected = ev.filter(e => !allow.includes(e.name));
    if (unexpected.length) bad.push(`unexpected spawn events: ${JSON.stringify(unexpected)}`);
    for (const p of processesAll(ctx)) bad.push(`t${p.g}: spawnProcess ${p.id} present despite blocked orders`);
    for (const f of fs) {
        for (const o of (f.rm && f.rm.creepOrder) || []) {
            if (o.st && o.st !== 'pending') bad.push(`t${f.g}: order ${o.id} status ${o.st} while spawn occupied`);
        }
    }
    bad.push(...energyProblems(ctx));
    return bad;
}
function processesAll(ctx) {
    const out = [];
    for (const f of fenceList(ctx)) for (const p of (f.rm && f.rm.spawnProcess) || []) out.push({ g: f.g, ...p });
    return out;
}

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
    spec.expectCreep = !!(def.creep || def.creepByTop);
    if (def.creep) spec.creep.name = def.creep === true ? spec.creep.name : def.creep;

    const res = await runScenario({
        runId, scenarioId: def.scenario, seedId,
        ports: { http: httpPort, cli: cliPort },
        fixtureSpec: spec,
        budgets: { maxSteps: MAX_STEPS || def.maxSteps, WcaseMs: WCASE_MS },
        arrange: async (h, fx, journal) => {
            // ctx carries resolved real ids into the entrypoint + oracle.
            const epCtx = { s1: fx.actual.source1.id, s2: fx.actual.source2.id, room: fx.room };
            if (def.srcCtrlOrders) {
                // highest-priority source order = argmax d2Priority(source id)
                const p1 = d2Priority(epCtx.s1), p2 = d2Priority(epCtx.s2);
                const top = p1 >= p2 ? epCtx.s1 : epCtx.s2;
                epCtx.topOrder = `harvester_${top}`;
                epCtx.otherOrder = `harvester_${top === epCtx.s1 ? epCtx.s2 : epCtx.s1}`;
                epCtx.topPriority = Math.max(p1, p2);
                epCtx.otherPriority = Math.min(p1, p2);
                epCtx.topSrc = top;
            }
            let modules, hashes;
            if (def.tree === 'dist') {
                ({ modules, hashes } = dEntrypoint(epCtx, {
                    mode: def.variant, expectName: def.expectName,
                    done: def.done, stub: def.stub,
                }));
            } else {
                const cfg = JSON.parse(JSON.stringify(def.d2));
                if (cfg.apiOrders) cfg.apiOrders = cfg.apiOrders.map(a => ({ t: a.t, spec: d2Spec(a.spec, fx.room, epCtx.s1) }));
                if (def.expectOrder) cfg.expectOrder = def.expectOrder;
                ({ modules, hashes } = d2Entrypoint(epCtx, cfg));
            }
            // nameexists: place the colliding creep via the real fixture path —
            // mutate spec.creep.name to the resolved name so validateFixture
            // still proves the arranged world.
            if (def.creepByTop) spec.creep.name = `${epCtx.topOrder}_0`;
            const ctx = await arrangeBase(h, fx, journal, MODE, { modules, withCreep: spec.expectCreep });
            Object.assign(ctx, epCtx);
            ctx.moduleHashes = hashes;
            ctx.variant = def.variant;
            ctx.expectName = def.expectName;
            ctx.expectOrder = def.srcCtrlOrders ? epCtx.topOrder : def.expectOrder;
            if (def.expectSourceId === 's1') ctx.expectSourceId = epCtx.s1;
            else if (def.srcCtrlOrders) ctx.expectSourceId = epCtx.topSrc;
            else if (def.tree === 'dist') ctx.expectSourceId = epCtx.s1;
            ctx.ownerKey = def.stub ? 'StubM' : '_SrcM';
            ctx.skipSeq = def.skipSeq;
            ctx.forcedSpawnWindowEnd = def.forcedSpawnWindowEnd || 0;
            ctx.expectSpawnCount = def.expectSpawnCount || 1;
            ctx.expectDeath = def.variant === 'deadq';
            ctx.pendingStay = def.srcCtrlOrders && !def.noSpawnOracle
                ? [epCtx.otherOrder].concat(def.extraOrders || [])
                : [];
            ctx.expectBody = def.expectBody;
            ctx.expectCost = def.expectCost;
            ctx.allowOtherSpawns = def.allowOtherSpawns;
            ctx.allowSpawn = def.allowSpawn;
            ctx.pendingOrders = def.srcCtrlOrders
                ? [epCtx.topOrder, epCtx.otherOrder].concat(def.extraOrders || [])
                : (def.extraOrders || []);
            ctx.starve = def.starve;
            ctx.multiCycle = def.multiCycle;
            // beforeStep(i) lands in the tick whose post-state is frame i+1
            ctx.skipEnergyDeltaG = new Set(Object.keys(def.beforeStep || {}).map(i => Number(i) + 1));
            // spawn id needed for spawnProcess.spawnId checks + injected
            // energy0/energyFull/deleteSpawn actions
            const sp = await h.eval(`storage.db['rooms.objects'].findOne({$and:[{room:${JSON.stringify(fx.room)}},{type:'spawn'}]})`, 15000);
            ctx.spawnId = sp && sp._id;
            journal.add('env', 'spawn-id', 'measure', { spawnId: ctx.spawnId });
            return ctx;
        },
        supplemental,
        beforeStep: def.beforeStep ? async (i, { h, ctx: c2, journal }) => {
            const act = def.beforeStep[i];
            if (act === 'energy0') {
                await h.dbUpdate('rooms.objects', { _id: c2.spawnId }, { store: { energy: 0 } });
                journal.add('env', c2.spawnId, 'update', { 'store.energy': 0, injected: true });
            } else if (act === 'energyFull') {
                await h.dbUpdate('rooms.objects', { _id: c2.spawnId }, { store: { energy: 300 } });
                journal.add('env', c2.spawnId, 'update', { 'store.energy': 300, injected: true });
            } else if (act === 'deleteSpawn') {
                await h.eval(`storage.db['rooms.objects'].removeWhere({_id:${JSON.stringify(c2.spawnId)}})`, 15000);
                journal.add('env', c2.spawnId, 'delete', { injected: true });
            }
        } : undefined,
        perTickCheck: (rec, prev, ctx) => {
            const bad = [];
            const mem = rec.memory && rec.memory[ctx.userId];
            if (mem && mem.spn && mem.spn.err) bad.push(`entrypoint threw: ${mem.spn.err}`);
            if (Array.isArray(rec.errors) && rec.errors.length) bad.push(`${rec.errors.length} user error notifications`);
            const names = (rec.creeps || []).map(c => c.name);
            const dup = names.filter((n, i) => names.indexOf(n) !== i);
            if (dup.length) bad.push(`duplicate creep names: ${dup.join(',')}`);
            if (rec.gameTime !== null) collectObs(rec, ctx);
            const spn = mem && mem.spn;
            if (spn && spn.done && !ctx.oracleEvaluated) {
                ctx.oracleEvaluated = true;
                ctx.oracleResult = (def.oracle ? def.oracle(ctx) : []) || [];
                if (def.check) def.check(ctx, ctx.oracleResult);
                for (const b of ctx.oracleResult) bad.push(`oracle: ${b}`);
            }
            return bad;
        },
        postcondition: (rec, ctx) => {
            const mem = rec.memory && rec.memory[ctx.userId];
            return !!(mem && mem.spn && mem.spn.done);
        },
    });

    // Persist oracle outcome + characterizations for the report.
    try {
        fs.writeFileSync(path.join(res.runDir, 'oracle.json'), JSON.stringify({
            mode: MODE, runId, verdict: res.verdict, verdictReason: res.verdictReason,
            oracleFailures: res.ctx && res.ctx.oracleResult || null,
            characterizations: res.ctx && res.ctx.characterizations || [],
            evidence: res.ctx && res.ctx.evidence || null,
        }, null, 2), { mode: 0o600 });
        fs.writeFileSync(path.join(res.runDir, 'budgets.json'), JSON.stringify({
            mode: MODE, maxSteps: MAX_STEPS || def.maxSteps, WCASE_MS, ...res.stats,
        }, null, 2), { mode: 0o600 });
    } catch {}
    process.exitCode = VERDICT_EXIT[res.verdict] !== undefined ? VERDICT_EXIT[res.verdict] : 3;
}

main().catch(e => { console.error(e); process.exitCode = 3; });
