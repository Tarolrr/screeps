'use strict';
// overhead-probe: honest CPU/latency measurement of the step gate. This is
// MEASUREMENT ONLY — it is not a coherence proof and does not fence writers.
//
// Part A (ports 32330/32331): gated instance. Per-step wall latency around
// StepClient.step(), plus process CPU (utime+stime jiffies from
// /proc/<pid>/stat, fields 14-15 -> offsets 11-12 after comm) for every process
// whose /proc/<pid>/cwd is our run root. Also CPU during a 10s gated hold
// (scheduler parked, no loop running).
// Part B (ports 32332/32333): baseline isolated instance with NO step-mod and
// NO preload running its normal tick loop (mainLoopMinDuration via
// system.setTickDuration). Measures gameTime advance rate and CPU of its own
// process tree over the same observation style. NOTE: the baseline runs fully
// stock, so backend cron is ENABLED there (it activates rooms and writes) —
// its CPU is included and biases the comparison upward versus the gated,
// cron-disabled instance. That asymmetry is reported, not hidden.
// Both parts run sequentially. Reports raw numbers; interpretation is left to
// docs/server/quiescence-probes.md.
// Usage: ~/.local/node22/bin/node e2e/server/overhead-probe.js [--steps N]
const path = require('path'), fs = require('fs');
const { setTimeout: sleep } = require('timers/promises');
const { createIsolatedServer } = require('./instance');
const { StepClient } = require('./step-client');
const { ScreepsCLI } = require('../cli-client');

const MOD = path.join(__dirname, 'step-mod.js');
const PRELOAD = path.join(__dirname, 'step-preload.js');
const STEPS = Number(process.argv[process.argv.indexOf('--steps') + 1]) || 8;
const save = (root, name, value) => fs.writeFileSync(path.join(root, name),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });

function statCpu(pid) {
    try {
        const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
        return +f[11] + +f[12]; // utime + stime jiffies
    } catch { return null; }
}
function rootProcesses(root) {
    const out = {};
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const pid = +name;
        let cwd;
        try { cwd = fs.realpathSync(`/proc/${pid}/cwd`); } catch { continue; }
        if (cwd !== root) continue;
        let cmdline;
        try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { cmdline = ''; }
        const cpu = statCpu(pid);
        if (cpu !== null) out[pid] = { pid, name: classify(cmdline), cpu };
    }
    return out;
}
function classify(cmdline) {
    if (/engine[/\\]dist[/\\]main\.js|engine[/\\]main\.js/.test(cmdline)) return 'engine_main';
    if (/runner\.js/.test(cmdline)) return 'engine_runner';
    if (/processor\.js/.test(cmdline)) return 'engine_processor';
    if (/@screeps[/\\]backend/.test(cmdline)) return 'backend';
    if (/@screeps[/\\]storage/.test(cmdline)) return 'storage';
    if (/screeps\.js/.test(cmdline)) return 'launcher';
    return (cmdline || '?').split(' ').pop() || '?';
}
const totalCpu = procs => Object.values(procs).reduce((a, p) => a + p.cpu, 0);
const cpuDelta = (a, b) => {
    const per = {};
    for (const pid of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[pid] && b[pid]) per[b[pid].name] = (per[b[pid].name] || 0) + (b[pid].cpu - a[pid].cpu);
    }
    return per;
};

async function gatedPart() {
    const runId = `ovh-gated-${Date.now()}-${process.pid}`;
    const server = await createIsolatedServer({
        runId, httpPort: 32330, cliPort: 32331,
        mods: [MOD], preload: PRELOAD
    });
    const result = { runId, root: server.root, steps: [], verdict: 'UNKNOWN' };
    let cli, failure, gate;
    try {
        await server.start(); await server.assertIdentity();
        gate = await StepClient.connect(server.root, { timeoutMs: 15000 });
        cli = new ScreepsCLI(server.cliOptions.host, server.cliOptions.port);
        await cli.connect();
        await cli.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])", 10000);
        const room = await cli.eval("storage.db['rooms.objects'].findOne({type:'controller'}).then(x=>x && x.room)", 10000);
        // Idle-hold CPU: gate parked, no loop.
        const h0 = rootProcesses(server.root);
        await sleep(10000);
        const h1 = rootProcesses(server.root);
        result.hold = { ms: 10000, cpuJiffies: cpuDelta(h0, h1), totalJiffies: totalCpu(h1) - totalCpu(h0) };
        for (let i = 0; i < STEPS; i++) {
            await cli.eval(`storage.env.sadd('activeRooms',${JSON.stringify(room)})`, 10000);
            const p0 = rootProcesses(server.root);
            const t0 = process.hrtime.bigint();
            const ack = await gate.step({ timeoutMs: 20000 });
            const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
            const p1 = rootProcesses(server.root);
            result.steps.push({ sequence: ack.sequence, latencyMs: Math.round(latencyMs * 100) / 100, cpuJiffies: cpuDelta(p0, p1), status: ack.status });
        }
        result.checks = { allAcked: result.steps.every(s => s.status === 'cycle-finished-unverified') };
        save(server.root, 'probe-overhead-gated.json', result);
        result.verdict = result.checks.allAcked ? 'PASS' : 'FAIL';
    } catch (e) { failure = e; result.verdict = 'UNKNOWN'; result.error = String(e && e.stack || e); try { save(server.root, 'probe-overhead-gated.json', result); } catch {} }
    finally {
        if (cli) cli.close();
        try { await server.stop(); if (!failure && result.verdict === 'PASS') await server.destroy(); else console.error(`quarantined artifacts: ${server.root}`); }
        catch (e) { failure = Error(`${failure ? failure.message + '; ' : ''}cleanup failed: ${e.message}`); result.verdict = 'UNKNOWN'; }
    }
    if (failure) result.error = String(failure.stack || failure);
    return result;
}

