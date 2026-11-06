'use strict';
// restart-probe: process-loss fault during a gated hold. Kills ONE engine
// participant (the runner) of OUR isolated instance only, proven ours via the
// participant file + /proc cwd + process-group leader cwd. Expected:
//   - the next StepClient.step() fails closed (participant epoch check ->
//     rejection, client poisoned, no command file published, gameTime frozen);
//   - the launcher auto-restarts the child (start.js:143-149 restarts any
//     exited child after ~1s); the restarted process re-runs mods, hits the
//     'wx' participant file and exits 78 -> observable restart crash loop.
//   Either way the recorded participant epoch no longer matches a live engine
//   participant and integrity.participants() must keep rejecting.
// This run always ends poisoned: the instance is stopped and LEFT in place
// (quarantine) like step-disconnect-probe — never destroyed, never reused.
// Ports 32326/32327. Re-runnable.
// Usage: ~/.local/node22/bin/node e2e/server/restart-probe.js
const path = require('path'), fs = require('fs');
const { setTimeout: sleep } = require('timers/promises');
const { createIsolatedServer } = require('./instance');
const { StepClient } = require('./step-client');
const { ScreepsCLI } = require('../cli-client');
const integrity = require('./step-integrity');

const MOD = path.join(__dirname, 'step-mod.js');
const PRELOAD = path.join(__dirname, 'step-preload.js');
const OBSERVE_MS = 15000;
const save = (root, name, value) => fs.writeFileSync(path.join(root, name),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });

function statFields(pid) {
    try {
        const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
        return { state: f[0], group: +f[2], start: f[19] };
    } catch { return null; }
}
function cwdOf(pid) { try { return fs.realpathSync(`/proc/${pid}/cwd`); } catch { return null; } }
function cmdlineOf(pid) { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { return null; } }
function groupMembersOf(root) {
    const out = [];
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const pid = +name;
        if (cwdOf(pid) === root) out.push({ pid, cmdline: cmdlineOf(pid), state: (statFields(pid) || {}).state });
    }
    return out;
}
// Kill only a pid we can prove belongs to this instance: the participant file
// recorded it, its cwd is our root, and its process-group leader's cwd is our
// root (the leader is the launcher). Never kill the leader itself.
function proveOwned(pid, root, recorded) {
    const st = statFields(pid);
    if (!st || st.state === 'Z') throw Error('participant already dead');
    if (st.start !== recorded.start) throw Error('participant start-time drift; refusing to kill');
    if (cwdOf(pid) !== root) throw Error('participant cwd mismatch; refusing to kill');
    if (st.group === pid) throw Error('participant is group leader; refusing to kill');
    if (cwdOf(st.group) !== root) throw Error('group leader cwd mismatch; refusing to kill');
    return st.group;
}

