'use strict';
// HAR scenario runner.
//
// Admission model (SRV): a disposable instance from e2e/server/instance.js
// carrying step-mod.js + step-preload.js, one StepClient as the exclusive
// step-gate controller, and captureSnapshot() binding every captured frame to
// the ack's calibrated gameTime with journal/coverage evidence. Any doubt
// about identity, exclusivity or coherence fails closed.
//
// Verdict taxonomy:
//   PASS    - postcondition observed, all per-tick assertions held, teardown clean
//   FAIL    - an observed violation (assertion broke, budget expired w/o result)
//   BLOCKED - fixture/admission impossible; infra refused before stepping
//   UNKNOWN - evidence lost (gate/snapshot/identity/cleanup uncertainty)
//
// PASS additionally requires clean teardown; a cleanup failure demotes any
// verdict to UNKNOWN and quarantines the instance root.
const fs = require('fs');
const path = require('path');
const { createIsolatedServer } = require('../server/instance');
const { StepClient } = require('../server/step-client');
const { captureSnapshot } = require('../server/snapshot-client');
const { Harness } = require('../harness');
const { resolveFixture, validateFixture, FixtureError } = require('./fixture');
const { TraceRecorder } = require('./trace');

const RUNS_DIR = path.join(__dirname, '.runs');
const STEP_MOD = path.join(__dirname, '..', 'server', 'step-mod.js');
const STEP_PRELOAD = path.join(__dirname, '..', 'server', 'step-preload.js');
const VERDICT_EXIT = { PASS: 0, FAIL: 1, BLOCKED: 2, UNKNOWN: 3 };

// Tee stdout/stderr into <runDir>/run.log so probe output is preserved.
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

class CleanupJournal {
    constructor(runDir, runId, scenarioId) {
        this.file = path.join(runDir, 'cleanup-journal.jsonl');
        this.runId = runId; this.scenarioId = scenarioId;
        fs.writeFileSync(this.file, '', { mode: 0o600, flag: 'wx' });
    }
    add(kind, id, action, detail, ok = true) {
        const rec = { t: new Date().toISOString(), runId: this.runId, scenarioId: this.scenarioId, kind, id, action, detail, ok };
        fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', { mode: 0o600 });
        return rec;
    }
}

