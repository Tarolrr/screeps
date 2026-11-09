'use strict';
// STRAT suite: isolated-runtime checks of the bundled strategy artifact
// (build/strategy/main.js + manifest.json) against the legacy flat dist2
// upload, on fresh disposable instances only (e2e/server/instance.js).
//
//   node e2e/strat/strat.js --mode load|reset|legacy-eq|shadow-noop
//        [--artifact build/strategy/main.js] [--manifest build/strategy/manifest.json]
//        [--steps 100] [--port-base 32520] [--resets 5,10,37,100]
//        [--seed-memory FILE] [--expect-strategy] [--expect-shadow] [--wcase-ms N]
//
// Each mode runs its instances sequentially; instance k uses HTTP port
// port-base+2k and CLI port port-base+2k+1 (load: 1 instance, legacy-eq: 2,
// shadow-noop: 3, reset: 4). Allowed range for this suite: 32520-32539.
// Verdicts (exit code): PASS 0, FAIL 1, BLOCKED 2, UNKNOWN 3. Any technical
// failure, lost ack, incoherent snapshot, lost console evidence that an oracle
// needs, or incomplete cleanup is UNKNOWN — never PASS.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { runInstance, sha256 } = require('./runner');
const O = require('./oracles');

const REPO = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(__dirname, '.runs');
const SEED_DB = path.join(require('os').homedir(), 'screeps/node_modules/@screeps/launcher/init_dist/db.json');
const VERDICT_EXIT = { PASS: 0, FAIL: 1, BLOCKED: 2, UNKNOWN: 3 };
const PORT_MIN = 32520, PORT_MAX = 32539;

function arg(name, dflt) {
    const i = process.argv.indexOf('--' + name);
    if (i === -1) return dflt;
    const v = process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
}
const MODE = arg('mode', '');
const ARTIFACT = path.resolve(arg('artifact', path.join(REPO, 'build/strategy/main.js')));
const MANIFEST = path.resolve(arg('manifest', path.join(REPO, 'build/strategy/manifest.json')));
const STEPS = Number(arg('steps', 100));
const PORT_BASE = Number(arg('port-base', 32520));
const RESETS = String(arg('resets', '5,10,37,100')).split(',').map(Number).filter(Number.isInteger);
const SEED_MEMORY = arg('seed-memory', null);
const EXPECT_SHADOW = arg('expect-shadow', false) === true;
// --expect-shadow implies --expect-strategy (shadow state lives beside Memory.strategy).
const EXPECT_STRATEGY = EXPECT_SHADOW || arg('expect-strategy', false) === true;
const WCASE_MS = Number(arg('wcase-ms', 1200000));

function attachLog(runDir) {
    const logFile = path.join(runDir, 'run.log');
    for (const name of ['log', 'error', 'warn', 'info']) {
        const orig = console[name].bind(console);
        console[name] = (...args) => {
            const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
            try { fs.appendFileSync(logFile, line + '\n', { mode: 0o600 }); } catch {}
            orig(...args);
        };
    }
}

// --- inputs ------------------------------------------------------------------

function loadArtifact() {
    const problems = [];
    if (!fs.existsSync(ARTIFACT)) return { problems: [`artifact missing: ${ARTIFACT}`] };
    if (!fs.existsSync(MANIFEST)) return { problems: [`manifest missing: ${MANIFEST}`] };
    const code = fs.readFileSync(ARTIFACT, 'utf8');
    const bytes = fs.statSync(ARTIFACT).size;
    const fileSha = crypto.createHash('sha256').update(fs.readFileSync(ARTIFACT)).digest('hex');
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const out = manifest.output || {};
    if (out.sha256 !== fileSha) problems.push(`manifest sha256 ${out.sha256} != artifact ${fileSha}`);
    if (out.bytes !== bytes) problems.push(`manifest bytes ${out.bytes} != artifact ${bytes}`);
    if (manifest.screepsModuleName !== 'main') problems.push(`manifest screepsModuleName ${manifest.screepsModuleName} != main`);
    if (manifest.testBuild !== false) problems.push(`manifest testBuild=${manifest.testBuild} (test builds must not be deployed)`);
    // Static load check: evaluate as a Screeps module in a fresh V8 context
    // whose Game/Memory/RawMemory getters throw — top level must be
    // declarations only and must export loop.
    const touched = [];
    const ctx = { console: { log() {} } };
    for (const g of ['Game', 'Memory', 'RawMemory', 'PathFinder']) {
        Object.defineProperty(ctx, g, { get() { touched.push(g); throw new Error(`${g} read at require time`); }, configurable: true });
    }
    vm.createContext(ctx);
    let loopType = null, loadError = null;
    try {
        const mod = { exports: {} };
        vm.runInContext(`(function(module, exports){ ${code}\n})`, ctx)(mod, mod.exports);
        loopType = typeof mod.exports.loop;
    } catch (e) { loadError = String(e && e.message || e); }
    if (loadError) problems.push(`static require failed: ${loadError}`);
    if (loopType !== 'function') problems.push(`exports.loop is ${loopType}`);
    if (touched.length) problems.push(`top level touched ${touched.join(',')}`);
    return {
        problems, code, manifest,
        info: { artifact: path.relative(REPO, ARTIFACT), manifest: path.relative(REPO, MANIFEST), fileSha256: fileSha, bytes,
            manifestSha256: out.sha256, buildId: manifest.buildId, contractVersion: manifest.contractVersion,
            schemaVersion: manifest.schemaVersion, testBuild: manifest.testBuild, moduleCount: manifest.moduleCount,
            staticLoad: { loopType, loadError, touchedAtRequire: touched } },
    };
}

