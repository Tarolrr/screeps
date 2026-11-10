'use strict';
// STRAT oracles: pure functions over runner results (frames + aux).
//
// Object ids are instance-specific (every disposable instance generates its
// own ids for the spawn, creeps, drops, ...), so cross-run comparison first
// maps every id to a symbolic label derived from stable properties:
//   spawn/controller/sources/mineral  -> $spawn, $controller, $source1/2, $mineral
//   creeps                            -> $creep:<name>
//   other objects                     -> $<type>@x,y@<first gameTime seen>
//   user id                           -> $user
// dist2 generated resource ids `<type>_<Game.time>_<heap counter>` are
// normalised to `<type>_<Game.time>_*`: the heap counter restarts after every
// global reset (dist2/resourceManager.js generateResourceId), which is a
// legacy id-generation artefact, not a duplicate. Two resources created in the
// same tick would collide on the normalised key and are reported separately
// (`idCounterCollision`), never hidden.

// Exactly the namespaces owned by the new system (stateLayout / CONTRACTS-A §5).
// Any other key that merely starts with "strategy" is foreign to both systems:
// it stays inside the legacy comparison AND is reported as a stray key (FAIL).
// strategyView: operator-only flags namespace (contract A.5), written by the operator/seed, never by components.
const STRATEGY_NAMESPACES = Object.freeze(['strategy', 'strategyShadow', 'strategyMigration', 'strategyView']);
const isStrategyKey = k => STRATEGY_NAMESPACES.includes(k);
const strayStrategyKeys = mem => (mem && typeof mem === 'object' ? Object.keys(mem).filter(k => /^strategy/i.test(k) && !isStrategyKey(k)).sort() : []);
const LEGACY_GEN_ID = /\b(source|spawnProcess|creepOrder|constructionOrder)_(\d+)_(\d+)\b/g;

function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
        return o;
    }
    return v;
}
const canon = v => JSON.stringify(sortKeys(v));

function buildIdMap(result) {
    const map = new Map();
    if (result.ctx && result.ctx.userId) map.set(result.ctx.userId, '$user');
    const fx = result.fx;
    if (fx) {
        if (fx.actual.source1 && fx.actual.source1.id) map.set(fx.actual.source1.id, '$source1');
        if (fx.actual.source2 && fx.actual.source2.id) map.set(fx.actual.source2.id, '$source2');
        if (fx.actual.controller && fx.actual.controller.id) map.set(fx.actual.controller.id, '$controller');
    }
    for (const f of result.frames) {
        for (const o of f.objects || []) {
            if (map.has(o.id)) continue;
            let label;
            if (o.type === 'creep') label = `$creep:${o.name}`;
            else if (o.type === 'spawn') label = `$spawn:${o.name || ''}`;
            else if (o.type === 'controller') label = '$controller';
            else if (o.type === 'mineral') label = '$mineral';
            else if (o.type === 'source') label = `$source@${o.x},${o.y}`;
            else label = `$${o.type}@${o.x},${o.y}@${f.gameTime}`;
            map.set(o.id, label);
        }
    }
    return map;
}

function normalizer(map) {
    const ids = [...map.keys()].filter(k => typeof k === 'string' && k.length >= 6).sort((a, b) => b.length - a.length);
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = ids.length ? new RegExp(ids.map(esc).join('|'), 'g') : null;
    return function normalize(v) {
        if (v === undefined) return undefined;
        let s = JSON.stringify(v);
        if (re) s = s.replace(re, m => map.get(m));
        s = s.replace(LEGACY_GEN_ID, (m, t, time) => `${t}_${time}_*`);
        return JSON.parse(s);
    };
}

function legacyMemory(mem) {
    if (!mem || typeof mem !== 'object') return mem;
    const out = {};
    for (const k of Object.keys(mem)) if (!isStrategyKey(k)) out[k] = mem[k];
    return out;
}

// Deep diff -> [{path, a, b}] with FULL values (masking compares them);
// reportDiffs() truncates for reports. No per-tick cap: the limit only guards
// against pathological sizes and is flagged (`truncated`) when reached.
const DIFF_LIMIT = 100000;
function deepDiff(a, b, p = '', out = [], limit = DIFF_LIMIT) {
    if (out.length >= limit) { out.truncated = true; return out; }
    const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
    const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
    if (ta !== tb) { out.push({ path: p || '/', a, b }); return out; }
    if (ta === 'object' || ta === 'array') {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of [...keys].sort()) {
            if (!(k in a)) out.push({ path: `${p}/${k}`, a: ABSENT, b: b[k] });
            else if (!(k in b)) out.push({ path: `${p}/${k}`, a: a[k], b: ABSENT });
            else deepDiff(a[k], b[k], `${p}/${k}`, out, limit);
        }
        return out;
    }
    if (a !== b) out.push({ path: p || '/', a, b });
    return out;
}
const ABSENT = '<absent>';
function reportDiffs(diffs, n = 20) { return diffs.slice(0, n).map(d => ({ path: d.path, a: trunc(d.a), b: trunc(d.b) })); }
// Value at a deepDiff path ('/a/b'); ABSENT when missing.
function valueAt(v, p) {
    if (p === '/' || p === '') return v;
    for (const k of p.split('/').slice(1)) {
        if (!v || typeof v !== 'object' || !(k in v)) return ABSENT;
        v = v[k];
    }
    return v;
}
function trunc(v) { const s = JSON.stringify(v); return s && s.length > 160 ? s.slice(0, 160) + '…' : v; }