// opts:
//   runId, scenarioId, seedId, ports:{http,cli}
//   fixtureSpec            fixture spec (fixtureF0() etc.) or null
//   arrange(h, fx, journal) async -> ctx {userId, room, moduleHashes, ...}
//   supplemental(h, ctx)   async -> {intents, notifications, errors, userCpu}
//   perTickCheck(rec, prev, ctx) -> string[] problems (violation = FAIL)
//   postcondition(rec, ctx) -> bool
//   beforeStep(i, {h, ctx, server, gate, journal, runDir, budgets})
//                            async hook fired after admission checks, before
//                            each gated step (sabotage/fault injection point)
//   beforeTeardownVerify(h, ctx, journal)
//                            async hook fired after destroyUser but before the
//                            baseline/deletion verification reads
//   budgets {maxSteps, WcaseMs, opTimeoutMs, stepTimeoutMs, settleMs,
//            lateAckGraceMs}
//   expectBlocked          true when the fixture is meant to be refused
async function runScenario(opts) {
    const { runId, scenarioId, seedId } = opts;
    const budgets = Object.assign({ maxSteps: 40, WcaseMs: 300000, opTimeoutMs: 15000, stepTimeoutMs: 20000, settleMs: 250, lateAckGraceMs: 8000 }, opts.budgets);
    const runDir = path.join(RUNS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    attachLog(runDir);
    const journal = new CleanupJournal(runDir, runId, scenarioId);
    const problems = [];
    const stats = { steps: 0, gameTimeStart: null, gameTimeEnd: null, postconditionMet: false, postconditionStep: null };
    let verdict = 'UNKNOWN', verdictReason = 'not completed';
    let server = null, gate = null, h = null, trace = null, ctx = null, fx = null;
    let teardownClean = false, teardownProblems = [];
    const wcaseDeadline = Date.now() + budgets.WcaseMs;

    const result = () => ({ verdict, verdictReason, runId, scenarioId, runDir, problems, stats, teardownProblems, ctx, fx });

    try {
        // --- admission ------------------------------------------------------
        server = await createIsolatedServer({
            runId, httpPort: opts.ports.http, cliPort: opts.ports.cli,
            mods: [STEP_MOD], preload: STEP_PRELOAD,
        });
        journal.add('server', server.root, 'create', { ports: opts.ports });
        await server.start();
        journal.add('server', server.root, 'start', null);
        await server.assertIdentity();
        if (!fs.existsSync(path.join(server.root, 'step-backend-cron-disabled.json'))) {
            throw new Error('BLOCKED: backend cron disable marker missing');
        }
        journal.add('server', server.root, 'identity', { marker: server.marker });

        gate = await StepClient.connect(server.root, { timeoutMs: 15000 });
        journal.add('gate', 'step-control', 'connect', { session: gate.ready.session });

        h = new Harness({ cliHost: server.cliOptions.host, cliPort: server.cliOptions.port });
        await h.connect();
        journal.add('cli', `${server.cliOptions.host}:${server.cliOptions.port}`, 'connect', null);
        // Fresh-server quirk (documented in tick-protocol/quiescence docs):
        // runtime data requires these cache inputs or the runner dies on
        // JSON.parse(undefined).
        await h.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])", budgets.opTimeoutMs);
        journal.add('env', 'roomStatusData/accessibleRooms', 'seed', null);

        // --- fixture resolution + arrangement -------------------------------
        if (opts.fixtureSpec) {
            fx = await resolveFixture((code, t) => h.eval(code, t || budgets.opTimeoutMs), opts.fixtureSpec);
            journal.add('fixture', fx.spec.id, 'resolve', { room: fx.room, actual: fx.actual, distances: fx.distances });
            fs.writeFileSync(path.join(runDir, 'fixture.json'), JSON.stringify(fx, (k, v) => (k === '_distMulti' ? undefined : v), 2), { mode: 0o600 });
        }
        ctx = await opts.arrange(h, fx, journal);
        if (!ctx || !ctx.userId || !ctx.room) throw new Error('arrange() must return {userId, room}');

        if (fx) {
            const val = await validateFixture((code, t) => h.eval(code, t || budgets.opTimeoutMs), fx, ctx.userId);
            journal.add('fixture', fx.spec.id, 'validate', { ok: val.ok, problems: val.problems, checks: val.checks.filter(c => !c.pass) });
            fs.writeFileSync(path.join(runDir, 'fixture-validation.json'), JSON.stringify(val, null, 2), { mode: 0o600 });
            if (!val.ok) {
                if (opts.expectBlocked) { verdict = 'BLOCKED'; verdictReason = `fixture refused: ${val.problems.join('; ')}`; }
                else { verdict = 'BLOCKED'; verdictReason = `fixture invalid: ${val.problems.join('; ')}`; }
                return result();
            }
        }
        if (opts.expectBlocked) {
            verdict = 'FAIL'; verdictReason = 'impossible fixture was NOT refused';
            return result();
        }

        // --- exclusive gate + identity admission ----------------------------
        if (gate.failed || gate.busy) throw new Error('UNKNOWN: step gate not exclusively available');
        await server.assertIdentity();
        journal.add('gate', 'step-control', 'admit', { sequence: gate.sequence });

        trace = new TraceRecorder(runDir, {
            runId, scenarioId, seedId,
            fixture: fx && { id: fx.spec.id, room: fx.room, actual: fx.actual, distances: fx.distances, terrainSha256: fx.terrainSha256 },
            moduleHashes: ctx.moduleHashes || {},
            budgets,
        });

        const snapFixture = { rooms: [ctx.room], users: [ctx.userId] };
        const capture = async (phase, stepIndex, ack) => {
            const snap = await captureSnapshot(h.cli, server.root, ack, snapFixture, { settleMs: budgets.settleMs });
            const extra = opts.supplemental ? await opts.supplemental(h, ctx) : {};
            return trace.record({ phase, stepIndex, ack, snap, extra, runId, scenarioId, seedId, moduleHashes: ctx.moduleHashes || {} });
        };

        // S(T): the initial capture requires an ack? No — captureSnapshot binds
        // to the previous ack's barrier evidence. Before the first step there
        // is no ack; the pre-step frame uses a CLI field read instead and is
        // flagged phase:'pre-step' (still evidence, weaker binding).
        const initial = await initialFrame(h, ctx, opts.supplemental);
        stats.gameTimeStart = initial.gameTime;
        let prev = trace.record({
            phase: 'pre-step', stepIndex: 0, ack: null,
            snap: { ok: true, snapshot: initial, problems: [], evidence: null },
            extra: initial.extra, runId, scenarioId, seedId, moduleHashes: ctx.moduleHashes || {},
        });

        // --- S(T) -> step -> S(T+1) loop ------------------------------------
        let done = false;
        for (let i = 1; i <= budgets.maxSteps; i++) {
            if (Date.now() > wcaseDeadline) { problems.push(`Wcase exceeded at step ${i}`); verdict = 'FAIL'; verdictReason = 'wall-clock budget exceeded'; break; }
            await server.assertIdentity();
            if (gate.failed || gate.busy) { verdict = 'UNKNOWN'; verdictReason = 'step gate became unavailable'; break; }
            if (opts.beforeStep) await opts.beforeStep(i, { h, ctx, server, gate, journal, runDir, budgets });
            let ack;
            try { ack = await gate.step({ timeoutMs: budgets.stepTimeoutMs }); }
            catch (error) {
                verdict = 'UNKNOWN'; verdictReason = `step ${i} lost: ${error.message}`;
                // A response that arrives after the deadline (or an ack that was
                // written but rejected) is still evidence: record it, never
                // silently ignore it.
                const late = await readAckLate(server && server.root, i, budgets.lateAckGraceMs);
                if (late && late.ack) {
                    const pbWrites = late.ack.postBarrierWrites || [];
                    const pb = pbWrites.length;
                    const tag = late.waitedMs > 50 ? 'late ack' : 'rejected ack';
                    journal.add('gate', `ack-${i}`, late.waitedMs > 50 ? 'late-response' : 'rejected',
                        { status: late.ack.status, postBarrierWrites: pb, postBarrierOps: pbWrites.map(w => `${w.op} ${w.key || ''}`.trim()), waitedMs: late.waitedMs }, false);
                    problems.push(`step ${i}: ${tag} recorded status=${late.ack.status} postBarrierWrites=${pb}`);
                    verdictReason += `; ${tag} status=${late.ack.status}`;
                } else {
                    journal.add('gate', `ack-${i}`, 'missing', { waitedMs: late && late.waitedMs }, false);
                }
                break;
            }
            stats.steps = i;
            // Core coherence assertions — scenarios cannot opt out. A
            // non-contiguous ack sequence means a cycle ran (or was claimed)
            // that this controller did not request; a gameTime gap means a
            // tick executed unobserved between two gated frames.
            if (!Number.isInteger(ack.sequence) || ack.sequence !== i) {
                problems.push(`step ${i}: ack sequence ${ack.sequence} breaks contiguity`);
                verdict = 'FAIL'; verdictReason = `ack sequence discontinuity at step ${i}`;
                break;
            }
            const rec = await capture('post-step', i, ack);
            stats.gameTimeEnd = rec.gameTime;
            if (!rec.snapshotOk) {
                verdict = 'UNKNOWN'; verdictReason = `snapshot ${i} incoherent: ${rec.problems.join('; ')}`;
                break;
            }
            if (prev.gameTime !== null && rec.gameTime !== prev.gameTime + 1) {
                problems.push(`step ${i}: gameTime discontinuity ${prev.gameTime} -> ${rec.gameTime}`);
                verdict = 'FAIL'; verdictReason = `gameTime discontinuity at step ${i}`;
                break;
            }
            if (opts.perTickCheck) {
                const bad = opts.perTickCheck(rec, prev, ctx) || [];
                for (const b of bad) problems.push(`step ${i}: ${b}`);
                if (bad.length) { verdict = 'FAIL'; verdictReason = bad.join('; '); break; }
            }
            prev = rec;
            if (opts.postcondition && opts.postcondition(rec, ctx)) {
                stats.postconditionMet = true; stats.postconditionStep = i;
                done = true;
                break;
            }
        }
        if (verdict === 'UNKNOWN' && verdictReason === 'not completed') {
            if (done) { verdict = 'PASS'; verdictReason = `postcondition at step ${stats.postconditionStep}`; }
            else if (opts.runFullBudget && stats.steps === budgets.maxSteps) {
                verdict = 'PASS'; verdictReason = `full ${budgets.maxSteps}-step budget observed without violation`;
            } else { verdict = 'FAIL'; verdictReason = `budget ${budgets.maxSteps} steps expired without postcondition`; }
        }
    } catch (error) {
        if (error instanceof FixtureError) {
            verdict = 'BLOCKED'; verdictReason = `fixture refused: ${error.problems.join('; ')}`;
        } else if (verdict === 'UNKNOWN' && verdictReason === 'not completed') {
            verdictReason = error.message;
        }
        problems.push(error.message);
        journal.add('scenario', scenarioId, 'error', { message: error.message }, false);
    } finally {
        // --- teardown ---------------------------------------------------------
        // Order: delete only our own objects+user -> verify -> close -> stop ->
        // destroy (only when teardown verified AND verdict permits).
        try {
            if (h && ctx && ctx.userId) {
                await h.destroyUser(ctx.userId, ctx.room);
                journal.add('user', ctx.userId, 'delete', { room: ctx.room });
                if (ctx.creepId) journal.add('creep', ctx.creepId, 'delete-via-user', { name: ctx.creepName });
            } else if (h) {
                // The CLI connected, so arrangement may have created state the
                // scenario never reported back (arrange threw mid-setup). The
                // journal keeps what was recorded; the world is unverifiable.
                teardownProblems.push('user cleanup skipped: arrange() returned no ctx; world state unverifiable');
                journal.add('teardown', scenarioId, 'user-cleanup-skipped', { ctx: !!ctx }, false);
            }
            if (opts.beforeTeardownVerify && h && ctx) {
                try {
                    await opts.beforeTeardownVerify(h, ctx, journal);
                } catch (error) {
                    teardownProblems.push(`beforeTeardownVerify: ${error.message}`);
                    journal.add('teardown', scenarioId, 'hook', { message: error.message }, false);
                }
            }
            if (h && ctx && ctx.room && fx) {
                const remaining = await h.eval(`storage.db['rooms.objects'].find({room:${JSON.stringify(ctx.room)}})`, budgets.opTimeoutMs);
                const extra = remaining.filter(o => !fx.objectsBaseline.includes(o._id));
                const missing = fx.objectsBaseline.filter(id => !remaining.some(o => o._id === id));
                const ctrl = remaining.find(o => o.type === 'controller');
                const clean = extra.length === 0 && missing.length === 0 && ctrl && !ctrl.user && ctrl.level === 0;
                journal.add('room', ctx.room, 'verify-baseline', { extra: extra.map(o => o._id), missing, controller: ctrl && { user: ctrl.user, level: ctrl.level } }, clean);
                if (!clean) teardownProblems.push('room baseline not restored');
                const mem = await h.eval(`storage.env.get(${JSON.stringify('memory:' + ctx.userId)})`, budgets.opTimeoutMs);
                const userRow = await h.eval(`storage.db.users.findOne({_id:${JSON.stringify(ctx.userId)}})`, budgets.opTimeoutMs);
                const codeRow = await h.eval(`storage.db['users.code'].findOne({user:${JSON.stringify(ctx.userId)}})`, budgets.opTimeoutMs);
                const gone = mem === null && userRow === null && codeRow === null;
                journal.add('user', ctx.userId, 'verify-deleted', { mem, userRow: !!userRow, codeRow: !!codeRow }, gone);
                if (!gone) teardownProblems.push('user/memory residue');
            } else if (h) {
                teardownProblems.push('cleanup verification skipped: ctx or fixture missing; teardown state unverifiable');
                journal.add('teardown', scenarioId, 'verify-skipped', { ctx: !!ctx, fx: !!fx }, false);
            }
            teardownClean = teardownProblems.length === 0;
        } catch (error) {
            teardownProblems.push(`teardown: ${error.message}`);
            journal.add('teardown', scenarioId, 'verify', { message: error.message }, false);
        }
        try { if (h) { h.close(); journal.add('cli', null, 'close', null); } } catch (e) { teardownProblems.push(`cli close: ${e.message}`); }
        try {
            if (server) { await server.stop(); journal.add('server', server.root, 'stop', null); }
        } catch (error) { teardownProblems.push(`server stop: ${error.message}`); journal.add('server', server && server.root, 'stop', { message: error.message }, false); }
        const mayDestroy = teardownClean && (verdict === 'PASS' || verdict === 'BLOCKED');
        try {
            if (server && mayDestroy) { await server.destroy(); journal.add('server', server.root, 'destroy', null); }
            else if (server) journal.add('server', server.root, 'quarantine', { verdict, teardownProblems }, false);
        } catch (error) { teardownProblems.push(`server destroy: ${error.message}`); journal.add('server', server && server.root, 'destroy', { message: error.message }, false); }

        if (teardownProblems.length) {
            // The primary result is preserved inside the demotion reason so a
            // sabotaged teardown can never erase evidence of an observed PASS.
            if (verdict === 'PASS') { verdict = 'UNKNOWN'; verdictReason = `incomplete cleanup (primary: ${verdictReason}): ${teardownProblems.join('; ')}`; }
            else if (verdict !== 'UNKNOWN') { verdictReason += `; cleanup issues: ${teardownProblems.join('; ')}`; }
        }
        fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(result(), (k, v) => (k === '_distMulti' ? undefined : v), 2), { mode: 0o600 });
        console.log(JSON.stringify({ verdict, verdictReason, runId, scenarioId, runDir, stats, problems, teardownProblems }));
    }
    return result();
}