function loadBaseline() {
    const dir = path.join(REPO, 'dist2');
    const modules = {}, hashes = {};
    for (const file of fs.readdirSync(dir).sort()) {
        if (!file.endsWith('.js') || file === 'mock-game.js') continue;
        const name = file.replace(/\.js$/, '');
        modules[name] = fs.readFileSync(path.join(dir, file), 'utf8');
        hashes[name] = sha256(modules[name]);
    }
    return { modules, hashes };
}

function ports(k) {
    const http = PORT_BASE + 2 * k, cli = http + 1;
    if (http < PORT_MIN || cli > PORT_MAX) throw new Error(`ports ${http}/${cli} outside ${PORT_MIN}-${PORT_MAX}`);
    return { http, cli };
}

// --- per-run digests ------------------------------------------------------------

function digest(result) {
    const map = O.buildIdMap(result);
    const norm = O.normalizer(map);
    const uid = result.ctx && result.ctx.userId;
    const preNames = new Set((result.frames[0] && result.frames[0].objects || []).filter(o => o.type === 'creep').map(o => o.name));
    const ticks = result.frames.map(f => {
        const mem = f.memory && uid ? f.memory[uid] : null;
        const legacy = O.legacyMemory(mem);
        const objs = O.frameObjects(f, norm);
        return {
            stepIndex: f.stepIndex, gameTime: f.gameTime,
            memoryRaw: mem,
            legacyNorm: norm(legacy),
            legacyStruct: O.structure(norm(legacy)),
            resources: norm(O.resourceSummary(mem)),
            strategyKeys: mem ? Object.keys(mem).filter(O.isStrategyKey).sort() : [],
            strayKeys: O.strayStrategyKeys(mem),
            topKeys: mem ? Object.keys(mem).sort() : [],
            objects: objs,
            actions: O.actionTypes(objs),
            dup: O.duplicationProblems(mem),
            gameRefs: O.gameRefs(mem),
        };
    });
    return {
        map, norm, ticks,
        spawned: O.spawnedCreeps(result, preNames),
        console: O.consoleSummary(result),
        notifErrors: O.notificationErrors(result),
        events: O.eventLogs(result, norm),
    };
}

// Per-tick comparison with FULL diff lists. lengthMismatch is a FAIL condition.
function compareTicks(da, db, field) {
    const ticks = [];
    const n = Math.min(da.ticks.length, db.ticks.length);
    let truncated = false;
    for (let i = 0; i < n; i++) {
        const a = da.ticks[i], b = db.ticks[i];
        const d = O.deepDiff(a[field], b[field]);
        if (d.truncated) truncated = true;
        if (a.gameTime !== b.gameTime) ticks.push({ stepIndex: a.stepIndex, gameTime: a.gameTime, diffs: [{ path: '/gameTime', a: a.gameTime, b: b.gameTime }] });
        else if (d.length) ticks.push({ stepIndex: a.stepIndex, gameTime: a.gameTime, diffs: d });
    }
    const lengthMismatch = da.ticks.length !== db.ticks.length ? [da.ticks.length, db.ticks.length] : null;
    return { field, ticks, lengthMismatch, truncated };
}

function compareEvents(da, db) {
    const ticks = [];
    const n = Math.min(da.events.length, db.events.length);
    for (let i = 0; i < n; i++) {
        const d = O.deepDiff(da.events[i].events, db.events[i].events);
        if (d.length) ticks.push({ stepIndex: da.events[i].stepIndex, gameTime: da.events[i].gameTime, diffs: d });
    }
    const lengthMismatch = da.events.length !== db.events.length ? [da.events.length, db.events.length] : null;
    return { field: 'events', ticks, lengthMismatch, truncated: false };
}

