'use strict';
// HAR-02 — sabotage suite (mode-per-case).
//
// Each mode deliberately injects one failure class inside an isolated F0
// fixture and asserts the harness refuses to fabricate success. A case is
// EFFECTIVE only when: the verdict is the expected non-PASS outcome, the
// sabotage cause AND the first error are both preserved (run.json problems +
// cleanup-journal.jsonl), and the instance root is quarantined exactly when
// cleanup verification is uncertain. A PASS here is the worst outcome — it
// means the harness can be fooled — and exits 9 (SABOTAGE-INEFFECTIVE).
//
// Modes:
//   fence           untracked field-set write lands after the quiescence
//                   barrier (step-mod injected-write.json negative control):
//                   the gate must write a non-'finished' ack -> UNKNOWN.
//   setup-fail      arrange() creates the test user, then throws mid-setup:
//                   journal still records what existed; missing ctx makes the
//                   world unverifiable -> UNKNOWN + quarantine.
//   timeout         a storage/CLI eval exceeds its deadline (pending promise
//                   never resolves): UNKNOWN, no hang, process group reaped.
//   late-response   a real gate response arrives AFTER the step deadline
//                   (forced detached-writer delay): recorded as a late-ack
//                   evidence-loss record, never silently ignored -> UNKNOWN.
//   teardown-object post-PASS, a foreign object is left in the room: baseline
//                   verification fails -> PASS demoted to UNKNOWN + quarantine.
//   teardown-user   post-PASS, the deleted user's users.code row reappears:
//                   verify-deleted fails -> PASS demoted to UNKNOWN + quarantine.
//
// Usage: node har-02.js --mode fence [--http-port 32360 --cli-port 32361]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runScenario, VERDICT_EXIT } = require('./harness');
const { fixtureF0 } = require('./fixture');

const SEED_DB = '/home/happier/screeps/node_modules/@screeps/launcher/init_dist/db.json';
const LOOP = `module.exports.loop = function() { Memory.har2 = { tick: Game.time }; };`;
const SABOTAGE_EVAL_MS = 2500;   // deadline the stalled eval must exceed
const LATE_DELAY_MS = 5000;      // forced detached-writer delay (<= FAULT_MAX_MS)
const LATE_STEP_TIMEOUT = 1500;  // step deadline shorter than the forced delay
const LATE_ACK_GRACE = 15000;    // how long to keep listening for the late ack
const NPC_USER = '2';            // system NPC retained by the packaged seed

function arg(name, dflt) {
    const i = process.argv.indexOf('--' + name);
    return i !== -1 ? process.argv[i + 1] : dflt;
}
const MODE = arg('mode', '');
const HTTP_PORT = Number(arg('http-port', 32360));
const CLI_PORT = Number(arg('cli-port', 32361));

const seedId = crypto.createHash('sha256').update(fs.readFileSync(SEED_DB)).digest('hex').slice(0, 16);

// Shared F0 arrangement (no-creep control variant): user + spawn + RCL claim.
async function arrangeBase(h, fx, journal, label) {
    const username = `har02_${label}_${process.pid}`;
    const userId = await h.createUser({
        username, modules: { main: LOOP }, roomName: fx.room,
        spawn: true, spawnPos: fx.actual.spawn,
    });
    journal.add('user', userId, 'create', { username, spawnPos: fx.actual.spawn });
    await h.dbUpdate('rooms.objects', { $and: [{ room: fx.room }, { type: 'controller' }] }, { level: fx.spec.rcl });
    journal.add('controller', fx.actual.controller.id, 'update', { level: fx.spec.rcl });
    return { userId, room: fx.room,
        moduleHashes: { main: crypto.createHash('sha256').update(LOOP).digest('hex') } };
}

function controlTickCheck(rec) {
    const bad = [];
    if ((rec.creeps || []).length) bad.push('unexpected creep in F0 control world');
    return bad;
}

function readJournal(runDir) {
    try {
        return fs.readFileSync(path.join(runDir, 'cleanup-journal.jsonl'), 'utf8')
            .split('\n').filter(Boolean).map(JSON.parse);
    } catch { return []; }
}