(async () => {
    const runId = `restart-${Date.now()}-${process.pid}`;
    const server = await createIsolatedServer({
        runId, httpPort: 32326, cliPort: 32327,
        mods: [MOD], preload: PRELOAD
    });
    const result = { runId, checks: {}, timeline: [], verdict: 'UNKNOWN' };
    let cli, failure, gate;
    try {
        await server.start(); await server.assertIdentity();
        gate = await StepClient.connect(server.root, { timeoutMs: 15000 });
        cli = new ScreepsCLI(server.cliOptions.host, server.cliOptions.port);
        await cli.connect();
        await cli.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])", 10000);
        const t0 = Number(await cli.eval("storage.env.get('gameTime')", 10000));
        const participantFile = path.join(server.root, 'step-participant-runner.json');
        const recorded = JSON.parse(fs.readFileSync(participantFile, 'utf8'));
        const launcherPid = proveOwned(recorded.pid, server.root, recorded);
        result.killed = { type: recorded.type, pid: recorded.pid, start: recorded.start, launcherPid };
        // Fault: SIGKILL the runner during a hold (no command in flight).
        process.kill(recorded.pid, 'SIGKILL');
        const deadAt = Date.now();
        while (statFields(recorded.pid) && Date.now() - deadAt < 5000) await sleep(50);
        result.checks.pidGone = !statFields(recorded.pid);
        // The gate must fail closed rather than produce an ack.
        let stepError = null;
        try { await gate.step({ timeoutMs: 8000 }); }
        catch (e) { stepError = String(e.message || e); }
        result.stepError = stepError;
        result.checks.stepRejected = stepError !== null;
        result.checks.clientPoisoned = gate.failed === true && fs.existsSync(path.join(server.root, 'step-control', 'poisoned.json'));
        const controlEntries = fs.readdirSync(path.join(server.root, 'step-control')).sort();
        result.checks.noCommandPublished = !controlEntries.some(x => /^command-\d+\.json$/.test(x));
        result.controlEntries = controlEntries;
        result.checks.gameTimeFrozen = Number(await cli.eval("storage.env.get('gameTime')", 10000)) === t0;
        // Observe launcher auto-restart: launcher.log 'exited ... restarting'
        // lines plus transient runner pids (each re-register fails -> exit 78).
        const observed = new Map();
        const deadline = Date.now() + OBSERVE_MS;
        while (Date.now() < deadline) {
            for (const p of groupMembersOf(server.root)) {
                if (/runner/.test(p.cmdline || '') && p.pid !== recorded.pid) observed.set(p.pid, { pid: p.pid, cmdline: p.cmdline, seenAt: Date.now() });
            }
            result.timeline.push({ at: Date.now(), members: groupMembersOf(server.root).map(p => `${p.pid}:${(p.cmdline || '').split(' ').pop()}`) });
            await sleep(500);
        }
        result.restartedRunnerPids = [...observed.values()];
        const launcherLog = fs.readFileSync(path.join(server.root, 'launcher.log'), 'utf8');
        result.launcherRestartLines = launcherLog.split('\n').filter(l => /exited with code|restarting/.test(l));
        const runnerLogTail = (() => {
            try {
                const f = fs.readdirSync(path.join(server.root, 'logs')).find(x => /^engine_runner.*\.log$/.test(x));
                return f ? fs.readFileSync(path.join(server.root, 'logs', f), 'utf8').split('\n').slice(-40) : null;
            } catch { return null; }
        })();
        result.runnerLogTail = runnerLogTail;
        // Participant epoch must now differ and be detected.
        let epochError = null;
        try { integrity.participants(server.root, gate.baseline); }
        catch (e) { epochError = String(e.message || e); }
        result.epochError = epochError;
        result.checks.epochDetected = epochError !== null;
        result.participantFileAfter = JSON.parse(fs.readFileSync(participantFile, 'utf8'));
        result.checks.participantFileStillStale = result.participantFileAfter.pid === recorded.pid;
        result.checks.restartObserved = result.launcherRestartLines.length > 0 || result.restartedRunnerPids.length > 0;
        // Instance identity must still hold for a clean stop of OUR group.
        await server.assertIdentity();
        result.checks.identityIntact = true;
        save(server.root, 'probe-restart-evidence.json', result);
        result.verdict = Object.values(result.checks).every(Boolean) ? 'EXPECTED-UNKNOWN' : 'FAIL';
    } catch (e) { failure = e; result.verdict = 'UNKNOWN'; result.error = String(e && e.stack || e); try { save(server.root, 'probe-restart-evidence.json', result); } catch {} }
    finally {
        if (cli) cli.close();
        try { await server.stop(); console.error(`quarantined artifacts (by design): ${server.root}`); }
        catch (e) { failure = Error(`${failure ? failure.message + '; ' : ''}cleanup failed: ${e.message}`); result.verdict = 'UNKNOWN'; }
    }
    console.log(JSON.stringify({ status: 'experimental-only', verdict: result.verdict, runId, killed: result.killed, stepError: result.stepError, epochError: result.epochError, checks: result.checks, restartedRunnerPids: (result.restartedRunnerPids || []).map(p => p.pid), launcherRestartLines: result.launcherRestartLines, error: result.error || (failure && String(failure)) }));
    if (result.verdict !== 'EXPECTED-UNKNOWN') process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