// Comparison is clean only with no differing tick, equal frame counts and no truncation.
const cmpProblems = (c, what) => {
    const p = [];
    if (c.ticks.length) p.push(`${what}: ${c.field} differs at ${c.ticks.length} ticks (first gameTime ${c.ticks[0].gameTime})`);
    if (c.lengthMismatch) p.push(`${what}: ${c.field} frame count mismatch ${c.lengthMismatch.join(' vs ')}`);
    if (c.truncated) p.push(`${what}: ${c.field} diff list truncated`);
    return p;
};
const brief = c => ({ ticks: c.ticks.length, lengthMismatch: c.lengthMismatch, truncated: c.truncated,
    first: c.ticks.slice(0, 5).map(t => ({ stepIndex: t.stepIndex, gameTime: t.gameTime, diffCount: t.diffs.length, diffs: O.reportDiffs(t.diffs) })) });

const EVENT_NAMES = { 1: 'ATTACK', 2: 'OBJECT_DESTROYED', 3: 'ATTACK_CONTROLLER', 4: 'BUILD', 5: 'HARVEST', 6: 'HEAL', 7: 'REPAIR',
    8: 'RESERVE_CONTROLLER', 9: 'UPGRADE_CONTROLLER', 10: 'EXIT', 11: 'POWER', 12: 'TRANSFER' };

// Event-log evidence for A3: per type counts, examples with direction/amount,
// spawn ticks and the events seen on them (no EVENT_SPAWN constant exists).
function eventEvidence(d) {
    const counts = {}, examples = {}, unknownTypes = [];
    let parseErrors = 0, missing = 0;
    for (const e of d.events) {
        if (e.parseError) parseErrors++;
        if (e.events === null) { missing++; continue; }
        for (const ev of e.events) {
            const name = EVENT_NAMES[ev.event];
            if (!name) { unknownTypes.push({ gameTime: e.gameTime, event: ev.event }); continue; }
            counts[name] = (counts[name] || 0) + 1;
            (examples[name] = examples[name] || []);
            if (examples[name].length < 4) examples[name].push({ frameGameTime: e.gameTime, processedTick: e.gameTime - 1, ...ev });
        }
    }
    const transferDirections = {};
    for (const e of d.events) for (const ev of e.events || []) if (ev.event === 12) {
        const k = `${String(ev.objectId).split(/[@:]/)[0]}->${String(ev.data && ev.data.targetId).split(/[@:]/)[0]}`;
        transferDirections[k] = (transferDirections[k] || 0) + 1;
    }
    const onSpawnTicks = d.spawned.map(s => s.firstGameTime).map(gt => {
        const e = d.events.find(x => x.gameTime === gt);
        return { frameGameTime: gt, eventTypes: e && e.events ? [...new Set(e.events.map(ev => EVENT_NAMES[ev.event] || ev.event))] : null };
    });
    return { counts, transferDirections, examples, unknownTypes, parseErrors, missingLogs: missing, spawnTicks: onSpawnTicks,
        eventSpawnConstantExists: false };
}

// Memory.strategy* behaviour of one run (for reports).
function strategySummary(d) {
    const withS = d.ticks.filter(t => t.memoryRaw && t.memoryRaw.strategy);
    const last = withS.length ? withS[withS.length - 1].memoryRaw.strategy : null;
    const first = withS.length ? withS[0] : null;
    const revs = withS.map(t => t.memoryRaw.strategy.revision);
    return {
        framesWithStrategy: withS.length, framesTotal: d.ticks.length,
        firstGameTime: first ? first.gameTime : null,
        namespacesSeen: [...new Set(d.ticks.flatMap(t => t.strategyKeys))].sort(),
        strayKeysSeen: [...new Set(d.ticks.flatMap(t => t.strayKeys))].sort(),
        topLevelKeys: last ? Object.keys(last).sort() : null,
        schemaVersion: last ? last.schemaVersion : null, buildId: last ? last.buildId : null,
        revisionFirst: revs.length ? revs[0] : null, revisionLast: revs.length ? revs[revs.length - 1] : null,
        revisionMonotonic: revs.every((r, i) => i === 0 || (Number.isFinite(r) && r >= revs[i - 1])),
        lastClosedTick: last ? last.lastClosedTick : null,
        control: last ? last.control : null, migrations: last ? last.migrations : null,
        faults: last ? last.faults : null,
        bytesLast: last ? JSON.stringify(last).length : 0,
        shadowBytesLast: (() => { const t = d.ticks[d.ticks.length - 1]; return t && t.memoryRaw && t.memoryRaw.strategyShadow ? JSON.stringify(t.memoryRaw.strategyShadow).length : 0; })(),
    };
}

