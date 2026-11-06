'use strict';
// ORD suite — orders/planners/interface scenarios on top of the HAR harness.
//
// Mode-per-scenario runner. Each mode spins up a disposable F0 world, uploads
// the REAL production modules plus a test `main` that calls real public
// methods on real Game objects, steps the world under the exclusive gate, and
// evaluates recorded Memory.ord evidence against the oracle table probe-side.
//
// Modes:
//   ord-01            dist2 resource manager: apply/reapply/save/reload/query/
//                     delete + schema variants + CreepOrder body boundaries
//   ord-02-true       disabled flag: boolean true (absent save entry; reload
//                     discards in-memory spec change) + priority matrix
//   ord-02-strtrue    same with string 'true' as the control input
//   ord-02-false      control: disabled=false — save writes normally
//   ord-03            dist planners/data classes: SourceManager, SourceDesc,
//                     CreepPlanner, creepUtils, real spawnCreep verification
//   ord-04            dormant planners/interfaces: EconomyPlanner, SpawnPlanner,
//                     room.{harvest,consumption,path}Planner, Manager/Consumer/
//                     Producer over periodic boundaries (Game.time%100/%50)
//   ord-04-api-dist   isolated-runtime API checks (mapPatch+logger) from dist
//   ord-04-api-dist2  same from dist2 (files are byte-identical; recorded anyway)
//
// Usage: node e2e/ord/ord.js --mode ord-01 [--http-port 32380 --cli-port 32381]
//                            [--max-steps N] [--wcase-ms N]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runScenario, VERDICT_EXIT } = require('../har/harness');
const { fixtureF0 } = require('../har/fixture');
const { ord01Entrypoint, ord02Entrypoint, ord03Entrypoint, ord04Entrypoint,
    ord04ApiEntrypoint } = require('./entrypoints');

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