async function baselinePart() {
    const runId = `ovh-base-${Date.now()}-${process.pid}`;
    const server = await createIsolatedServer({ runId, httpPort: 32332, cliPort: 32333, mods: [] });
    const result = { runId, root: server.root, verdict: 'UNKNOWN' };
    let cli, failure;
    try {
        await server.start(); await server.assertIdentity();
        cli = new ScreepsCLI(server.cliOptions.host, server.cliOptions.port);
        await cli.connect();
        let tickDuration = null;
        try { tickDuration = await cli.eval("system.setTickDuration(500)", 10000); }
        catch (e) { result.setTickDurationError = String(e.message || e); }
        result.setTickDuration = tickDuration;
        result.tickDurationReadback = await cli.eval("system.getTickDuration()", 10000).catch(() => null);
        // Stock cron (enabled here) activates rooms on its own; record a room
        // name for context only, no seeding needed.
        const room = await cli.eval("storage.db['rooms.objects'].findOne({type:'controller'}).then(x=>x && x.room)", 10000);
        // Settle ~3s, then measure over 20s.
        await sleep(3000);
        const g0 = Number(await cli.eval("storage.env.get('gameTime')", 10000));
        const p0 = rootProcesses(server.root);
        const t0 = Date.now();
        await sleep(20000);
        const g1 = Number(await cli.eval("storage.env.get('gameTime')", 10000));
        const p1 = rootProcesses(server.root);
        const wallMs = Date.now() - t0;
        result.measurement = {
            wallMs, gameTimeDelta: g1 - g0,
            ticksPerSecond: (g1 - g0) / (wallMs / 1000),
            cpuJiffies: cpuDelta(p0, p1),
            totalJiffies: totalCpu(p1) - totalCpu(p0),
            cpuPerTickJiffies: (g1 - g0) > 0 ? (totalCpu(p1) - totalCpu(p0)) / (g1 - g0) : null
        };
        result.room = room;
        result.checks = { gameTimeAdvanced: g1 > g0 };
        save(server.root, 'probe-overhead-baseline.json', result);
        result.verdict = result.checks.gameTimeAdvanced ? 'PASS' : 'FAIL';
    } catch (e) { failure = e; result.verdict = 'UNKNOWN'; result.error = String(e && e.stack || e); try { save(server.root, 'probe-overhead-baseline.json', result); } catch {} }
    finally {
        if (cli) cli.close();
        try { await server.stop(); if (!failure && result.verdict === 'PASS') await server.destroy(); else console.error(`quarantined artifacts: ${server.root}`); }
        catch (e) { failure = Error(`${failure ? failure.message + '; ' : ''}cleanup failed: ${e.message}`); result.verdict = 'UNKNOWN'; }
    }
    if (failure) result.error = String(failure.stack || failure);
    return result;
}

(async () => {
    const gated = await gatedPart();
    console.log(JSON.stringify({ phase: 'gated', verdict: gated.verdict, runId: gated.runId, hold: gated.hold, steps: gated.steps, error: gated.error }));
    const base = await baselinePart();
    console.log(JSON.stringify({ phase: 'baseline', verdict: base.verdict, runId: base.runId, measurement: base.measurement, tickDurationReadback: base.tickDurationReadback, error: base.error }));
    console.log(JSON.stringify({
        status: 'measurement-only not a coherence proof',
        gatedRunId: gated.runId, baselineRunId: base.runId,
        note: 'CPU numbers are utime+stime jiffies (sysconf _SC_CLK_TCK, typically 100/s) summed over all processes whose /proc cwd is the instance root; concurrent probes or host load are not excluded.'
    }));
})().catch(e => { console.error(e); process.exitCode = 1; });