function instanceSummary(r, d) {
    return {
        label: r.label, verdict: r.verdict, reason: r.reason, steps: r.stats.steps, gameTime: [r.stats.gameTimeStart, r.stats.gameTimeEnd],
        wallMs: r.stats.wallMs, maxMemoryBytes: r.stats.maxMemoryBytes, instanceState: r.instanceState, teardownProblems: r.teardownProblems,
        uploaded: r.uploaded, resets: r.events,
        spawned: d && d.spawned,
        console: d && { messages: d.console.messages, steps: d.console.steps, complete: d.console.complete, seqContiguous: d.console.seqContiguous,
            badSteps: d.console.badSteps.slice(0, 20), lines: d.console.lines, inits: d.console.inits, initDone: d.console.initDone,
            errorLines: d.console.errorLines.slice(0, 20), errorLineCount: d.console.errorLines.length, uncaught: d.console.uncaught.slice(0, 10),
            strategyLines: d.console.strategyLines.slice(0, 10) },
        notificationErrors: d && d.notifErrors.slice(0, 10),
        activity: d && activity(d),
        strategy: d && strategySummary(d),
        finalLegacyKeys: d && d.ticks.length ? Object.keys(d.ticks[d.ticks.length - 1].legacyNorm || {}).sort() : null,
        finalResources: d && d.ticks.length ? d.ticks[d.ticks.length - 1].resources : null,
    };
}

function activity(d) {
    let events = 0;
    for (const e of d.events) events += (e.events || []).length;
    return { spawned: d.spawned.length, actionTicks: d.ticks.filter(t => Object.keys(t.actions).length).length, events };
}

// Common hard checks for one run. Returns {fail:[], unknown:[]}.
//   expectInits   steps where legacy must initialise (console evidence)
//   artifact      run executes the artifact (strategy expectations apply)
//   needActivity  comparison modes: a run without spawn/actions/events is vacuous
function runChecks(r, d, { expectInits, artifact, needActivity }) {
    const fail = [], unknown = [];
    if (r.verdict !== 'COMPLETE') unknown.push(`${r.label}: instance ${r.verdict}: ${r.reason}`);
    if (!d) { unknown.push(`${r.label}: no frames`); return { fail, unknown }; }
    if (d.notifErrors.length) fail.push(`${r.label}: ${d.notifErrors.length} error notifications (first: ${d.notifErrors[0].message})`);
    if (d.console.uncaught.length) fail.push(`${r.label}: ${d.console.uncaught.length} uncaught runtime errors (first: ${d.console.uncaught[0].error})`);
    if (d.console.errorLines.length) fail.push(`${r.label}: ${d.console.errorLines.length} error console lines (first: ${d.console.errorLines[0].line})`);
    if (!d.console.complete) unknown.push(`${r.label}: console evidence incomplete (messages ${d.console.messages}/${d.console.steps}, seqContiguous=${d.console.seqContiguous}, bad steps ${d.console.badSteps.slice(0, 5).join(',')})`);
    const refs = d.ticks.filter(t => t.gameRefs.length);
    if (refs.length) fail.push(`${r.label}: Game-object-like values in Memory at ${refs.length} frames (first ${refs[0].gameTime}: ${refs[0].gameRefs.slice(0, 3).join(',')})`);
    const dups = d.ticks.filter(t => t.dup.length);
    if (dups.length) fail.push(`${r.label}: duplication invariants broken at ${dups.length} frames (first ${dups[0].gameTime}: ${dups[0].dup[0]})`);
    const stray = d.ticks.filter(t => t.strayKeys.length);
    if (stray.length) fail.push(`${r.label}: stray strategy-prefixed Memory keys outside {${O.STRATEGY_NAMESPACES.join(',')}} at ${stray.length} frames (first ${stray[0].gameTime}: ${stray[0].strayKeys.join(',')})`);
    const noLog = d.events.filter(e => e.stepIndex > 0 && (e.events === null || e.parseError));
    if (noLog.length) unknown.push(`${r.label}: raw event log missing/unparseable at ${noLog.length} post-step frames (first gameTime ${noLog[0].gameTime})`);
    if (expectInits) {
        const got = d.console.inits;
        const extra = got.filter(s => !expectInits.includes(s));
        const missing = expectInits.filter(s => !got.includes(s));
        const dupInit = got.filter((s, i) => got.indexOf(s) !== i);
        if (extra.length || dupInit.length) fail.push(`${r.label}: unexpected legacy initialisations at steps ${[...extra, ...dupInit].join(',')} (expected ${expectInits.join(',')})`);
        if (missing.length) unknown.push(`${r.label}: console evidence of initialisation missing at steps ${missing.join(',')} (pubsub is lossy; cannot prove reset/init)`);
    }
    if (artifact && EXPECT_STRATEGY && !d.ticks.some(t => t.memoryRaw && t.memoryRaw.strategy)) {
        unknown.push(`${r.label}: --expect-strategy but Memory.strategy absent in every frame`);
    }
    if (needActivity) {
        const a = activity(d);
        if (!a.spawned || !a.actionTicks || !a.events) unknown.push(`${r.label}: vacuous window (spawned ${a.spawned}, action ticks ${a.actionTicks}, events ${a.events})`);
    }
    return { fail, unknown };
}