// Structure = key paths + leaf types (arrays: element structures merged).
function structure(v) {
    if (Array.isArray(v)) {
        const el = {};
        for (const x of v) Object.assign(el, flattenStruct(structure(x)));
        return { '[]': el };
    }
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v).sort()) o[k] = structure(v[k]);
        return o;
    }
    return v === null ? 'null' : typeof v;
}
function flattenStruct(s) { return (s && typeof s === 'object') ? s : { '<leaf>': s }; }

// Resource summary by type -> sorted [{id, status, role, annotation, creepName, orderId}]
function resourceSummary(mem) {
    const out = {};
    const res = mem && mem.resourceManager && mem.resourceManager.resources;
    if (!res) return null;
    for (const type of Object.keys(res).sort()) {
        out[type] = Object.keys(res[type]).sort().map(id => {
            const r = res[type][id] || {};
            return { id, status: r.status, role: r.role, annotation: r.metadata && r.metadata.annotation, creepName: r.creepName, orderId: r.orderId };
        });
    }
    return out;
}

// Same-tick id-counter collisions after normalisation (two raw ids -> one key).
function idCounterCollisions(mem) {
    const res = mem && mem.resourceManager && mem.resourceManager.resources;
    const out = [];
    if (!res) return out;
    for (const type of Object.keys(res)) {
        const seen = new Map();
        for (const id of Object.keys(res[type])) {
            const k = id.replace(LEGACY_GEN_ID, (m, t, time) => `${t}_${time}_*`);
            if (seen.has(k) && k !== id) out.push({ type, ids: [seen.get(k), id] });
            seen.set(k, id);
        }
    }
    return out;
}

// Duplication invariants inside one Memory (legacy orders / spawn processes).
function duplicationProblems(mem) {
    const problems = [];
    const res = mem && mem.resourceManager && mem.resourceManager.resources;
    if (!res) return problems;
    const ann = new Map();
    for (const [id, o] of Object.entries(res.creepOrder || {})) {
        const a = o && o.metadata && o.metadata.annotation;
        if (!a) continue;
        if (ann.has(a)) problems.push(`creepOrder annotation ${a} duplicated (${ann.get(a)}, ${id})`);
        ann.set(a, id);
    }
    const byOrder = new Map(), bySpawn = new Map();
    for (const [id, p] of Object.entries(res.spawnProcess || {})) {
        if (!p) continue;
        if (byOrder.has(p.orderId)) problems.push(`spawnProcess for order ${p.orderId} duplicated (${byOrder.get(p.orderId)}, ${id})`);
        byOrder.set(p.orderId, id);
        if (p.status === 'spawning') {
            if (bySpawn.has(p.spawnId)) problems.push(`two spawning processes on spawn ${p.spawnId} (${bySpawn.get(p.spawnId)}, ${id})`);
            bySpawn.set(p.spawnId, id);
        }
    }
    for (const c of idCounterCollisions(mem)) problems.push(`same-tick id collision ${c.type}: ${c.ids.join(', ')}`);
    return problems;
}

// Heuristic scan for serialised Game objects in Memory: a Room (has `name` +
// `energyAvailable`), a RoomObject (`pos` RoomPosition-like + `room` object),
// a structure (`structureType` + `hits` + `id`) or a creep (`body` + `ticksToLive`).
function gameRefs(mem) {
    const hits = [];
    (function walk(v, p) {
        if (hits.length > 50 || !v || typeof v !== 'object') return;
        if (!Array.isArray(v)) {
            const k = Object.keys(v);
            const has = x => k.includes(x);
            if ((has('room') && v.room && typeof v.room === 'object') ||
                (has('energyAvailable') && has('name')) ||
                (has('structureType') && has('hits') && has('id')) ||
                (has('body') && has('ticksToLive')) ||
                (has('pos') && v.pos && typeof v.pos === 'object' && 'roomName' in v.pos && (has('id') || has('name')))) {
                hits.push(p || '/');
                return;
            }
        }
        for (const key of Object.keys(v)) walk(v[key], `${p}/${key}`);
    })(mem, '');
    return hits;
}

// Per-tick object comparison uses the FULL raw rooms.objects row (every
// engine field: user, store/storeCapacity*, hits, spawning, fatigue, ageTime,
// cooldown, controller level/progress/safeMode/safeModeAvailable/
// downgradeTime/reservation/upgradeBlocked, source energy/regeneration,
// actionLog, ...) minus Loki bookkeeping (`_id` -> label, `meta`, `$loki`).
// Instance ids inside values are normalised to labels.
const OBJ_BOOKKEEPING = ['_id', 'id', 'meta', '$loki'];
function objState(o) {
    const s = {};
    for (const k of Object.keys(o)) if (!OBJ_BOOKKEEPING.includes(k)) s[k] = o[k];
    return s;
}

