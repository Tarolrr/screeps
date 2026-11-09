'use strict';
// STRAT per-instance runner.
//
// One call = one fresh disposable instance (e2e/server/instance.js with the
// SRV step-mod + preload, unmodified) driven by one StepClient. Same admission,
// S(T)->step->S(T+1) loop, core coherence assertions and teardown/cleanup
// journal as e2e/har/harness.js runScenario(), with three differences required
// by the STRAT suite (HAR code is not modified):
//   - evidence lives under e2e/strat/.runs/<runId>/<label>/;
//   - field-set reads are paged (paged.js) because full dist2 Memory and
//     ~10 creeps exceed the 10 KB CLI print ceiling;
//   - per-tick auxiliary evidence: raw room event log (env hash
//     roomEventLog:<room>), notifications, user CPU row, user console
//     (pubsub `user:<id>/console` collected by a dedicated CLI connection).
//
// The instance verdict is technical only: COMPLETE (all requested steps
// observed with coherent bound snapshots and clean teardown), BLOCKED (fixture
// refused before stepping) or UNKNOWN (evidence lost / cleanup uncertain).
// Behavioural oracles are evaluated by the caller on the returned frames.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createIsolatedServer } = require('../server/instance');
const { StepClient } = require('../server/step-client');
const { Harness } = require('../harness');
const { ScreepsCLI } = require('../cli-client');
const { resolveFixture, validateFixture, FixtureError, fixtureF0 } = require('../har/fixture');
const { TraceRecorder } = require('../har/trace');
const { pagedEval, captureSnapshotPaged, readFieldSetPaged } = require('./paged');
const { arrangeS1, seedMemory } = require('./fixture');

const STEP_MOD = path.join(__dirname, '..', 'server', 'step-mod.js');
const STEP_PRELOAD = path.join(__dirname, '..', 'server', 'step-preload.js');