// Most severe first: an observed violation (FAIL) outranks lost evidence
// (UNKNOWN), which outranks an admission refusal (BLOCKED). All lists are
// always reported in run.json/oracle.json.
function verdictOf(fail, unknown, blocked) {
    if (fail.length) return 'FAIL';
    if (unknown.length) return 'UNKNOWN';
    if (blocked.length) return 'BLOCKED';
    return 'PASS';
}

// Memory.strategy identity across a reset (frames s-1 -> s of the reset run).
function strategyIdentity(dr, resets) {
    const out = [];
    const need = ['schemaVersion', 'buildId', 'revision'];
    for (const s of resets) {
        const before = dr.ticks.find(t => t.stepIndex === s - 1), after = dr.ticks.find(t => t.stepIndex === s);
        const sb = before && before.memoryRaw && before.memoryRaw.strategy, sa = after && after.memoryRaw && after.memoryRaw.strategy;
        if (!sb && !sa) { out.push({ step: s, status: 'absent' }); continue; }
        const p = [];
        if (!sb) p.push('Memory.strategy appeared only after reset (absent before)');
        if (!sa) p.push('Memory.strategy lost after reset');
        if (sb && sa) {
            for (const f of need) if (!(f in sb) || !(f in sa)) p.push(`field ${f} missing`);
            if (sb.schemaVersion !== sa.schemaVersion) p.push(`schemaVersion changed ${sb.schemaVersion}->${sa.schemaVersion}`);
            if (sb.buildId !== sa.buildId) p.push(`buildId changed ${sb.buildId}->${sa.buildId}`);
            if (!(Number.isFinite(sb.revision) && Number.isFinite(sa.revision) && sa.revision >= sb.revision)) p.push(`revision not monotonic ${sb.revision}->${sa.revision}`);
            if (O.canon(sb.control) !== O.canon(sa.control)) p.push('control changed across reset');
            if (O.canon(sb.migrations) !== O.canon(sa.migrations)) p.push('migrations changed across reset');
        }
        out.push({ step: s, status: p.length ? 'broken' : 'preserved', problems: p,
            before: sb && { schemaVersion: sb.schemaVersion, buildId: sb.buildId, revision: sb.revision, lastClosedTick: sb.lastClosedTick },
            after: sa && { schemaVersion: sa.schemaVersion, buildId: sa.buildId, revision: sa.revision, lastClosedTick: sa.lastClosedTick } });
    }
    return out;
}

// --- modes ---------------------------------------------------------------------