// Per-mode scenario options + post-run evidence checks. Each check:
// {name, pass(res, jrnl), detail} — all must pass for the case to be
// declared effective.
const CASES = {
    // 1. Fence loss: untracked env write lands after the barrier. The step
    //    must yield a non-'finished' ack carrying postBarrierWrites and the
    //    scenario verdict must be UNKNOWN (never PASS).
    'fence': {
        opts: (s) => ({
            fixtureSpec: s, scenarioId: 'HAR-02-FENCE',
            budgets: { maxSteps: 3, WcaseMs: 120000, opTimeoutMs: 15000, stepTimeoutMs: 20000, lateAckGraceMs: 3000 },
            arrange: (h, fx, journal) => arrangeBase(h, fx, journal, 'fence'),
            perTickCheck: controlTickCheck,
            postcondition: () => false,
            beforeStep: async (i, { ctx, server, journal }) => {
                if (i !== 1) return;
                const key = 'memory:' + ctx.userId;
                fs.writeFileSync(path.join(server.root, 'step-control', 'injected-write.json'),
                    JSON.stringify({ op: 'env.set', key, value: '{}' }), { mode: 0o600 });
                journal.add('sabotage', 'injected-write', 'arm', { op: 'env.set', key });
            },
        }),
        checks: [
            ['verdict UNKNOWN/FAIL', r => ['UNKNOWN', 'FAIL'].includes(r.verdict)],
            ['step lost recorded', r => /step \d+ lost/.test(r.verdictReason)],
            ['ack evidence recorded', (r, j) => j.some(x => x.kind === 'gate' &&
                ['rejected', 'late-response'].includes(x.action) && x.ok === false)],
            ['post-barrier write captured', (r, j) => {
                const arm = j.find(x => x.kind === 'sabotage' && x.id === 'injected-write' &&
                    x.action === 'arm' && x.detail && x.detail.key);
                return !!arm && j.some(x => x.kind === 'gate' && x.detail &&
                    (x.detail.postBarrierOps || []).some(op => op.includes(arm.detail.key)));
            }],
            ['quarantined', (r, j) => j.some(x => x.action === 'quarantine')],
        ],
    },
    // 2. Setup failure: user exists, arrangement then throws. The journal must
    //    still record the created user; missing ctx makes the world
    //    unverifiable -> teardown problems + quarantine.
    'setup-fail': {
        opts: (s) => ({
            fixtureSpec: s, scenarioId: 'HAR-02-SETUP-FAIL',
            budgets: { maxSteps: 1, WcaseMs: 120000, lateAckGraceMs: 1000 },
            arrange: async (h, fx, journal) => {
                const ctx = await arrangeBase(h, fx, journal, 'setupfail');
                journal.add('sabotage', 'arrange', 'abort-after-user', { userId: ctx.userId });
                throw new Error('HAR-02 sabotage: arrangement aborted mid-setup after user creation');
            },
            perTickCheck: controlTickCheck,
            postcondition: () => false,
        }),
        checks: [
            ['nonzero exit (UNKNOWN/FAIL/BLOCKED)', r => ['UNKNOWN', 'FAIL', 'BLOCKED'].includes(r.verdict)],
            ['sabotage cause preserved', r => r.problems.some(p => /HAR-02 sabotage/.test(p))],
            ['created user journaled', (r, j) => j.some(x => x.kind === 'user' && x.action === 'create' && x.ok)],
            ['cleanup-skip recorded', r => r.teardownProblems.some(p => /skipped/.test(p))],
            ['cleanup-skip journaled', (r, j) => j.some(x => x.kind === 'teardown' && /skipped/.test(x.action))],
            ['quarantined', (r, j) => j.some(x => x.action === 'quarantine')],
        ],
    },
    // 3. Timeout: a storage eval that never resolves exceeds its deadline.
    //    UNKNOWN (not a fabricated PASS), run completes without hanging, and
    //    server.stop proves the process group was reaped.
    'timeout': {
        opts: (s) => ({
            fixtureSpec: s, scenarioId: 'HAR-02-TIMEOUT',
            budgets: { maxSteps: 3, WcaseMs: 120000, opTimeoutMs: SABOTAGE_EVAL_MS, lateAckGraceMs: 1000 },
            arrange: (h, fx, journal) => arrangeBase(h, fx, journal, 'timeout'),
            supplemental: async (h, ctx) => {
                // Server-side promise never resolves -> no marker is ever
                // printed -> the client deadline must fire. The CLI queue is
                // serialized per-command, so this also proves a late/absent
                // response cannot wedge subsequent evals (teardown still runs).
                await h.eval(`new Promise(function(){ /* HAR-02 stall: never resolves */ })`, SABOTAGE_EVAL_MS);
                return {};
            },
            perTickCheck: controlTickCheck,
            postcondition: () => false,
        }),
        checks: [
            ['verdict UNKNOWN/FAIL', r => ['UNKNOWN', 'FAIL'].includes(r.verdict)],
            ['deadline error preserved', r => r.problems.some(p => /eval timeout/.test(p))],
            ['server stopped (group reaped)', (r, j) => j.some(x => x.kind === 'server' && x.action === 'stop' && x.ok)],
            ['quarantined', (r, j) => j.some(x => x.action === 'quarantine')],
        ],
    },
    // 4. Late response: the forced detached-writer delay pushes the real ack
    //    past the step deadline. The gate is poisoned by the deadline, then
    //    the ack arrives late and must be RECORDED as evidence loss.
    'late-response': {
        opts: (s) => ({
            fixtureSpec: s, scenarioId: 'HAR-02-LATE-RESPONSE',
            budgets: { maxSteps: 3, WcaseMs: 120000, stepTimeoutMs: LATE_STEP_TIMEOUT, lateAckGraceMs: LATE_ACK_GRACE },
            arrange: (h, fx, journal) => arrangeBase(h, fx, journal, 'late'),
            perTickCheck: controlTickCheck,
            postcondition: () => false,
            beforeStep: async (i, { server, journal }) => {
                if (i !== 1) return;
                // step-mod forces a detached updateRoomStatusData() call every
                // incrementGameTime while this file exists; the delay is
                // drained into the quiescence barrier, delaying the real ack.
                fs.writeFileSync(path.join(server.root, 'step-control', 'room-status-fault.json'),
                    JSON.stringify({ delayMs: LATE_DELAY_MS }), { mode: 0o600 });
                journal.add('sabotage', 'room-status-fault', 'arm', { delayMs: LATE_DELAY_MS, stepTimeoutMs: LATE_STEP_TIMEOUT });
            },
        }),
        checks: [
            ['verdict UNKNOWN/FAIL', r => ['UNKNOWN', 'FAIL'].includes(r.verdict)],
            ['deadline fired', r => /lost:.*deadline|lost:.*timeout/i.test(r.verdictReason)],
            ['late ack recorded', (r, j) => j.some(x => x.kind === 'gate' && x.action === 'late-response' && x.ok === false)],
            ['late ack status captured', (r, j) => j.some(x => x.kind === 'gate' && x.action === 'late-response' && x.detail && x.detail.status)],
            ['quarantined', (r, j) => j.some(x => x.action === 'quarantine')],
        ],
    },
    // 5a. Teardown failure (object): after a clean full-budget PASS, a foreign
    //     object is left in the room. Baseline verification must fail ->
    //     PASS demoted to UNKNOWN, primary result + teardown error preserved.
    'teardown-object': {
        opts: (s) => ({
            fixtureSpec: s, scenarioId: 'HAR-02-TEARDOWN-OBJECT', runFullBudget: true,
            budgets: { maxSteps: 3, WcaseMs: 120000, lateAckGraceMs: 1000 },
            arrange: (h, fx, journal) => arrangeBase(h, fx, journal, 'tdobj'),
            perTickCheck: controlTickCheck,
            postcondition: () => false,
            beforeTeardownVerify: async (h, ctx, journal) => {
                const gt = Number(await h.eval(`storage.env.get('gameTime')`));
                const doc = {
                    type: 'creep', room: ctx.room, x: 1, y: 1, name: 'har02sab', user: NPC_USER,
                    body: [{ type: 'move', hits: 100 }], hits: 100, hitsMax: 100,
                    store: {}, storeCapacity: 0, fatigue: 0, spawning: false,
                    ageTime: gt + 1500, notifyWhenAttacked: false, actionLog: {},
                };
                await h.eval(`storage.db['rooms.objects'].insert(${JSON.stringify(doc)})`);
                journal.add('sabotage', 'foreign-creep', 'insert', { user: NPC_USER, name: doc.name });
            },
        }),
        checks: [
            ['PASS demoted to UNKNOWN', r => r.verdict === 'UNKNOWN'],
            ['primary result preserved', r => /primary:/.test(r.verdictReason) && r.stats.steps === 3],
            ['teardown error preserved', r => r.teardownProblems.some(p => /baseline/.test(p))],
            ['verify-baseline failed', (r, j) => j.some(x => x.kind === 'room' && x.action === 'verify-baseline' && x.ok === false)],
            ['quarantined', (r, j) => j.some(x => x.action === 'quarantine')],
        ],
    },
    // 5b. Teardown failure (user): after a clean PASS, the deleted user's
    //     users.code row reappears. verify-deleted must fail -> demotion.
    'teardown-user': {
        opts: (s) => ({
            fixtureSpec: s, scenarioId: 'HAR-02-TEARDOWN-USER', runFullBudget: true,
            budgets: { maxSteps: 3, WcaseMs: 120000, lateAckGraceMs: 1000 },
            arrange: (h, fx, journal) => arrangeBase(h, fx, journal, 'tdusr'),
            perTickCheck: controlTickCheck,
            postcondition: () => false,
            beforeTeardownVerify: async (h, ctx, journal) => {
                await h.eval(`storage.db['users.code'].insert({user:${JSON.stringify(ctx.userId)},` +
                    `branch:'sabotage',activeWorld:false,activeSim:false,` +
                    `modules:{main:'module.exports.loop=function(){}'}})`);
                journal.add('sabotage', 'users.code', 'reinsert', { user: ctx.userId });
            },
        }),
        checks: [
            ['PASS demoted to UNKNOWN', r => r.verdict === 'UNKNOWN'],
            ['primary result preserved', r => /primary:/.test(r.verdictReason) && r.stats.steps === 3],
            ['teardown error preserved', r => r.teardownProblems.some(p => /residue/.test(p))],
            ['verify-deleted failed', (r, j) => j.some(x => x.kind === 'user' && x.action === 'verify-deleted' && x.ok === false && x.detail && x.detail.codeRow)],
            ['quarantined', (r, j) => j.some(x => x.action === 'quarantine')],
        ],
    },
};