class CleanupJournal {
    constructor(file, runId, scenarioId) {
        this.file = file; this.runId = runId; this.scenarioId = scenarioId;
        fs.writeFileSync(this.file, '', { mode: 0o600, flag: 'wx' });
    }
    add(kind, id, action, detail, ok = true) {
        const rec = { t: new Date().toISOString(), runId: this.runId, scenarioId: this.scenarioId, kind, id, action, detail, ok };
        fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', { mode: 0o600 });
        return rec;
    }
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// Console collector: a second CLI connection subscribed to the user's console
// channel. Messages are compacted server-side (lines truncated to 400 chars)
// and drained after every captured frame. Pubsub is not a reliable journal:
// the caller must treat a missing expected line as UNKNOWN, never as absence.
class ConsoleCollector {
    constructor(cliOptions) { this.cli = new ScreepsCLI(cliOptions.host, cliOptions.port); this.total = 0; }
    async start(userId) {
        await this.cli.connect();
        const ok = await this.cli.eval(`(function(){
            globalThis.__stratCon = {msgs: [], n: 0};
            storage.pubsub.subscribe(${JSON.stringify('user:' + userId + '/console')}, function(raw){
                var c = globalThis.__stratCon, m;
                try { m = JSON.parse(raw); } catch (e) { m = {parseError: String(raw).slice(0, 200)}; }
                var lines = (m.messages && m.messages.log) || [];
                c.n++;
                c.msgs.push({seq: c.n, lines: lines.map(function(l){ return String(l).slice(0, 400); }), lineCount: lines.length,
                    results: ((m.messages && m.messages.results) || []).length,
                    error: m.error ? String(m.error).slice(0, 1500) : null, parseError: m.parseError || null});
            });
            return true;
        })()`, 15000);
        if (ok !== true) throw new Error('console subscribe failed');
    }
    async drain() {
        const out = [];
        for (let guard = 0; guard < 200; guard++) {
            const r = await pagedEval(this.cli, `(function(){ var c = globalThis.__stratCon; return {msgs: c.msgs.splice(0, 50), left: c.msgs.length, n: c.n}; })()`, 15000);
            out.push(...r.msgs);
            this.total = r.n;
            if (!r.left) break;
        }
        return out;
    }
    close() { try { this.cli.close(); } catch {} }
}

async function auxRead(h, ctx) {
    return pagedEval(h.cli, `Promise.all([
        storage.env.get('gameTime'),
        storage.env.hget('roomEventLog:', ${JSON.stringify(ctx.room)}),
        storage.db['users.notifications'].find({user: ${JSON.stringify(ctx.userId)}}),
        storage.db.users.findOne({_id: ${JSON.stringify(ctx.userId)}})
    ]).then(function(r){ return {gameTime: Number(r[0]), eventLogRaw: r[1] === undefined ? null : r[1], notifications: r[2],
        user: r[3] && {cpu: r[3].cpu, cpuAvailable: r[3].cpuAvailable, lastUsedCpu: r[3].lastUsedCpu, lastUsedDirtyTime: r[3].lastUsedDirtyTime}}; })`, 15000);
}

// Read back the uploaded users.code row and hash each module.
async function readUploadedModules(h, userId) {
    const row = await pagedEval(h.cli, `storage.db['users.code'].findOne({user: ${JSON.stringify(userId)}}).then(function(r){ return r && {branch: r.branch, timestamp: r.timestamp || null, modules: r.modules}; })`, 30000);
    if (!row) return null;
    const hashes = {};
    for (const k of Object.keys(row.modules || {})) {
        const name = k.replace(/\$DOT\$/g, '.').replace(/\$SLASH\$/g, '/').replace(/\$BACKSLASH\$/g, '\\');
        hashes[name] = sha256(row.modules[k]);
    }
    return { branch: row.branch, timestamp: row.timestamp, hashes };
}

// Global reset: rewrite the same modules with a new users.code timestamp. The
// runtime clears the user's isolate when codeTimestamp increases
// (driver/lib/runtime/user-vm.js:23) and rebuilds require.cache when the
// timestamp differs (engine/src/game/game.js:504-511).
async function forceReset(h, userId) {
    const ts = Date.now();
    const n = await h.eval(`storage.db['users.code'].findOne({user: ${JSON.stringify(userId)}}).then(function(r){
        if (!r) throw new Error('no users.code row');
        var prev = r.timestamp || 0, ts = Math.max(${ts}, prev + 1);
        return storage.db['users.code'].update({_id: r._id}, {$set: {timestamp: ts}}).then(function(){ return {prev: prev, ts: ts}; });
    })`, 15000);
    return n;
}

/**
 * opts: {runId, label, scenarioId, runDir, ports:{http,cli}, modules, moduleHashes,
 *        steps, budgets?, beforeStep?(i, env), seedMemoryExtra?, seedId}
 */
async function runInstance(opts) {
    const { runId, label, scenarioId, seedId } = opts;
    const budgets = Object.assign({ WcaseMs: 900000, opTimeoutMs: 15000, stepTimeoutMs: 30000, settleMs: 250 }, opts.budgets);
    const dir = path.join(opts.runDir, label);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const journal = new CleanupJournal(path.join(dir, 'cleanup-journal.jsonl'), runId, `${scenarioId}/${label}`);
    const auxFile = path.join(dir, 'aux.jsonl');
    fs.writeFileSync(auxFile, '', { mode: 0o600, flag: 'wx' });
    const frames = [], aux = [], problems = [], events = [];
    const stats = { steps: 0, gameTimeStart: null, gameTimeEnd: null, wallMs: 0, maxMemoryBytes: 0 };
    let verdict = 'UNKNOWN', reason = 'not completed';
    let server = null, gate = null, h = null, trace = null, ctx = null, fx = null, con = null;
    const teardownProblems = [];
    let teardownClean = false;
    const t0 = Date.now();
    const deadline = t0 + budgets.WcaseMs;
    let uploaded = null;

    try {
        server = await createIsolatedServer({ runId: `${runId}-${label}`.slice(0, 64), httpPort: opts.ports.http, cliPort: opts.ports.cli, mods: [STEP_MOD], preload: STEP_PRELOAD });
        journal.add('server', server.root, 'create', { ports: opts.ports });
        await server.start();
        journal.add('server', server.root, 'start', null);
        await server.assertIdentity();
        if (!fs.existsSync(path.join(server.root, 'step-backend-cron-disabled.json'))) throw new Error('BLOCKED: backend cron disable marker missing');
        journal.add('server', server.root, 'identity', { marker: server.marker });
        gate = await StepClient.connect(server.root, { timeoutMs: 15000 });
        journal.add('gate', 'step-control', 'connect', { session: gate.ready.session });
        h = new Harness({ cliHost: server.cliOptions.host, cliPort: server.cliOptions.port });
        await h.connect();
        journal.add('cli', `${server.cliOptions.host}:${server.cliOptions.port}`, 'connect', null);
        await h.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])", budgets.opTimeoutMs);
        journal.add('env', 'roomStatusData/accessibleRooms', 'seed', null);