async function main() {
    const modes = ['load', 'reset', 'legacy-eq', 'shadow-noop'];
    if (!modes.includes(MODE)) { console.error(`--mode must be one of ${modes.join(', ')}`); process.exitCode = 2; return; }
    if (!Number.isInteger(STEPS) || STEPS < 12) { console.error('--steps must be an integer >= 12'); process.exitCode = 2; return; }
    const runId = `strat-${MODE}-${Date.now()}-${process.pid}`;
    const runDir = path.join(RUNS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    attachLog(runDir);
    const scenarioId = `STRAT-${MODE.toUpperCase()}`;
    const fail = [], unknown = [], blocked = [], findings = [];
    const oracle = { runId, scenarioId, mode: MODE, steps: STEPS, expectStrategy: EXPECT_STRATEGY, expectShadow: EXPECT_SHADOW, startedAt: new Date().toISOString() };
    try {
        await body();
    } catch (error) {
        unknown.push(`suite crash: ${error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error}`);
    }
    finish();

    async function body() {
        const seedId = crypto.createHash('sha256').update(fs.readFileSync(SEED_DB)).digest('hex').slice(0, 16);
        oracle.seedId = seedId;
        const art = loadArtifact();
        oracle.artifact = art.info || null;
        if (art.problems.length) { blocked.push(...art.problems.map(p => `artifact: ${p}`)); return; }
        const artifactRun = { modules: { main: art.code }, moduleHashes: { main: art.info.fileSha256 } };
        const base = loadBaseline();
        const baselineRun = { modules: base.modules, moduleHashes: base.hashes };
        oracle.baseline = { tree: 'dist2', modules: Object.keys(base.hashes).length, hashes: base.hashes };
        let seedExtra = null;
        if (SEED_MEMORY) {
            seedExtra = JSON.parse(fs.readFileSync(path.resolve(SEED_MEMORY), 'utf8'));
            oracle.seedMemory = { file: SEED_MEMORY, keys: Object.keys(seedExtra), sha256: sha256(JSON.stringify(seedExtra)) };
        }
        const common = (label, k, extra) => ({
            runId, label, scenarioId, runDir, seedId, ports: ports(k), steps: STEPS, seedMemoryExtra: seedExtra,
            budgets: { WcaseMs: WCASE_MS }, ...extra,
        });
        const check = (r, d, o) => {
            const c = runChecks(r, d, o);
            fail.push(...c.fail); unknown.push(...c.unknown);
            if (r.verdict === 'BLOCKED') blocked.push(`${r.label}: ${r.reason}`);
        };

        if (MODE === 'load') {
            const r = await runInstance(common('artifact', 0, artifactRun));
            const d = r.frames.length ? digest(r) : null;
            oracle.instances = [instanceSummary(r, d)];
            check(r, d, { expectInits: [1], artifact: true, needActivity: false });
            if (d) {
                const up = r.uploaded && r.uploaded.hashes;
                oracle.hashes = { manifest: art.info.manifestSha256, file: art.info.fileSha256, uploaded: up && up.main, uploadedModules: up && Object.keys(up) };
                if (!up || up.main !== art.info.manifestSha256 || Object.keys(up).length !== 1) fail.push('uploaded module set is not exactly {main} with the manifest sha256');
                const first = d.ticks.find(t => t.stepIndex === 1);
                const loopEvidence = {
                    resourceManagerAtStep1: !!(first && first.memoryRaw && first.memoryRaw.resourceManager),
                    loggerStateAtStep1: !!(first && first.memoryRaw && first.memoryRaw.loggerState),
                    creepOrdersAtStep1: first && first.resources && first.resources.creepOrder ? first.resources.creepOrder.length : 0,
                    legacySpawned: d.spawned.length,
                    firstSpawnGameTime: d.spawned.length ? d.spawned[0].firstGameTime : null,
                    strategyNamespaces: d.ticks[d.ticks.length - 1].strategyKeys,
                };
                oracle.loopEvidence = loopEvidence;
                if (!loopEvidence.resourceManagerAtStep1 || !loopEvidence.creepOrdersAtStep1) fail.push('loop did not run legacy at the first tick (no Memory.resourceManager/creepOrder after step 1)');
                if (!loopEvidence.legacySpawned) fail.push('legacy SpawnController never spawned a creep in the window');
            }
        } else if (MODE === 'reset') {
            // Four instances: artifact control/reset and flat-dist2 control/reset
            // with the same reset schedule. dist2 itself is reset-sensitive (init
            // order BuildController -> SourceController), so the artifact's reset
            // run must equal the baseline's reset run tick-for-tick; the reset
            // effect (control vs reset) must be identical in both trees.
            const resets = RESETS.filter(s => s >= 2 && s <= STEPS);
            const resetHook = async (i, env) => {
                if (!resets.includes(i)) return null;
                const r = await env.forceReset();
                return { kind: 'reset', prevTimestamp: r.prev, timestamp: r.ts };
            };
            const rc = await runInstance(common('artifact-control', 0, artifactRun));
            const rr = await runInstance(common('artifact-reset', 1, { ...artifactRun, beforeStep: resetHook }));
            const bc = await runInstance(common('baseline-control', 2, baselineRun));
            const br = await runInstance(common('baseline-reset', 3, { ...baselineRun, beforeStep: resetHook }));
            const runs = [[rc, [1], true], [rr, [1, ...resets], true], [bc, [1], false], [br, [1, ...resets], false]];
            const ds = runs.map(([r]) => (r.frames.length ? digest(r) : null));
            const [dc, dr, dbc, dbr] = ds;
            oracle.resets = resets;
            oracle.instances = runs.map(([r], i) => instanceSummary(r, ds[i]));
            runs.forEach(([r, inits, artifact], i) => check(r, ds[i], { expectInits: inits, artifact, needActivity: true }));
            if (ds.every(Boolean)) {
                const fields = ['legacyNorm', 'resources', 'objects'];
                const cmp = (a, b) => Object.fromEntries(fields.map(f => [f, compareTicks(a, b, f)]));
                const artVsBase = cmp(dr, dbr), artVsBaseCtl = cmp(dc, dbc);
                const effArt = cmp(dc, dr), effBase = cmp(dbc, dbr);
                const eff = c => ({ ticks: c.ticks, lengthMismatch: c.lengthMismatch });
                const sameEffect = fields.every(f => O.canon(eff(effArt[f])) === O.canon(eff(effBase[f])));
                oracle.compare = {
                    artifactResetVsBaselineReset: Object.fromEntries(fields.map(f => [f, brief(artVsBase[f])])),
                    artifactControlVsBaselineControl: Object.fromEntries(fields.map(f => [f, brief(artVsBaseCtl[f])])),
                    resetEffectArtifact: Object.fromEntries(fields.map(f => [f, brief(effArt[f])])),
                    resetEffectBaseline: Object.fromEntries(fields.map(f => [f, brief(effBase[f])])),
                    resetEffectIdentical: sameEffect,
                    spawned: { artifactControl: dc.spawned, artifactReset: dr.spawned, baselineControl: dbc.spawned, baselineReset: dbr.spawned },
                };
                for (const f of fields) {
                    fail.push(...cmpProblems(artVsBase[f], 'artifact-reset vs baseline-reset'));
                    fail.push(...cmpProblems(artVsBaseCtl[f], 'artifact-control vs baseline-control'));
                }
                if (!sameEffect) fail.push('reset effect (control vs reset) differs between artifact and flat dist2');
                if (O.canon(dr.spawned) !== O.canon(dbr.spawned) || O.canon(dc.spawned) !== O.canon(dr.spawned)) fail.push('spawned creeps differ across control/reset/baseline');
                if (effArt.resources.ticks.length) findings.push(`reset changes legacy orders vs no-reset control at ${effArt.resources.ticks.length} ticks (first gameTime ${effArt.resources.ticks[0].gameTime}) identically in flat dist2: legacy reset sensitivity, not duplication`);
                // Memory.strategy across resets.
                const ident = strategyIdentity(dr, resets);
                oracle.strategyIdentity = ident;
                for (const x of ident) if (x.status === 'broken') fail.push(`Memory.strategy identity at reset step ${x.step}: ${x.problems.join('; ')}`);
                if (ident.every(x => x.status === 'absent')) {
                    if (EXPECT_STRATEGY) unknown.push('--expect-strategy but Memory.strategy absent around every reset: identity unproven');
                    else findings.push('Memory.strategy absent around every reset: identity oracle not applicable (run with --expect-strategy once the artifact writes it)');
                }
                // Strategy state reset-vs-control (reported): a reset should not perturb it.
                const sCmp = { field: 'strategy', ticks: [], lengthMismatch: null, truncated: false };
                for (let i = 0; i < Math.min(dc.ticks.length, dr.ticks.length); i++) {
                    const a = dc.ticks[i].memoryRaw && dc.ticks[i].memoryRaw.strategy, b = dr.ticks[i].memoryRaw && dr.ticks[i].memoryRaw.strategy;
                    const dd = O.deepDiff(a === undefined ? null : a, b === undefined ? null : b);
                    if (dd.length) sCmp.ticks.push({ stepIndex: dc.ticks[i].stepIndex, gameTime: dc.ticks[i].gameTime, diffs: dd });
                }
                oracle.compare.strategyControlVsReset = brief(sCmp);
                if (sCmp.ticks.length) findings.push(`Memory.strategy differs between artifact control and reset runs at ${sCmp.ticks.length} ticks (first gameTime ${sCmp.ticks[0].gameTime}); see oracle.compare.strategyControlVsReset`);
            }
        } else {
            // legacy-eq / shadow-noop
            const rb = await runInstance(common('baseline', 0, baselineRun));
            const ra = await runInstance(common('artifact', 1, artifactRun));
            const rb2 = MODE === 'shadow-noop' ? await runInstance(common('baseline2', 2, baselineRun)) : null;
            const db = rb.frames.length ? digest(rb) : null, da = ra.frames.length ? digest(ra) : null, db2 = rb2 && rb2.frames.length ? digest(rb2) : null;
            const all = [[rb, db, false], [ra, da, true]].concat(rb2 ? [[rb2, db2, false]] : []);
            oracle.instances = all.map(([r, d]) => instanceSummary(r, d));
            for (const [r, d, artifact] of all) check(r, d, { expectInits: [1], artifact, needActivity: true });
            if (db && da) {
                const struct = compareTicks(db, da, 'legacyStruct');
                const values = compareTicks(db, da, 'legacyNorm');
                const res = compareTicks(db, da, 'resources');
                const actions = compareTicks(db, da, 'actions');
                const objects = compareTicks(db, da, 'objects');
                const events = compareEvents(db, da);
                const keysExtra = [];
                for (let i = 0; i < Math.min(db.ticks.length, da.ticks.length); i++) {
                    const extra = da.ticks[i].topKeys.filter(k => !db.ticks[i].topKeys.includes(k) && !O.isStrategyKey(k));
                    if (extra.length) keysExtra.push({ gameTime: da.ticks[i].gameTime, extra });
                }
                oracle.compare = {
                    legacyStruct: brief(struct), legacyValues: brief(values), resources: brief(res), actionTypes: brief(actions),
                    objects: brief(objects), events: brief(events), nonStrategyExtraKeys: keysExtra.slice(0, 10),
                    spawnedBaseline: db.spawned, spawnedArtifact: da.spawned,
                    initStepBaseline: db.console.inits, initStepArtifact: da.console.inits,
                    strategyNamespacesArtifact: [...new Set(da.ticks.flatMap(t => t.strategyKeys))].sort(),
                };
                const spawnedEq = O.canon(db.spawned) === O.canon(da.spawned);
                if (keysExtra.length) fail.push(`artifact Memory has non-strategy top-level keys absent in baseline (first gameTime ${keysExtra[0].gameTime}: ${keysExtra[0].extra.join(',')})`);
                if (!spawnedEq) fail.push('spawned creeps (names/bodies/roles/tick) differ');
                if (MODE === 'legacy-eq') {
                    fail.push(...cmpProblems(struct, 'artifact vs baseline'), ...cmpProblems(res, 'artifact vs baseline'), ...cmpProblems(actions, 'artifact vs baseline'));
                    for (const c of [values, objects, events]) {
                        if (c.lengthMismatch) fail.push(...cmpProblems(c, 'artifact vs baseline'));
                        else if (c.ticks.length) findings.push(`${c.field} differ at ${c.ticks.length} ticks (reported; structure/resources/actions/spawn govern LEGACY-EQ)`);
                    }
                } else {
                    // SHADOW-NOOP: exact equality modulo calibrated legacy
                    // nondeterminism. A path at a tick is masked only when the
                    // baseline/baseline2 pair also differs there AND the
                    // artifact's value equals baseline2's value (the artifact
                    // reproduced another observed legacy outcome).
                    const getters = {
                        values: (d, i) => d.ticks[i] && d.ticks[i].legacyNorm,
                        objects: (d, i) => d.ticks[i] && d.ticks[i].objects,
                        events: (d, i) => d.events[i] && d.events[i].events,
                    };
                    const cal = db2 ? { values: compareTicks(db, db2, 'legacyNorm'), objects: compareTicks(db, db2, 'objects'), events: compareEvents(db, db2) } : null;
                    const residual = (k, c) => {
                        const calTicks = cal ? new Map(cal[k].ticks.map(t => [t.gameTime, new Set(t.diffs.map(x => x.path))])) : new Map();
                        const out = { field: c.field, ticks: [], lengthMismatch: c.lengthMismatch, truncated: c.truncated || !!(cal && cal[k].truncated), masked: 0 };
                        c.ticks.forEach(t => {
                            const idx = (k === 'events' ? da.events : da.ticks).findIndex(x => x.gameTime === t.gameTime);
                            const paths = calTicks.get(t.gameTime);
                            const left = t.diffs.filter(x => {
                                if (!paths || !paths.has(x.path) || idx < 0) return true;
                                const same = O.canon(O.valueAt(getters[k](da, idx), x.path)) === O.canon(O.valueAt(getters[k](db2, idx), x.path));
                                if (same) out.masked++;
                                return !same;
                            });
                            if (left.length) out.ticks.push({ ...t, diffs: left });
                        });
                        return out;
                    };
                    const rv = residual('values', values), ro = residual('objects', objects), re = residual('events', events);
                    oracle.calibration = cal && { baselineVsBaseline2: { values: brief(cal.values), objects: brief(cal.objects), events: brief(cal.events) } };
                    oracle.residual = { values: { ...brief(rv), masked: rv.masked }, objects: { ...brief(ro), masked: ro.masked }, events: { ...brief(re), masked: re.masked } };
                    if (!db2 || rb2.verdict !== 'COMPLETE') unknown.push('calibration baseline2 unavailable: legacy nondeterminism cannot be separated');
                    if (cal) for (const k of ['values', 'objects', 'events']) if (cal[k].lengthMismatch || cal[k].truncated) unknown.push(`calibration ${k}: ${cmpProblems(cal[k], 'baseline vs baseline2').join('; ')}`);
                    fail.push(...cmpProblems(rv, 'artifact vs baseline (outside strategy*, beyond calibration)'));
                    fail.push(...cmpProblems(ro, 'artifact vs baseline (beyond calibration)'));
                    fail.push(...cmpProblems(re, 'artifact vs baseline (beyond calibration)'));
                    const shadowPresent = da.ticks.some(t => t.strategyKeys.includes('strategyShadow'));
                    oracle.shadowActive = { expectShadow: EXPECT_SHADOW, strategyShadowSeen: shadowPresent };
                    if (EXPECT_SHADOW && !shadowPresent) unknown.push('--expect-shadow given but Memory.strategyShadow never appeared: shadow not active, NOOP comparison vacuous');
                    if (!EXPECT_SHADOW) findings.push(`run without --expect-shadow: ${shadowPresent ? 'strategyShadow present' : 'no shadow state (baseline check of a pre-shadow artifact)'}`);
                    oracle.eventEvidence = { baseline: eventEvidence(db), artifact: eventEvidence(da) };
                }
            }
        }
    }

    function finish() {
        const verdict = verdictOf(fail, unknown, blocked);
        oracle.verdict = verdict;
        oracle.fail = fail; oracle.unknown = unknown; oracle.blocked = blocked; oracle.findings = findings;
        oracle.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(runDir, 'oracle.json'), JSON.stringify(oracle, null, 2), { mode: 0o600 });
        fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ runId, scenarioId, verdict, fail, unknown, blocked, findings,
            instances: (oracle.instances || []).map(i => ({ label: i.label, verdict: i.verdict, instanceState: i.instanceState, steps: i.steps })) }, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ verdict, runId, scenarioId, runDir, fail, unknown, blocked, findings }));
        process.exitCode = VERDICT_EXIT[verdict];
    }
}

main().catch(e => { console.error(e && e.stack || e); process.exitCode = 3; });