const LOOP = `module.exports.loop = function() { Memory.ord = { done: true }; };`;

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
async function arrangeBase(h, fx, journal, label, { modules, withCreep }) {
    const username = `ord_${label}_${process.pid}`;
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

// Count adjacent terrain cells != wall for a source pos (SourceManager's rule:
// terrain only, object occupancy does not matter).
async function adjacentFreeCells(h, room, src) {
    return h.eval(`storage.db['rooms.terrain'].findOne({room:${JSON.stringify(room)}}).then(function(t){
        var s = t.terrain, n = 0;
        for (var x = ${src.x} - 1; x <= ${src.x} + 1; x++) {
            for (var y = ${src.y} - 1; y <= ${src.y} + 1; y++) {
                if (x === ${src.x} && y === ${src.y}) continue;
                var c = s.charAt(y * 50 + x);
                if (c !== '1' && c !== '3') n++;
            }
        }
        return n;
    })`, 15000);
}

// Common per-tick checks shared by all ORD modes.
function commonTickCheck(rec, prev, ctx) {
    const bad = [];
    const mem = rec.memory && rec.memory[ctx.userId];
    if (mem && mem.ord && mem.ord.err) bad.push(`entrypoint threw: ${mem.ord.err}`);
    if (Array.isArray(rec.errors) && rec.errors.length) bad.push(`${rec.errors.length} user error notifications`);
    return bad;
}

// Read Memory.ord from a frame record.
function ordOf(rec, ctx) {
    const mem = rec.memory && rec.memory[ctx.userId];
    return mem && mem.ord;
}

// Oracle evaluation wiring: when Memory.ord.done appears in a frame, run the
// mode's oracle(ord, ctx) once and convert failures to FAIL problems. Modes
// may declare collectObs(rec, ctx) — called on EVERY frame to gather per-tick
// evidence from frame memory (used by ORD-04; keeps user Memory small).
function makeTickCheck(oracle, collectObs) {
    return (rec, prev, ctx) => {
        const bad = commonTickCheck(rec, prev, ctx);
        if (collectObs && rec.gameTime !== null) collectObs(rec, ctx);
        const ord = ordOf(rec, ctx);
        if (ord && ord.done && !ctx.oracleEvaluated) {
            ctx.oracleEvaluated = true;
            ctx.oracleResult = oracle(ord, ctx, rec) || [];
            for (const b of ctx.oracleResult) bad.push(`oracle: ${b}`);
        }
        return bad;
    };
}
const donePostcondition = (rec, ctx) => {
    const ord = ordOf(rec, ctx);
    return !!(ord && ord.done);
};

const BODYPART_COST = { move: 50, work: 100, carry: 50, attack: 80, ranged_attack: 150, heal: 250, claim: 600, tough: 10 };

// ---------------------------------------------------------------------------
// ORACLE evaluation — returns problems[] (empty = all oracles held).
// Each entry asserts the actual recorded result matches the oracle table;
// characterizations (NaN, tolerated nulls, RangeError, TypeError) assert the
// ACTUAL observed class of result, never a desired outcome.
// ---------------------------------------------------------------------------

function capErr(c) { return c && !c.ok ? `${c.n}: ${c.m}` : JSON.stringify(c); }
function v(c) { return c && c.ok ? c.v : undefined; }

function oracleOrd01(ord, ctx) {
    const bad = [];
    const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
    const a = ord.a, b = ord.b, c = ord.c;
    if (!a || !b || !c) { bad.push(`missing phases a=${!!a} b=${!!b} c=${!!c}`); return bad; }
    const S2 = ctx.s2;
    ctx.characterizations = ctx.characterizations || [];

    eq('apply1 id', v(a.a1), 'ord1src');
    eq('apply2 id (stable, no dup)', v(a.a2), 'ord1src');
    eq('reapply resource', v(a.res), { id: 'ord1src', sid: S2, an: 'ord1src', inst: true });
    eq('annotated count after reapply', a.cnt, 1);
    eq('creepOrder apply id', v(a.co1), 'ord1co');
    eq('creepOrder reapply id', v(a.co2), 'ord1co');
    const coA = v(a.coA) || {};
    for (const [k, want] of [['st', 'active'], ['cn', 'ordcreep'], ['ex', 12345], ['pr', 9]]) {
        if (coA[k] !== want) bad.push(`state across spec change: ${k}=${JSON.stringify(coA[k])} want ${JSON.stringify(want)}`);
    }

    // Variants vs oracle table
    if (!a.un.ok || !/^source_\d+_\d+$/.test(a.un.v || '')) {
        bad.push(`unannotated id: ${JSON.stringify(a.un)} (want generated source_<time>_<n>)`);
    }
    if (!a.uk1.ok) bad.push(`unknown type first apply threw: ${capErr(a.uk1)}`);
    else if (!/^mystery_\d+_\d+$/.test(a.uk1.v || '')) bad.push(`unknown type first apply id: ${a.uk1.v}`);
    // repeat apply on unknown type: recorded error class, no support guarantee
    if (a.uk2.ok) ctx.characterizations.push(`unknown-type repeat apply SUCCEEDED: ${a.uk2.v}`);
    else ctx.characterizations.push(`unknown-type repeat apply threw ${capErr(a.uk2)} — stored plain object lacks matchesAnnotation`);
    if (a.ex.ok) bad.push('extra field accepted (oracle: constructor rejects)');
    else ctx.characterizations.push(`extra field rejected: ${capErr(a.ex)}`);
    if (a.wt.ok) bad.push('wrong schema type accepted (oracle: constructor rejects)');
    else ctx.characterizations.push(`wrong type rejected: ${capErr(a.wt)}`);
    // missing + null scalar: source-tolerated (characterize, not desirable)
    if (!a.mi.ok) bad.push(`missing field threw ${capErr(a.mi)} (schema tolerates missing in source)`);
    else {
        const st = v(a.mis) || {};
        if (st.sidUndef !== true) bad.push(`missing-field resource kept a defined sourceId: ${JSON.stringify(st)}`);
        ctx.characterizations.push(`missing field tolerated: resource ${a.mi.v} created; sourceId=${st.hasProp ? 'own prop set to undefined' : 'absent'}`);
    }
    if (!a.ns.ok) bad.push(`null scalar threw ${capErr(a.ns)} (schema tolerates null scalar in source)`);
    else {
        const st = v(a.nss) || {};
        if (st.null !== true) bad.push(`null-scalar resource sourceIdIsNull=${st.null}`);
        ctx.characterizations.push(`null scalar field tolerated: resource ${a.ns.v} created with sourceId=null`);
    }
    // null nested metadata → TypeError at Object.keys(null) (baseline characteristic)
    if (a.nm.ok) bad.push('null nested metadata accepted (oracle: TypeError baseline)');
    else if (a.nm.n !== 'TypeError') bad.push(`null metadata threw ${capErr(a.nm)} (oracle: TypeError at Object.keys(null))`);
    else ctx.characterizations.push(`null metadata → ${capErr(a.nm)}`);

    // CreepOrder.calculateBodyParts boundary oracle
    eq('body below const price', v(a.bp.b), null);
    eq('body at const price', v(a.bp.e), ['move', 'carry', 'work']);
    eq('body const+1 ratio set', v(a.bp.a1), ['move', 'carry', 'work', 'work']);
    eq('body capped by maxCost', v(a.bp.mc), 8); // 200 + 5*100 = 700
    const nc = v(a.nc);
    if (nc === undefined) bad.push(`no-cap body threw: ${capErr(a.nc)}`);
    else {
        if (nc <= 50) bad.push(`no-cap body length ${nc} <= 50 (expected 60 — no MAX_CREEP_SIZE cap)`);
        ctx.characterizations.push(`RISK: calculateBodyParts has no MAX_CREEP_SIZE cap — 6000 energy → ${nc} parts (>50, engine rejects)`);
    }

    // Serialized state proof (toJSON round trip)
    const sv = v(a.sv) || {};
    if (sv.sid !== S2) bad.push(`serialized ord1src.sourceId ${sv.sid} want ${S2}`);

    // Reload across real runtime boundary (cache wiped, fresh require)
    const rl = v(b.rl) || {};
    for (const [k, want] of [['p', true], ['sid', S2], ['inst', true], ['toS', true], ['mA', true], ['sObj', true]]) {
        if (rl[k] !== want) bad.push(`reload ${k}=${JSON.stringify(rl[k])} want ${JSON.stringify(want)}`);
    }
    eq('query by field', b.q, 1);
    const coR = v(b.co) || {};
    for (const [k, want] of [['st', 'active'], ['cn', 'ordcreep'], ['ex', 12345], ['pr', 9], ['inst', true]]) {
        if (coR[k] !== want) bad.push(`reload creepOrder ${k}=${JSON.stringify(coR[k])} want ${JSON.stringify(want)}`);
    }
    eq('reloaded creepOrder body300', coR.b3, ['move', 'carry', 'work', 'work']);
    eq('mystery type loaded count', b.my, 1);
    eq('delete returns true', b.d, true);
    eq('repeat delete returns false', b.d2, false);
    eq('annotated gone after delete', b.ac, 0);
    eq('delete persisted: src absent next runtime', c.sp, false);
    eq('delete persisted: creepOrder kept', c.cp, true);
    return bad;
}

function oracleOrd02(ord, ctx) {
    const bad = [];
    const a = ord.a, b = ord.b, c = ord.c;
    if (!a || !b || !c) { bad.push(`missing phases a=${!!a} b=${!!b} c=${!!c}`); return bad; }
    const S1 = ctx.s1, S2 = ctx.s2;
    const expectPri = (id, off) => Math.floor(parseInt(id.slice(-6), 16) * 100) - off;
    ctx.characterizations = ctx.characterizations || [];

    // Real ids: formula verified probe-side, independently
    for (const [key, id, off] of [['s10', S1, 0], ['s110', S1, 10], ['s20', S2, 0], ['s210', S2, 10]]) {
        const got = v(a.pri[key]);
        if (got !== expectPri(id, off)) bad.push(`priority ${key}: got ${got}, want ${expectPri(id, off)}`);
    }
    // Boundary oracles from the table
    if (v(a.pri.h10) !== 100) bad.push(`priority '000001',0 → ${v(a.pri.h10)} want 100`);
    if (v(a.pri.h110) !== 90) bad.push(`priority '000001',10 → ${v(a.pri.h110)} want 90`);
    if (v(a.pri.h20) !== 200) bad.push(`priority '000002',0 → ${v(a.pri.h20)} want 200`);
    if (!a.pri.inv.nan) bad.push(`priority invalid hex → ${JSON.stringify(a.pri.inv)} (characterize NaN)`);
    else ctx.characterizations.push(`invalid hex id → NaN (not a valid gameplay priority — recorded, not asserted as support)`);
    if (v(a.pri.sh) !== expectPri('ab', 0)) bad.push(`priority short id 'ab' → ${v(a.pri.sh)} want ${expectPri('ab', 0)}`);

    // Sort order vs fixed priorities
    const s = a.sorted || [];
    for (let i = 1; i < s.length; i++) if (s[i - 1] < s[i]) bad.push(`sorted not desc at ${i}: ${s.join(',')}`);
    const wantSorted = [40, 49, 50, 51, 70, 80, 1000, v(a.pri.s10), v(a.pri.s20)].sort((x, y) => y - x);
    if (JSON.stringify(s) !== JSON.stringify(wantSorted)) bad.push(`sorted ${JSON.stringify(s)} want ${JSON.stringify(wantSorted)}`);
    ctx.characterizations.push(`real priorities vs fixed set: s1=${v(a.pri.s10)}, s2=${v(a.pri.s20)} within ${s.join(',')}`);

    // V1 persisted
    if (v(a.sv) !== S1) bad.push(`V1 not persisted: ${JSON.stringify(a.sv)}`);

    const disabledMode = ctx.disabledMode !== 'false';
    const bsv = v(b.sv) || {};
    const cfin = v(c.fin) || {};
    if (disabledMode) {
        // disabled flag set → save() skipped: V2 in-memory change must NOT persist
        if (b.l !== S1) bad.push(`reload phase b: sourceId=${b.l} want ${S1}`);
        if (b.im !== S2) bad.push(`in-mem V2 not applied: ${b.im}`);
        if (bsv.sid !== S1) bad.push(`disabled save entry present (want still ${S1}): ${JSON.stringify(bsv)}`);
        if (b.da !== true) bad.push(`rm.disabled not latched: ${b.da}`);
        ctx.characterizations.push(`disabled input ${JSON.stringify(bsv.dis)} (mode ${ctx.disabledMode}) treated as disable`);
        // false + load old Memory: V1 resources re-saved, V2 lost
        if (c.l !== S1) bad.push(`reload after disabled: sourceId=${c.l} want ${S1} (in-mem V2 must be lost)`);
        if (cfin.sid !== S1) bad.push(`final resources sourceId=${cfin.sid} want ${S1}`);
        if (c.da !== false) bad.push(`rm.disabled not cleared on re-enable: ${c.da}`);
    } else {
        // control: disabled=false → save writes V2 normally
        if (bsv.sid !== S2) bad.push(`control save did not persist V2: ${JSON.stringify(bsv)}`);
        if (c.l !== S2) bad.push(`control reload sourceId=${c.l} want ${S2}`);
        if (cfin.sid !== S2) bad.push(`control final sourceId=${cfin.sid} want ${S2}`);
    }
    return bad;
}

function oracleOrd03(ord, ctx) {
    const bad = [];
    const a = ord.a, b = ord.b;
    if (!a || !b) { bad.push(`missing phases a=${!!a} b=${!!b}`); return bad; }
    const S1 = ctx.s1;
    const adj1 = ctx.expectedAdj.s1, adj2 = ctx.expectedAdj.s2;
    ctx.characterizations = ctx.characterizations || [];

    if (a.cap !== 3000) bad.push(`S1 capacity ${a.cap} want 3000 (arranged input)`);
    const m1 = v(a.m1) || {};
    if (m1.nw !== 5) bad.push(`SourceManager.needWork ${m1.nw} want 5 (cap 3000)`);
    if (m1.wp !== adj1) bad.push(`S1 workPlaces ${m1.wp} want ${adj1}`);
    if (m1.fp !== adj1) bad.push(`S1 freePlaces ${m1.fp} want ${adj1}`);
    const m2 = v(a.m2) || {};
    if (m2.wp !== adj2) bad.push(`S2 workPlaces ${m2.wp} want ${adj2} (adjacent-walls variant)`);
    if (m2.nw !== Math.ceil(ctx.s2cap / 300 / 2)) bad.push(`S2 needWork ${m2.nw} want ${Math.ceil(ctx.s2cap / 300 / 2)}`);
    ctx.characterizations.push(`workPlaces S1=${adj1} vs S2=${adj2} (terrain-only counting; object occupancy ignored by design)`);

    const d = v(a.d1) || {};
    if (d.tp !== adj1) bad.push(`SourceDesc.totalPlaces ${d.tp} want ${adj1}`);
    if (d.fp !== adj1) bad.push(`SourceDesc.freePlaces ${d.fp} want ${adj1}`);
    if (d.nw !== 5) bad.push(`SourceDesc.needWork ${d.nw} want 5`);
    if (d.src !== S1) bad.push(`SourceDesc.srcId ${d.src} want ${S1}`);
    if (!Number.isFinite(d.tt) || d.tt <= 0) bad.push(`SourceDesc.timeTo ${d.tt} want >0 route cost`);
    else {
        const wantCarry = d.tt * 2 / 50 * (3000 / 300) * 3;
        if (Math.abs((d.nc || 0) - wantCarry) > 1e-9) bad.push(`needCarry ${d.nc} want ${wantCarry}`);
        ctx.characterizations.push(`S1 route cost timeTo=${d.tt} (PathFinder) vs fixture BFS spawnToSourceAdj=${ctx.bfsSpawnToS1} — engine cost, not calibrated to cell count`);
    }
    if (v(a.dc) !== 0) bad.push(`availableCarry (fresh, no work) → ${JSON.stringify(a.dc)} want 0`);
    if (v(a.dz) !== 0) bad.push(`zero-distance availableCarry → ${JSON.stringify(a.dz)} want 0`);
    if (a.du.ok) ctx.characterizations.push('SourceDesc.update() succeeded without costMatrix (deserialize(undefined) tolerated)');
    else ctx.characterizations.push(`SourceDesc.update() without room.memory.costMatrix → ${capErr(a.du)}`);

    const ae = v(a.ae) || {};
    if ('r' in ae && ae.r !== undefined) bad.push(`availableEnergy returned ${ae.r} (getter assigns this.energyAvailable, returns undefined)`);
    ctx.characterizations.push(`SourceManager.availableEnergy getter returns undefined, mutates energyAvailable=${ae.f}`);

    const q = v(a.q) || {};
    if (!q.be || q.be[0] !== adj1 || q.be[1] !== 0) bad.push(`queue before: ${JSON.stringify(q.be)} want [${adj1},0]`);
    if (!q.aa || q.aa[0] !== adj1 - 1 || q.aa[1] !== 2 || q.aa[2] !== 1) {
        bad.push(`queued WORK addCreep: ${JSON.stringify(q.aa)} want [${adj1 - 1},2,1]`);
    }
    if (q.lv !== 1 || q.qq !== 0) bad.push(`queued->living: living=${q.lv} queued=${q.qq} want 1/0`);
    if (q.hw !== 2) bad.push(`hasWork after run (living WORK count): ${q.hw} want 2`);
    if (q.fp !== adj1 - 1) bad.push(`freePlaces after run: ${q.fp} want ${adj1 - 1}`);

    const sv = v(a.sv) || {};
    if (sv.sv !== true || sv.nw !== 5 || sv.wp !== adj1 || sv.src !== S1) {
        bad.push(`mgr.save() entry: ${JSON.stringify(sv)}`);
    }
    if (!Array.isArray(sv.cr) || !sv.cr.includes(ctx.creepName)) {
        bad.push(`mgr.save() creepOwner entry missing living creep: ${JSON.stringify(sv.cr)}`);
    }

    // CreepPlanner matrix vs oracle
    const cp = a.cp || {};
    const expect = {
        'harvester@0': null,
        'harvester@150': { c: 150, p: ['move', 'work'], m: { efficiency: 1, role: 'harvester' } },
        'harvester@300': { c: 250, p: ['move', 'work', 'work'], m: { efficiency: 2, role: 'harvester' } },
        'mule@0': null,
        'mule@150': { c: 150, p: ['carry', 'carry', 'move'], m: { state: 'collect', efficiency: 2, role: 'mule' } },
        'mule@300': { c: 300, p: ['carry', 'carry', 'move', 'carry', 'carry', 'move'], m: { state: 'collect', efficiency: 4, role: 'mule' } },
        'upgrader@0': null, 'upgrader@150': null,
        'upgrader@300': { c: 300, p: ['move', 'carry', 'work', 'work'], m: { state: 'collect', role: 'upgrader' } },
        'repairer@0': null, 'repairer@150': null,
        'repairer@300': { c: 200, p: ['move', 'work', 'carry'], m: { state: 'collect', role: 'repairer' } },
        'builder@0': null, 'builder@150': null,
    };
    for (const [k, want] of Object.entries(expect)) {
        const got = cp[k];
        if (!got || !got.ok || JSON.stringify(got.v) !== JSON.stringify(want)) {
            bad.push(`CreepPlanner ${k}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
        }
    }
    const bld = cp['builder@300'];
    if (!bld || bld.ok) bad.push(`builder@300 returned ${JSON.stringify(bld)} (fractional MOVE ratio — record actual error)`);
    else ctx.characterizations.push(`builder fractional ratio (MOVE:0.5) → ${capErr(bld)} — recorded, not desirable`);

    const ml = v(a.ml) || {};
    if (ml.n === undefined) bad.push(`creepMaxLimit threw: ${capErr(a.ml)}`);
    else if (ml.n <= 50) bad.push(`CreepPlanner max-limit ${ml.n} <= 50 (no explicit 50 cap in dist — risk)`);
    else ctx.characterizations.push(`RISK: CreepPlanner has no MAX_CREEP_SIZE cap — 6000 energy → ${ml.n} parts, cost ${ml.c}`);

    const sc = v(a.sp) || {};
    if (sc.e !== -10) bad.push(`spawnCreep empty body → ${sc.e} want -10 ERR_INVALID_ARGS`);
    if (sc.o !== -10) bad.push(`spawnCreep 51-part body → ${sc.o} want -10 ERR_INVALID_ARGS`);
    if (sc.a !== -6) bad.push(`spawnCreep 50-part body (unaffordable) → ${sc.a} want -6 ERR_NOT_ENOUGH_ENERGY (length accepted, energy rejected)`);
    if (sc.v !== 0) bad.push(`spawnCreep valid 300-cost body dryRun → ${sc.v} want 0 OK`);
    ctx.characterizations.push(`spawnCreep verified separately from planner output: empty=-10, 51=-10, 50(unaffordable)=${sc.a}, valid300=${sc.v}`);

    const ld = v(b.ld) || {};
    // load() restores the SAVED state: freePlaces was 0 after the living
    // harvester was counted (workPlaces stays adj1, needWork stays 5).
    for (const [k, want] of [['nw', 5], ['fp', 0], ['src', S1], ['c', 1], ['q', 0], ['wp', adj1]]) {
        if (ld[k] !== want) bad.push(`mgr load ${k}=${JSON.stringify(ld[k])} want ${JSON.stringify(want)}`);
    }
    return bad;
}

// Per-tick observation from frame memory (ORD-04): reads the REAL persisted
// Memory fields the planners write — no evidence is stored in Memory for this.
function ord04CollectObs(rec, ctx) {
    ctx.obs = ctx.obs || {};
    const mem = rec.memory && rec.memory[ctx.userId];
    if (!mem || !mem.rooms || !mem.rooms[ctx.room]) return;
    const rm = mem.rooms[ctx.room];
    const sd = rm.srcDescs && rm.srcDescs[ctx.s1];
    ctx.obs[rec.gameTime] = {
        economy: rm.economy === undefined ? null : JSON.stringify(rm.economy),
        marker: sd ? sd.marker || null : 'absent',
        sdKeys: rm.srcDescs ? Object.keys(rm.srcDescs).length : 0,
        sdFree: sd ? sd.freePlaces : null,
        spawnMules: rm.spawnMules, storeMules: rm.storeMules, upgradeMules: rm.upgradeMules,
        dst: mem.creeps && mem.creeps[ctx.creepName] && mem.creeps[ctx.creepName].dst,
    };
}

function oracleOrd04(ord, ctx) {
    const bad = [];
    ctx.characterizations = ctx.characterizations || [];
    const req = ord.req || {};
    // require-time interface errors (recorded, not false guarantees)
    if (req.pp && req.pp.ok) bad.push('room.pathPlanner required cleanly (expected ReferenceError: exports assignMule but defines assignPath)');
    else ctx.characterizations.push(`require('room.pathPlanner') → ${capErr(req.pp)}`);
    if (!req.sp || !req.sp.ok) bad.push(`require('SpawnPlanner') → ${capErr(req.sp)}`);
    if (!req.ep || !req.ep.ok) bad.push(`require('EconomyPlanner') → ${capErr(req.ep)}`);
    if (!req.hp || !req.hp.ok) bad.push(`require('room.harvestPlanner') → ${capErr(req.hp)}`);
    if (!req.cp || !req.cp.ok) bad.push(`require('room.consumptionPlanner') → ${capErr(req.cp)}`);

    const A = ord.abs || {};
    for (const k of ['ml', 'ms', 'mn', 'cn', 'cen', 'cd', 'crt', 'pae', 'per', 'prt', 'pcn']) {
        const r = A[k];
        if (!r || r.ok || !/Implementation needed/.test(r.m || '')) {
            bad.push(`abstract ${k}: ${JSON.stringify(r)} want Error 'Implementation needed'`);
        }
    }
    for (const k of ['mc', 'cpd', 'pct']) {
        if (!A[k] || !A[k].ok) bad.push(`abstract ${k} threw: ${capErr(A[k])} (expected no-op/ok)`);
    }
    ctx.characterizations.push(`ProducerMixin(Consumer).energyAvailable → ${JSON.stringify(v(A.pmx))}`);

    // aggregated per-tick call errors (entrypoint side)
    const er = ord.er || {};
    if (!er.sp) bad.push('SpawnPlanner.run() never threw (expected roles.keys TypeError every tick)');
    else {
        if (!/keys/.test(er.sp.m || '') && er.sp.n !== 'TypeError') {
            bad.push(`SpawnPlanner threw ${er.sp.n}: ${er.sp.m} (expected roles.keys TypeError)`);
        }
        ctx.characterizations.push(`SpawnPlanner.run threw ${er.sp.n} "${er.sp.m}" on ${er.sp.c} ticks (${er.sp.ft}..${er.sp.lt})`);
    }
    for (const nm of ['eco', 'hp', 'cmp']) {
        if (er[nm]) ctx.characterizations.push(`${nm} threw ${er[nm].n} "${er[nm].m}" on ${er[nm].c} ticks (${er[nm].ft}..${er[nm].lt})`);
    }

    // costMatrix written by harvestPlanner exactly at Game.time%100==1
    // (user ticks 1 and 101 — user code sees gameTime = frame.gameTime - 1).
    // Each write is observed (len recorded) then deleted, so a SECOND record
    // at t=101 proves the periodic refire against non-firing ticks 2..100.
    const cm = ord.cm || [];
    const cmTicks = cm.map(x => x.t);
    if (JSON.stringify(cmTicks) !== JSON.stringify([1, 101])) {
        bad.push(`costMatrix observations at ticks ${cmTicks.join(',')} want [1,101] (harvestPlanner %100==1)`);
    } else {
        ctx.characterizations.push(`costMatrix serialized writes at ticks 1 & 101 (len ${cm[0].len}/${cm[1].len}) — periodic firing proven`);
    }

    // per-tick effects from frame memory (collected by ord04CollectObs).
    // obs key = frame gameTime = user Game.time + 1.
    const obs = ctx.obs || {};
    const ticks = Object.keys(obs).map(Number).sort((x, y) => x - y);
    const last = ticks[ticks.length - 1];
    for (const t of ticks) {
        const o = obs[t];
        if (t < 2) continue;
        if (o.economy !== '{}') bad.push(`tick ${t}: economy field ${JSON.stringify(o.economy)} want '{}' (baseline: total never stored)`);
        // harvestPlanner fired at user tick 1: seeded marker gone, both real
        // source descriptors written (seed covered S1 only).
        if (o.marker !== null && o.marker !== undefined && o.marker !== 'absent' && o.marker !== 'SEED') {
            bad.push(`tick ${t}: unexpected srcDescs marker ${JSON.stringify(o.marker)}`);
        }
        if (o.marker === 'SEED') bad.push(`tick ${t}: seeded srcDescs marker survived — harvestPlanner did not rewrite`);
        if (o.sdKeys !== 2) bad.push(`tick ${t}: srcDescs has ${o.sdKeys} entries, want 2 (seed covered S1 only — 2 proves planner write)`);
        // consumptionPlanner gate: dst/mule counters transition at %50==1.
        if (t >= 2 && t <= 51) {
            if (o.dst !== 'spawn' || o.spawnMules !== 1) bad.push(`tick ${t}: ${JSON.stringify(o)} want dst='spawn' spawnMules=1 (fired at user tick 1)`);
        } else if (t >= 52 && t <= 101) {
            if (o.dst !== 'cont' || o.upgradeMules !== 1 || o.spawnMules !== 0) bad.push(`tick ${t}: ${JSON.stringify(o)} want dst='cont' upgradeMules=1 (fired at user tick 51)`);
        } else if (t >= 102) {
            if (o.dst !== 'spawn' || o.spawnMules !== 1 || o.upgradeMules !== 0) bad.push(`tick ${t}: ${JSON.stringify(o)} want dst='spawn' spawnMules=1 upgradeMules=0 (fired at user tick 101)`);
        }
    }
    if (last < 102) bad.push(`observation ended at tick ${last} < 102 — %100==1 boundary not reached`);
    ctx.characterizations.push(`ticks observed ${ticks[0]}..${last}; consumption fired at user ticks 1,51,101; harvest at 1,101`);

    // flags preserved (seeded input must be untouched by dormant planners)
    if (!ord.flagsAtEnd || ord.flagsAtEnd.f1 !== true) {
        bad.push(`seeded Memory.flags lost: ${JSON.stringify(ord.flagsAtEnd)}`);
    }
    return bad;
}

function oracleOrd04Api(ord, ctx) {
    const bad = [];
    const a = ord.a, b = ord.b;
    if (!a || !b) { bad.push(`missing phases a=${!!a} b=${!!b}`); return bad; }
    ctx.characterizations = ctx.characterizations || [];
    const mfo = v(a.mfo) || {};
    if (mfo.is !== true || mfo.a !== 1 || mfo.b !== 2) bad.push(`Map.fromObject: ${JSON.stringify(mfo)}`);
    const mto = v(a.mto) || {};
    if (mto.x !== 5 || mto.y !== 6) bad.push(`Map.toObject: ${JSON.stringify(mto)}`);
    const gr = v(a.gr) || {};
    if (gr.t !== 'object') {
        bad.push(`global 'result' not polluted after Map.toObject: ${JSON.stringify(gr)}`);
    } else {
        ctx.characterizations.push(`DEVIATION: mapPatch Map.prototype.toObject leaks global 'result' (no var decl): ${JSON.stringify(gr.v)}`);
    }
    const mf = v(a.mf) || {};
    // DEVIATION: Map.prototype.filter's predicate receives [k,v] ENTRIES
    // (Array.from(this).filter(pred)) — a value-style predicate drops all.
    if (mf.valPred !== 0) bad.push(`Map.filter value-predicate kept ${mf.valPred} (deviation: entries reach predicate)`);
    else ctx.characterizations.push(`DEVIATION: Map.filter predicate receives [k,v] entries — value-style predicate yields empty map; entry-style works (${mf.entryPred} kept)`);
    if (mf.entryPred !== 1 || mf.entryHasX !== true) bad.push(`Map.filter entry-predicate: ${JSON.stringify(mf)}`);

    // Array.prototype.flat — patched implementation deviates from the API
    if (a.fe.ok) ctx.characterizations.push(`[].flat() returned ${JSON.stringify(a.fe.v)} — patched impl uses reduce w/o initial value, empty did NOT throw here`);
    else ctx.characterizations.push(`DEVIATION: [].flat() → ${capErr(a.fe)} (native returns []; reduce has no initial value)`);
    if (JSON.stringify(v(a.f0)) !== JSON.stringify([1, 2])) {
        ctx.characterizations.push(`flat(0) → ${JSON.stringify(v(a.f0))} (native returns copy unflattened)`);
    } else {
        ctx.characterizations.push(`DEVIATION: [[1],[2]].flat(0) → [1,2] (native flat(0) returns copy unflattened)`);
    }
    if (JSON.stringify(v(a.f1)) !== JSON.stringify([1, 2, 3])) bad.push(`flat() depth1: ${JSON.stringify(v(a.f1))} want [1,2,3]`);
    if (JSON.stringify(v(a.f2)) !== JSON.stringify([1, 2, 3])) bad.push(`flat(2): ${JSON.stringify(v(a.f2))}`);
    ctx.characterizations.push(`[[[1],[2]]].flat() → ${JSON.stringify(v(a.fn1))}; .flat(2) → ${JSON.stringify(v(a.fn2))}`);
    if (v(a.fnat) !== false) bad.push('Array.prototype.flat appears native — patch not applied?');

    const lg = a.lg || {};
    if (lg.i !== 'trace') bad.push(`logger initial level ${lg.i}`);
    if (lg.w !== 'warn') bad.push(`setLevel('warn') → ${lg.w}`);
    if (lg.b !== 'warn') bad.push(`setLevel('bogus') changed level to ${lg.b} (invalid input ignored, console.log only)`);
    if (lg.st !== 'trace') {
        bad.push(`Memory.loggerState after setLevel('warn'): ${lg.st} — setLevel does not persist`);
    } else {
        ctx.characterizations.push(`setLevel does NOT write Memory.loggerState (stayed 'trace' after setLevel('warn')) — level lost on reload unless saved externally`);
    }
    // logger singleton survives via runner module cache (not Memory) — record
    // actual pre-load level; load() must then restore from Memory.loggerState.
    ctx.characterizations.push(`tick2 logger level before load(): '${b.lb}' — module cache persists across ticks (Memory.loggerState not involved)`);
    if (b.la !== 'error') bad.push(`logger.load() did not restore persisted level: ${b.la}`);
    ctx.characterizations.push(`global 'result' type on tick2: ${JSON.stringify(v(b.gr2))}`);
    return bad;
}

// ---------------------------------------------------------------------------
// Mode table
// ---------------------------------------------------------------------------

const MODES = {
    'ord-01': {
        ports: [32380, 32381], scenario: 'ORD-01', maxSteps: 8, creep: false,
        build: (ctx) => ord01Entrypoint(ctx),
        oracle: oracleOrd01,
        ctxFromFx: (fx) => ({ s1: fx.actual.source1.id, s2: fx.actual.source2.id, room: fx.room }),
    },
    'ord-02-true': {
        ports: [32382, 32383], scenario: 'ORD-02', maxSteps: 8, creep: false,
        build: (ctx) => ord02Entrypoint(ctx, 'true'),
        oracle: oracleOrd02,
        ctxFromFx: (fx) => ({ s1: fx.actual.source1.id, s2: fx.actual.source2.id, room: fx.room, disabledMode: 'true' }),
    },
    'ord-02-strtrue': {
        ports: [32384, 32385], scenario: 'ORD-02', maxSteps: 8, creep: false,
        build: (ctx) => ord02Entrypoint(ctx, 'strtrue'),
        oracle: oracleOrd02,
        ctxFromFx: (fx) => ({ s1: fx.actual.source1.id, s2: fx.actual.source2.id, room: fx.room, disabledMode: 'strtrue' }),
    },
    'ord-02-false': {
        ports: [32386, 32387], scenario: 'ORD-02', maxSteps: 8, creep: false,
        build: (ctx) => ord02Entrypoint(ctx, 'false'),
        oracle: oracleOrd02,
        ctxFromFx: (fx) => ({ s1: fx.actual.source1.id, s2: fx.actual.source2.id, room: fx.room, disabledMode: 'false' }),
    },
    'ord-03': {
        ports: [32388, 32389], scenario: 'ORD-03', maxSteps: 6, creep: true,
        build: (ctx) => ord03Entrypoint(ctx),
        oracle: oracleOrd03,
        ctxFromFx: (fx) => ({ s1: fx.actual.source1.id, s2: fx.actual.source2.id, room: fx.room }),
        // ORD-03 arranges S1 to fixed capacity 3000 (spec input) — DB write +
        // fixture record patch so validation still proves the arranged state.
        arrangeExtra: async (h, fx, ctx, journal) => {
            await h.dbUpdate('rooms.objects', { _id: fx.actual.source1.id }, { energy: 3000, energyCapacity: 3000 });
            journal.add('source', fx.actual.source1.id, 'update', { energy: 3000, energyCapacity: 3000, arranged: true });
            fx.actual.source1.energy = 3000;
            fx.actual.source1.energyCapacity = 3000;
            ctx.expectedAdj = {
                s1: await adjacentFreeCells(h, fx.room, fx.actual.source1),
                s2: await adjacentFreeCells(h, fx.room, fx.actual.source2),
            };
            ctx.s2cap = fx.actual.source2.energyCapacity;
            ctx.bfsSpawnToS1 = fx.distances.spawnToSourceAdj;
            journal.add('env', 'terrain-adjacency', 'measure', ctx.expectedAdj);
        },
    },
    'ord-04': {
        ports: [32390, 32391], scenario: 'ORD-04', maxSteps: 105, creep: true,
        build: (ctx) => ord04Entrypoint(ctx),
        oracle: oracleOrd04,
        collectObs: ord04CollectObs,
        ctxFromFx: (fx) => ({ s1: fx.actual.source1.id, room: fx.room }),
    },
    'ord-04-api-dist': {
        ports: [32392, 32393], scenario: 'ORD-04-API-DIST', maxSteps: 4, creep: false,
        build: (ctx) => ord04ApiEntrypoint(ctx, 'dist'),
        oracle: oracleOrd04Api,
        ctxFromFx: (fx) => ({ room: fx.room }),
    },
    'ord-04-api-dist2': {
        ports: [32394, 32395], scenario: 'ORD-04-API-DIST2', maxSteps: 4, creep: false,
        build: (ctx) => ord04ApiEntrypoint(ctx, 'dist2'),
        oracle: oracleOrd04Api,
        ctxFromFx: (fx) => ({ room: fx.room }),
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
    spec.expectCreep = def.creep;

    const res = await runScenario({
        runId, scenarioId: def.scenario, seedId,
        ports: { http: httpPort, cli: cliPort },
        fixtureSpec: spec,
        budgets: { maxSteps: MAX_STEPS || def.maxSteps, WcaseMs: WCASE_MS },
        arrange: async (h, fx, journal) => {
            // ctx carries resolved real ids into the entrypoint + oracle.
            const epCtx = Object.assign({ creepName: fx.spec.creep.name }, def.ctxFromFx(fx));
            const { modules, hashes } = def.build(epCtx);
            const ctx = await arrangeBase(h, fx, journal, MODE, { modules, withCreep: def.creep });
            Object.assign(ctx, epCtx);
            ctx.moduleHashes = hashes;
            if (def.arrangeExtra) await def.arrangeExtra(h, fx, ctx, journal);
            return ctx;
        },
        supplemental,
        perTickCheck: makeTickCheck(def.oracle, def.collectObs),
        postcondition: donePostcondition,
    });

    // Persist oracle outcome + characterizations for the report.
    try {
        fs.writeFileSync(path.join(res.runDir, 'oracle.json'), JSON.stringify({
            mode: MODE, runId, verdict: res.verdict, verdictReason: res.verdictReason,
            oracleFailures: res.ctx && res.ctx.oracleResult || null,
            characterizations: res.ctx && res.ctx.characterizations || [],
        }, null, 2), { mode: 0o600 });
    } catch {}
    process.exitCode = VERDICT_EXIT[res.verdict] !== undefined ? VERDICT_EXIT[res.verdict] : 3;
}

main().catch(e => { console.error(e); process.exitCode = 3; });