        fx = await resolveFixture((code, t) => h.eval(code, t || budgets.opTimeoutMs), fixtureF0());
        journal.add('fixture', fx.spec.id, 'resolve', { room: fx.room, actual: fx.actual });
        fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(fx, (k, v) => (k === '_distMulti' ? undefined : v), 2), { mode: 0o600 });
        ctx = await arrangeS1(h, fx, journal, { username: `strat_${label.replace(/[^a-z0-9]/gi, '')}_${process.pid}`.slice(0, 40), modules: opts.modules });
        const val = await validateFixture((code, t) => h.eval(code, t || budgets.opTimeoutMs), fx, ctx.userId);
        journal.add('fixture', fx.spec.id, 'validate', { ok: val.ok, problems: val.problems });
        fs.writeFileSync(path.join(dir, 'fixture-validation.json'), JSON.stringify(val, null, 2), { mode: 0o600 });
        if (!val.ok) throw new Error(`BLOCKED: fixture invalid: ${val.problems.join('; ')}`);

        // Uploaded code must be byte-identical to the declared modules.
        uploaded = await readUploadedModules(h, ctx.userId);
        const mism = [];
        for (const [name, hash] of Object.entries(opts.moduleHashes)) if (!uploaded || uploaded.hashes[name] !== hash) mism.push(name);
        if (uploaded) for (const name of Object.keys(uploaded.hashes)) if (!(name in opts.moduleHashes)) mism.push(`extra:${name}`);
        journal.add('code', ctx.userId, 'verify-upload', { modules: uploaded && Object.keys(uploaded.hashes).length, mismatches: mism }, mism.length === 0);
        if (mism.length) throw new Error(`uploaded code mismatch: ${mism.join(',')}`);

        ctx.memorySeed = await seedMemory(h, ctx, opts.seedMemoryExtra, journal);

        con = new ConsoleCollector(server.cliOptions);
        await con.start(ctx.userId);
        journal.add('cli', 'console', 'subscribe', { channel: `user:${ctx.userId}/console` });

        if (gate.failed || gate.busy) throw new Error('UNKNOWN: step gate not exclusively available');
        await server.assertIdentity();
        journal.add('gate', 'step-control', 'admit', { sequence: gate.sequence });

        trace = new TraceRecorder(dir, {
            runId, scenarioId: `${scenarioId}/${label}`, seedId,
            fixture: { id: 'S1(F0+extras)', room: fx.room, actual: fx.actual, actors: ctx.actors },
            moduleHashes: opts.moduleHashes, budgets,
        });
        const snapFixture = { rooms: [ctx.room], users: [ctx.userId] };

        const pre = await readFieldSetPaged(h.cli, [ctx.room], [ctx.userId], budgets.opTimeoutMs);
        stats.gameTimeStart = pre.gameTime;
        const preAux = await auxRead(h, ctx);
        let prev = trace.record({ phase: 'pre-step', stepIndex: 0, ack: null, snap: { ok: true, snapshot: pre, problems: [], evidence: null },
            extra: { notifications: preAux.notifications }, runId, scenarioId, seedId, moduleHashes: opts.moduleHashes });
        frames.push({ ...prev, rawObjects: pre.objects[ctx.room] || [] });
        const a0 = { stepIndex: 0, gameTime: pre.gameTime, eventLogRaw: preAux.eventLogRaw, notifications: preAux.notifications, user: preAux.user, console: [], events: [] };
        aux.push(a0); fs.appendFileSync(auxFile, JSON.stringify(a0) + '\n');

        for (let i = 1; i <= opts.steps; i++) {
            if (Date.now() > deadline) { verdict = 'UNKNOWN'; reason = `wall-clock budget exceeded at step ${i}`; break; }
            await server.assertIdentity();
            if (gate.failed || gate.busy) { verdict = 'UNKNOWN'; reason = 'step gate became unavailable'; break; }
            const stepEvents = [];
            if (opts.beforeStep) {
                const ev = await opts.beforeStep(i, { h, ctx, journal, forceReset: () => forceReset(h, ctx.userId) });
                if (ev) { stepEvents.push(ev); events.push({ stepIndex: i, ...ev }); journal.add('scenario', `step-${i}`, ev.kind, ev, true); }
            }
            let ack;
            try { ack = await gate.step({ timeoutMs: budgets.stepTimeoutMs }); }
            catch (error) { verdict = 'UNKNOWN'; reason = `step ${i} lost: ${error.message}`; journal.add('gate', `ack-${i}`, 'lost', { message: error.message }, false); break; }
            stats.steps = i;
            if (!Number.isInteger(ack.sequence) || ack.sequence !== i) { verdict = 'UNKNOWN'; reason = `ack sequence discontinuity at step ${i}`; problems.push(reason); break; }
            const snap = await captureSnapshotPaged(h.cli, server.root, ack, snapFixture, { settleMs: budgets.settleMs, timeoutMs: budgets.opTimeoutMs });
            let ax;
            try {
                const a1 = await auxRead(h, ctx);
                const a2 = await auxRead(h, ctx);
                if (JSON.stringify(a1) !== JSON.stringify(a2)) throw new Error('aux double-read mismatch');
                if (a1.gameTime !== ack.gameTime) throw new Error(`aux gameTime ${a1.gameTime} != ack ${ack.gameTime}`);
                ax = a1;
            } catch (error) { verdict = 'UNKNOWN'; reason = `aux read ${i}: ${error.message}`; break; }
            const conMsgs = await con.drain();
            const rec = trace.record({ phase: 'post-step', stepIndex: i, ack, snap, extra: { notifications: ax.notifications, errors: (ax.notifications || []).filter(n => n.type === 'error'), userCpu: ax.user }, runId, scenarioId, seedId, moduleHashes: opts.moduleHashes });
            if (snap.snapshot) stats.maxMemoryBytes = Math.max(stats.maxMemoryBytes, ...(snap.snapshot.memoryBytes || [0]));
            const ar = { stepIndex: i, gameTime: rec.gameTime, rawObjects: snap.snapshot ? (snap.snapshot.objects[ctx.room] || []) : null, eventLogRaw: ax.eventLogRaw, notifications: ax.notifications, user: ax.user, console: conMsgs, events: stepEvents };
            fs.appendFileSync(auxFile, JSON.stringify(ar) + '\n');
            frames.push({ ...rec, rawObjects: snap.snapshot ? (snap.snapshot.objects[ctx.room] || []) : [] }); aux.push(ar);
            stats.gameTimeEnd = rec.gameTime;
            if (!rec.snapshotOk) { verdict = 'UNKNOWN'; reason = `snapshot ${i} incoherent: ${rec.problems.join('; ')}`; break; }
            if (prev.gameTime !== null && rec.gameTime !== prev.gameTime + 1) { verdict = 'UNKNOWN'; reason = `gameTime discontinuity at step ${i}: ${prev.gameTime} -> ${rec.gameTime}`; break; }
            prev = rec;
        }
        if (verdict === 'UNKNOWN' && reason === 'not completed') {
            if (stats.steps === opts.steps) { verdict = 'COMPLETE'; reason = `${opts.steps} steps observed`; }
        }
    } catch (error) {
        if (error instanceof FixtureError) { verdict = 'BLOCKED'; reason = `fixture refused: ${error.problems.join('; ')}`; }
        else if (/^BLOCKED:/.test(error.message)) { verdict = 'BLOCKED'; reason = error.message; }
        else { verdict = 'UNKNOWN'; reason = error.message; }
        problems.push(error.message);
        journal.add('scenario', scenarioId, 'error', { message: error.message }, false);
    } finally {
        if (con) { con.close(); journal.add('cli', 'console', 'close', null); }
        try {
            if (h && ctx && ctx.userId) {
                await h.destroyUser(ctx.userId, ctx.room);
                journal.add('user', ctx.userId, 'delete', { room: ctx.room });
            } else if (h) {
                teardownProblems.push('user cleanup skipped: arrange returned no ctx; world state unverifiable');
                journal.add('teardown', scenarioId, 'user-cleanup-skipped', { ctx: !!ctx }, false);
            }
            if (h && ctx && ctx.room && fx) {
                const remaining = await pagedEval(h.cli, `storage.db['rooms.objects'].find({room:${JSON.stringify(ctx.room)}}).then(function(os){return os.map(function(o){return {_id:o._id,type:o.type,user:o.user||null,level:o.level};});})`, budgets.opTimeoutMs);
                const extra = remaining.filter(o => !fx.objectsBaseline.includes(o._id));
                const missing = fx.objectsBaseline.filter(id => !remaining.some(o => o._id === id));
                const ctrl = remaining.find(o => o.type === 'controller');
                const clean = extra.length === 0 && missing.length === 0 && ctrl && !ctrl.user && ctrl.level === 0;
                journal.add('room', ctx.room, 'verify-baseline', { extra: extra.map(o => `${o.type}:${o._id}`), missing, controller: ctrl && { user: ctrl.user, level: ctrl.level } }, clean);
                if (!clean) teardownProblems.push(`room baseline not restored (extra: ${extra.map(o => o.type).join(',')}; missing: ${missing.length})`);
                const gone = await h.eval(`Promise.all([storage.env.get(${JSON.stringify('memory:' + ctx.userId)}), storage.db.users.findOne({_id:${JSON.stringify(ctx.userId)}}), storage.db['users.code'].findOne({user:${JSON.stringify(ctx.userId)}})]).then(function(r){return {mem: r[0] === null || r[0] === undefined, user: !r[1], code: !r[2]};})`, budgets.opTimeoutMs);
                const ok = gone.mem && gone.user && gone.code;
                journal.add('user', ctx.userId, 'verify-deleted', gone, ok);
                if (!ok) teardownProblems.push(`user/memory residue ${JSON.stringify(gone)}`);
            } else if (h) {
                teardownProblems.push('cleanup verification skipped: ctx or fixture missing');
                journal.add('teardown', scenarioId, 'verify-skipped', { ctx: !!ctx, fx: !!fx }, false);
            }
            teardownClean = teardownProblems.length === 0;
        } catch (error) {
            teardownProblems.push(`teardown: ${error.message}`);
            journal.add('teardown', scenarioId, 'verify', { message: error.message }, false);
        }
        try { if (h) { h.close(); journal.add('cli', null, 'close', null); } } catch (e) { teardownProblems.push(`cli close: ${e.message}`); }
        try { if (server) { await server.stop(); journal.add('server', server.root, 'stop', null); } }
        catch (error) { teardownProblems.push(`server stop: ${error.message}`); journal.add('server', server && server.root, 'stop', { message: error.message }, false); }
        const mayDestroy = teardownClean && teardownProblems.length === 0 && (verdict === 'COMPLETE' || verdict === 'BLOCKED');
        let instanceState = 'none';
        try {
            if (server && mayDestroy) { await server.destroy(); journal.add('server', server.root, 'destroy', null); instanceState = 'destroyed'; }
            else if (server) { journal.add('server', server.root, 'quarantine', { verdict, teardownProblems }, false); instanceState = `quarantined:${server.root}`; }
        } catch (error) { teardownProblems.push(`server destroy: ${error.message}`); journal.add('server', server && server.root, 'destroy', { message: error.message }, false); instanceState = `quarantined:${server.root}`; }
        if (teardownProblems.length && verdict !== 'UNKNOWN') {
            reason = `incomplete cleanup (primary: ${verdict}: ${reason}): ${teardownProblems.join('; ')}`;
            verdict = 'UNKNOWN';
        }
        stats.wallMs = Date.now() - t0;
        const summary = { label, verdict, reason, runId, scenarioId, stats, problems, teardownProblems, instanceState,
            ctx: ctx && { userId: ctx.userId, room: ctx.room, actors: ctx.actors }, uploaded, events };
        fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ instance: label, verdict, reason, steps: stats.steps, wallMs: stats.wallMs, instanceState, teardownProblems }));
        opts._result = { ...summary, frames, aux, fx };
    }
    return opts._result;
}

module.exports = { runInstance, forceReset, readUploadedModules, sha256 };