async function main() {
    const names = Object.keys(CASES);
    if (!names.includes(MODE)) {
        console.error(`unknown mode '${MODE}' — expected one of: ${names.join(', ')}`);
        process.exitCode = 64;
        return;
    }
    const runId = `har02-${MODE}-${Date.now()}-${process.pid}`;
    const spec = fixtureF0();
    spec.expectCreep = false; // sabotage cases need the world, not the creep
    const def = CASES[MODE];

    const res = await runScenario(Object.assign({
        runId, seedId,
        ports: { http: HTTP_PORT, cli: CLI_PORT },
    }, def.opts(spec)));

    // Effectiveness verdict: every declared check must pass AND the scenario
    // verdict must be a non-PASS (nonzero-exit) outcome. A PASS or a missing
    // evidence record means the harness CAN be fooled — report it loudly.
    const jrnl = readJournal(res.runDir);
    const common = [['no false PASS', r => r.verdict !== 'PASS']];
    const checks = common.concat(def.checks).map(([name, pass]) => ({ name, pass: !!pass(res, jrnl) }));
    const effective = checks.every(c => c.pass) && VERDICT_EXIT[res.verdict] !== 0;
    try {
        fs.writeFileSync(path.join(res.runDir, 'sabotage.json'), JSON.stringify({
            mode: MODE, runId, verdict: res.verdict, verdictReason: res.verdictReason,
            checks, effective, sabotage: 'see cleanup-journal kind=sabotage entries',
        }, null, 2), { mode: 0o600 });
    } catch {}
    console.log(JSON.stringify({ mode: MODE, effective, checks, verdict: res.verdict, runId }));
    if (!effective) {
        console.error(`SABOTAGE-INEFFECTIVE ${MODE}: verdict=${res.verdict} ` +
            checks.filter(c => !c.pass).map(c => c.name).join('; '));
        process.exitCode = 9;
        return;
    }
    process.exitCode = VERDICT_EXIT[res.verdict] ?? 9;
}

main().catch(e => { console.error(e); process.exitCode = 3; });
