'use strict';
// hold-probe: long inter-step holds, beyond the previously tested 6.5s.
// engine/dist/main.js:22-26 arms the queue watchdog setInterval INSIDE loop()
// and clears it in the loop's .finally() (line ~90), so no watchdog can fire
// while the gate parks the scheduler between loops — verified empirically for
// 30s and 60s holds by counting 'Main loop reset!' lines in engine_main.log
// and by gameTime staying frozen. Then one calibration run reproduces the
// known during-step fault: activate-fault.json delayMs 6500 >
// mainLoopResetInterval (5000, driver/lib/index.js:22) must fire the watchdog
// inside the cycle -> queue.resetAll -> resetDuringCycle -> ack status
// 'unknown' -> step() rejects -> client poisons. That UNKNOWN is the expected
// calibration outcome, not a defect.
// The instance is left quarantined afterwards (poisoned by design).
// Ports 32328/32329. Re-runnable.
// Usage: ~/.local/node22/bin/node e2e/server/hold-probe.js
const path = require('path'), fs = require('fs');
const { setTimeout: sleep } = require('timers/promises');
const { createIsolatedServer } = require('./instance');
const { StepClient } = require('./step-client');
const { ScreepsCLI } = require('../cli-client');

const MOD = path.join(__dirname, 'step-mod.js');
const PRELOAD = path.join(__dirname, 'step-preload.js');
const save = (root, name, value) => fs.writeFileSync(path.join(root, name),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });

(async () => {
    const runId = `hold-${Date.now()}-${process.pid}`;
    const server = await createIsolatedServer({
        runId, httpPort: 32328, cliPort: 32329,
        mods: [MOD], preload: PRELOAD
    });
    const result = { runId, checks: {}, holds: [], verdict: 'UNKNOWN' };
    let cli, failure, gate;
    const resetCount = () => {
        try {
            return (fs.readFileSync(path.join(server.root, 'logs', 'engine_main.log'), 'utf8').match(/Main loop reset!/g) || []).length;
        } catch { return null; }
    };
    const time = () => cli.eval("storage.env.get('gameTime')", 10000).then(Number);
    const room = async () => cli.eval("storage.db['rooms.objects'].findOne({type:'controller'}).then(x=>x && x.room)", 10000);
    const hold = async (ms, expectTime) => {
        const rec = { holdMs: ms, expectTime, resets0: resetCount(), samples: [] };
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            rec.samples.push({ at: Date.now(), time: await time(), resets: resetCount() });
            await sleep(Math.min(5000, deadline - Date.now()));
        }
        rec.finalTime = await time();
        rec.resets1 = resetCount();
        rec.timeFrozen = rec.finalTime === expectTime && rec.samples.every(s => s.time === expectTime);
        rec.noResets = rec.resets0 !== null && rec.resets1 === rec.resets0;
        result.holds.push(rec);
        return rec;
    };
    try {
        await server.start(); await server.assertIdentity();
        gate = await StepClient.connect(server.root, { timeoutMs: 15000 });
        cli = new ScreepsCLI(server.cliOptions.host, server.cliOptions.port);
        await cli.connect();
        await cli.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])", 10000);
        const roomName = await room();
        if (!roomName) throw Error('missing controller room');
        const t0 = await time();
        result.t0 = t0;
        // 30s hold BEFORE the first command ever executes.
        const h30 = await hold(30000, t0);
        await cli.eval(`storage.env.sadd('activeRooms',${JSON.stringify(roomName)})`, 10000);
        const ack1 = await gate.step({ timeoutMs: 20000 });
        result.steps = [{ sequence: ack1.sequence, time: await time(), stages: ack1.stages, status: ack1.status }];
        // 60s hold between steps.
        const h60 = await hold(60000, result.steps[0].time);
        await cli.eval(`storage.env.sadd('activeRooms',${JSON.stringify(roomName)})`, 10000);
        const ack2 = await gate.step({ timeoutMs: 20000 });
        result.steps.push({ sequence: ack2.sequence, time: await time(), stages: ack2.stages, status: ack2.status });
        result.checks.hold30 = h30.timeFrozen && h30.noResets;
        result.checks.hold60 = h60.timeFrozen && h60.noResets;
        result.checks.sequence = ack1.sequence === 1 && ack2.sequence === 2;
        result.checks.gameTime = result.steps[0].time === t0 + 1 && result.steps[1].time === t0 + 2;
        // Calibration: during-step 6.5s detached-writer delay -> watchdog -> UNKNOWN.
        // updateAccessibleRoomsList runs every main loop (activateRoom only fires
        // for not-yet-active rooms, so activate-fault would not engage here).
        fs.writeFileSync(path.join(server.root, 'step-control', 'access-rooms-fault.json'), JSON.stringify({ delayMs: 6500 }), { mode: 0o600, flag: 'wx' });
        await cli.eval(`storage.env.sadd('activeRooms',${JSON.stringify(roomName)})`, 10000);
        const resetsBefore = resetCount();
        let faultError = null;
        try { await gate.step({ timeoutMs: 20000 }); }
        catch (e) { faultError = String(e.message || e); }
        result.fault = { error: faultError, resetsBefore, resetsAfter: resetCount() };
        const ack3Path = path.join(server.root, 'step-control', 'ack-3.json');
        result.fault.ack3 = fs.existsSync(ack3Path) ? JSON.parse(fs.readFileSync(ack3Path, 'utf8')) : null;
        result.checks.faultRejected = faultError !== null;
        result.checks.faultPoisoned = gate.failed === true && fs.existsSync(path.join(server.root, 'step-control', 'poisoned.json'));
        result.checks.faultAckUnknown = !result.fault.ack3 || result.fault.ack3.status === 'unknown' || result.fault.ack3.resetDuringCycle === true;
        save(server.root, 'probe-hold-evidence.json', result);
        const mainLogTail = fs.readFileSync(path.join(server.root, 'logs', 'engine_main.log'), 'utf8').split('\n').slice(-60);
        save(server.root, 'probe-hold-engine-main-tail.txt', mainLogTail.join('\n'));
        result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS(with expected calibration UNKNOWN)' : 'FAIL';
    } catch (e) { failure = e; result.verdict = 'UNKNOWN'; result.error = String(e && e.stack || e); try { save(server.root, 'probe-hold-evidence.json', result); } catch {} }
    finally {
        if (cli) cli.close();
        try { await server.stop(); console.error(`quarantined artifacts (fault ends poisoned): ${server.root}`); }
        catch (e) { failure = Error(`${failure ? failure.message + '; ' : ''}cleanup failed: ${e.message}`); result.verdict = 'UNKNOWN'; }
    }
    console.log(JSON.stringify({ status: 'experimental-only', verdict: result.verdict, runId, checks: result.checks, holds: result.holds.map(h => ({ holdMs: h.holdMs, finalTime: h.finalTime, timeFrozen: h.timeFrozen, resets: [h.resets0, h.resets1] })), steps: result.steps && result.steps.map(s => ({ sequence: s.sequence, time: s.time, status: s.status })), fault: result.fault, error: result.error || (failure && String(failure)) }));
    if (!String(result.verdict).startsWith('PASS')) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