// After a lost step, check whether the gate wrote the ack anyway — either it
// was already there and failed validation (rejected), or it arrived after the
// deadline (late response). Both are recorded as evidence loss, never ignored.
// Returns {ack, waitedMs} or {ack:null, waitedMs} when nothing showed up.
async function readAckLate(root, sequence, graceMs) {
    if (!root) return null;
    const file = path.join(root, 'step-control', `ack-${sequence}.json`);
    const t0 = Date.now();
    const deadline = t0 + Math.max(0, graceMs || 0);
    for (;;) {
        try {
            return { ack: JSON.parse(fs.readFileSync(file, 'utf8')), waitedMs: Date.now() - t0 };
        } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) return null;
            if (Date.now() >= deadline) return { ack: null, waitedMs: Date.now() - t0 };
            await new Promise(r => setTimeout(r, 100));
        }
    }
}

// Pre-step frame: plain CLI field read (no ack exists yet). Weaker binding —
// marked phase 'pre-step'; the first post-step frame re-establishes the
// ack-bound chain.
async function initialFrame(h, ctx, supplemental) {
    // Chunked read: full actionLog rows make big-object rooms exceed the
    // ~10 KB CLI pipe in a single response (observed on eco-02-d-fulltarget
    // with 8 blocker creeps). Each chunk stays under the ceiling; frame-0
    // is a pre-step baseline, so a two-eval read is coherent enough.
    const objects = [].concat(
        await h.eval(`storage.db['rooms.objects'].find({$and:[{room:${JSON.stringify(ctx.room)}},{type:'creep'}]})`, 15000),
        await h.eval(`storage.db['rooms.objects'].find({$and:[{room:${JSON.stringify(ctx.room)}},{type:{$ne:'creep'}}]})`, 15000));
    const gameTime = Number(await h.eval(`storage.env.get('gameTime')`, 10000));
    const memRaw = await h.eval(`storage.env.get(${JSON.stringify('memory:' + ctx.userId)})`, 10000);
    const activeRooms = await h.eval(`storage.env.smembers('activeRooms')`, 10000);
    const extra = supplemental ? await supplemental(h, ctx) : {};
    return {
        gameTime, activeRooms: (activeRooms || []).slice().sort(),
        objects: { [ctx.room]: objects },
        memory: { [ctx.userId]: memRaw ? JSON.parse(memRaw) : null },
        queues: 'asserted-by-protocol-not-read',
        ttl: null, extra,
    };
}

module.exports = { runScenario, VERDICT_EXIT, RUNS_DIR };