function frameObjects(frame, norm) {
    const out = {};
    for (const o of frame.rawObjects || frame.objects || []) {
        const n = norm({ id: o._id || o.id });
        out[n.id] = norm(objState(o));
    }
    return out;
}

function actionTypes(objs) {
    const out = {};
    for (const [label, s] of Object.entries(objs)) {
        const keys = s.actionLog ? Object.keys(s.actionLog).filter(k => s.actionLog[k] !== null && s.actionLog[k] !== undefined).sort() : [];
        if (keys.length) out[label] = keys;
    }
    return out;
}

// Creeps that appear during the run (spawned by legacy), with first frame.
function spawnedCreeps(result, preNames) {
    const seen = new Map();
    const memOf = f => f.memory && result.ctx && f.memory[result.ctx.userId];
    for (const f of result.frames) {
        for (const o of f.objects || []) {
            if (o.type !== 'creep' || preNames.has(o.name) || seen.has(o.name)) continue;
            const mem = memOf(f);
            seen.set(o.name, { name: o.name, body: (o.body || []).map(b => b.type), firstGameTime: f.gameTime,
                role: mem && mem.creeps && mem.creeps[o.name] ? mem.creeps[o.name].role : null });
        }
    }
    return [...seen.values()].sort((a, b) => a.firstGameTime - b.firstGameTime || a.name.localeCompare(b.name));
}

// Console analysis over aux records.
const INIT_RE = /Initializing game state/;
const INIT_DONE_RE = /Initialization complete/;
const ERROR_RE = /\[ERROR\]|Error in main loop|\[strategy\] ERROR|LEGACY_INIT_FAULT|TICK_RUNNER_FAULT|APP_CREATE_FAULT/;
function consoleSummary(result) {
    const inits = [], initDone = [], errorLines = [], uncaught = [], strategyLines = [];
    let messages = 0, lines = 0, maxSeq = 0;
    for (const a of result.aux) {
        for (const m of a.console || []) {
            messages++; maxSeq = Math.max(maxSeq, m.seq || 0);
            if (m.error) uncaught.push({ stepIndex: a.stepIndex, error: m.error.slice(0, 300) });
            for (const l of m.lines || []) {
                lines++;
                if (INIT_RE.test(l)) inits.push(a.stepIndex);
                if (INIT_DONE_RE.test(l)) initDone.push(a.stepIndex);
                if (ERROR_RE.test(l)) errorLines.push({ stepIndex: a.stepIndex, line: l.slice(0, 300) });
                if (/^\[strategy\]/.test(l)) strategyLines.push({ stepIndex: a.stepIndex, line: l.slice(0, 300) });
            }
        }
    }
    const steps = result.aux.filter(a => a.stepIndex > 0).length;
    // Gap/attribution detection: the runner publishes one console message per
    // user tick; the collector numbers them. Evidence is complete only when
    // every post-step drain holds exactly one message, the pre-step drain none,
    // and the sequence numbers are 1..steps without gaps.
    const perStep = result.aux.map(a => ({ stepIndex: a.stepIndex, n: (a.console || []).length }));
    const seqs = [];
    for (const a of result.aux) for (const m of a.console || []) seqs.push(m.seq);
    const seqContiguous = seqs.every((s, i) => s === i + 1);
    const badSteps = perStep.filter(x => (x.stepIndex === 0 ? x.n !== 0 : x.n !== 1)).map(x => `${x.stepIndex}:${x.n}`);
    const complete = messages === steps && seqContiguous && badSteps.length === 0;
    return { messages, lines, steps, maxSeq, inits, initDone, errorLines, uncaught, strategyLines, seqContiguous, badSteps, complete };
}

function notificationErrors(result) {
    const out = [];
    for (const a of result.aux) for (const n of (Array.isArray(a.notifications) ? a.notifications : [])) if (n.type === 'error') out.push({ stepIndex: a.stepIndex, message: String(n.message || '').slice(0, 300) });
    return out;
}

// Raw room event log of the processing of tick (gameTime-1): parsed + normalised.
function eventLogs(result, norm) {
    return result.aux.map(a => {
        let parsed = null, err = null;
        try { parsed = a.eventLogRaw === null || a.eventLogRaw === undefined ? null : JSON.parse(a.eventLogRaw); } catch (e) { err = e.message; }
        return { stepIndex: a.stepIndex, gameTime: a.gameTime, events: parsed === null ? null : norm(parsed), parseError: err };
    });
}

module.exports = {
    STRATEGY_NAMESPACES, isStrategyKey, strayStrategyKeys, reportDiffs, valueAt, ABSENT, canon, sortKeys, buildIdMap, normalizer, legacyMemory, deepDiff, structure, resourceSummary,
    idCounterCollisions, duplicationProblems, gameRefs, objState, frameObjects, actionTypes, spawnedCreeps,
    consoleSummary, notificationErrors, eventLogs,
};
