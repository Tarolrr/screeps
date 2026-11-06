'use strict';
// cron-probe: verifies the backend-cron disabler in step-mod.js on an isolated
// instance, against a control instance that keeps stock cron. Research evidence
// only; this is not admission and does not prove quiescence of other writers.
//
// Phase A (ports 32320/32321): factory instance WITH step-mod.js + preload.
//   Default env has no SCREEPS_E2E_KEEP_CRON, so the mod must set
//   config.cronjobs = {} inside the backend process at configManager.load,
//   BEFORE backend/lib/index.js:20 starts setInterval(cronjobs.run, 1000).
//   The natural seed state is already a prepared trigger: every seed room lacks
//   nextForceUpdateTime, so roomsForceUpdate (cronjobs.js:178-192) would
//   activate rooms on the very first 1s cron tick if cron ran at all.
// Phase B (ports 32322/32323): control instance WITHOUT the mod/preload
//   (the factory cannot forward SCREEPS_E2E_KEEP_CRON=1 into the child env, so
//   the equivalent enabled-cron control is an instance with no disabler).
//   Stock cron must observably run there.
// Usage: ~/.local/node22/bin/node e2e/server/cron-probe.js
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const { setTimeout: sleep } = require('timers/promises');
const { createIsolatedServer } = require('./instance');
const { ScreepsCLI } = require('../cli-client');

const HOLD_MS = 8000;            // spans >= 7 backend 1s cron ticks
const CONTROL_OBSERVE_MS = 20000; // >= 1 period of the fastest meaningful jobs

const MOD = path.join(__dirname, 'step-mod.js');
const PRELOAD = path.join(__dirname, 'step-preload.js');
const TOLERANT = path.join(__dirname, 'cron-tolerant-mod.js');

const sha256File = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const save = (root, name, value) => fs.writeFileSync(path.join(root, name),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });

function procCmdline(pid) {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); }
    catch { return null; }
}
function procCwd(pid) {
    try { return fs.realpathSync(`/proc/${pid}/cwd`); } catch { return null; }
}
function cronLogLines(root) {
    try {
        return fs.readFileSync(path.join(root, 'logs', 'backend.log'), 'utf8')
            .split('\n').filter(l => l.includes('Running cronjob'));
    } catch { return []; }
}
function cronFailLines(root) {
    try {
        return fs.readFileSync(path.join(root, 'logs', 'backend.log'), 'utf8')
            .split('\n').filter(l => l.includes('CRONJOB-FAIL'));
    } catch { return []; }
}
// CLI sandbox print() pipes output through util.inspect (maxStringLength ~10k),
// so bulk find({}) responses get truncated before our end marker -> eval timeout.
// Keep payloads small: compact per-room field lines and a sandbox-side hash dump.
async function snapshot(cli) {
    const roomsCsv = await cli.eval(
        "storage.db.rooms.find({}).then(rs=>rs.map(r=>[r._id,r.status," +
        "r.nextForceUpdateTime==null?-1:r.nextForceUpdateTime," +
        "r.invaderGoal==null?-1:r.invaderGoal," +
        "r.powerBankTime==null?-1:r.powerBankTime," +
        "r.nextNpcMarketOrder==null?-1:r.nextNpcMarketOrder]" +
        ".join('|')).sort().join(';'))", 30000);
    const objects = await cli.eval(
        "storage.db['rooms.objects'].find({}).then(os=>{" +
        "const s=os.map(o=>JSON.stringify(o)).sort().join(';');" +
        "let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0}" +
        "const byType={};let nonSeed=0;os.forEach(o=>{byType[o.type]=(byType[o.type]||0)+1;" +
        "if(!['source','mineral','controller'].includes(o.type)||o.user||o.reservation)nonSeed++});" +
        "return {h:h.toString(16),n:os.length,byType,nonSeed}})", 60000);
    const activeRooms = await cli.eval("storage.env.smembers('activeRooms').then(x=>x||[])", 10000);
    return {
        roomsCsv,
        roomCronFields: roomsCsv.split(';').filter(Boolean).map(line => {
            const f = line.split('|'), num = x => (+x < 0 ? null : +x);
            return { _id: f[0], status: f[1], nextForceUpdateTime: num(f[2]),
                invaderGoal: num(f[3]), powerBankTime: num(f[4]), nextNpcMarketOrder: num(f[5]) };
        }),
        objects,
        objectTypes: Object.keys(objects.byType).sort(),
        activeRooms: (activeRooms || []).slice().sort()
    };
}
function diffJson(a, b) {
    const diffs = [];
    if (JSON.stringify(a.roomCronFields) !== JSON.stringify(b.roomCronFields)) {
        const before = Object.fromEntries(a.roomCronFields.map(r => [r._id, r]));
        for (const r of b.roomCronFields) {
            if (JSON.stringify(before[r._id]) !== JSON.stringify(r)) {
                diffs.push({ kind: 'roomCronField', room: r._id, before: before[r._id] || null, after: r });
            }
        }
    }
    if (a.objects.h !== b.objects.h) {
        diffs.push({ kind: 'roomsObjectsHash', before: { h: a.objects.h, n: a.objects.n }, after: { h: b.objects.h, n: b.objects.n } });
    }
    if (JSON.stringify(a.activeRooms) !== JSON.stringify(b.activeRooms)) {
        diffs.push({ kind: 'activeRooms', before: a.activeRooms, after: b.activeRooms });
    }
    return diffs;
}

async function phaseA() {
    const runId = `cron-neg-${Date.now()}-${process.pid}`;
    const server = await createIsolatedServer({
        runId, httpPort: 32320, cliPort: 32321,
        mods: [MOD], preload: PRELOAD
    });
    const result = { runId, root: server.root, checks: {}, verdict: 'UNKNOWN' };
    let cli, failure;
    try {
        await server.start(); await server.assertIdentity();
        // (e) record mods.json + hashes of every listed mod file
        const modsJson = JSON.parse(fs.readFileSync(path.join(server.root, 'mods.json'), 'utf8'));
        result.mods = {
            file: modsJson, sha256: sha256File(path.join(server.root, 'mods.json')),
            modHashes: modsJson.mods.map(m => ({ path: m, exists: fs.existsSync(m), sha256: fs.existsSync(m) ? sha256File(m) : null }))
        };
        save(server.root, 'probe-cron-mods.json', result.mods);
        // marker readback: the disabler must have run in the backend process
        const marker = JSON.parse(fs.readFileSync(path.join(server.root, 'step-backend-cron-disabled.json'), 'utf8'));
        const cmdline = procCmdline(marker.pid);
        result.marker = marker;
        result.markerBackendPid = { pid: marker.pid, cmdline, cwd: procCwd(marker.pid) };
        result.checks.markerPresent = marker.cronDisabled === true && marker.runId === runId;
        result.checks.markerPidIsBackend = !!cmdline && cmdline.includes('@screeps/backend') && procCwd(marker.pid) === server.root;
        save(server.root, 'probe-cron-marker.json', { marker, cmdline, cwd: procCwd(marker.pid) });
        cli = new ScreepsCLI(server.cliOptions.host, server.cliOptions.port);
        await cli.connect();
        // Prepared trigger (a): seed rooms already lack nextForceUpdateTime; make
        // it explicit and recorded on one room so the diff window is ours.
        const room = await cli.eval("storage.db.rooms.findOne({status:{$ne:'out of borders'}}).then(r=>r && r._id)", 10000);
        if (!room) throw Error('no eligible room in seed');
        const s0 = await snapshot(cli);
        await cli.eval(`storage.db.rooms.update({_id:${JSON.stringify(room)}},{$set:{nextForceUpdateTime:0}})`, 10000);
        const prepared = await snapshot(cli);
        // (a)+(d) hold across >= 7 cron ticks; whole startup+hold window must show zero cron writes
        await sleep(HOLD_MS);
        const s1 = await snapshot(cli);
        const diffs = diffJson(prepared, s1);
        const earlyDiffs = diffJson(s0, prepared);
        const cronLines = cronLogLines(server.root);
        result.holdMs = HOLD_MS;
        // The only allowed early diff is our own prepared write on that room.
        result.checks.onlyPreparedDiffBeforeHold = earlyDiffs.length === 1 &&
            earlyDiffs[0].kind === 'roomCronField' && earlyDiffs[0].room === room &&
            earlyDiffs[0].after && earlyDiffs[0].after.nextForceUpdateTime === 0;
        result.checks.noDbDiffsDuringHold = diffs.length === 0;
        result.checks.noCronLogLinesEver = cronLines.length === 0;
        result.checks.activeRoomsUntouched = JSON.stringify(s1.activeRooms) === JSON.stringify(prepared.activeRooms);
        result.checks.invaderGoalUnchanged = s1.roomCronFields.every((r, i) => r.invaderGoal === prepared.roomCronFields[i].invaderGoal);
        result.diffs = diffs;
        result.earlyDiffs = earlyDiffs;
        result.cronLogLines = cronLines;
        result.preparedRoom = room;
        save(server.root, 'probe-cron-snapshot-neg.json', { earliest: s0, prepared, after: s1, diffs, earlyDiffs });
        // (c) manual runCronjob in disabled mode must not find/execute the job
        let runCronResponse;
        try { runCronResponse = { ok: true, value: await cli.eval("system.runCronjob('roomsForceUpdate')", 10000) }; }
        catch (e) { runCronResponse = { ok: false, error: String(e.message || e) }; }
        result.runCronjob = runCronResponse;
        result.checks.runCronjobRefused = runCronResponse.ok === false && /not found/i.test(runCronResponse.error || '');
        const s2 = await snapshot(cli); // runCronjob attempt must not have written either
        result.checks.noDbDiffsAfterRunCronjob = diffJson(s1, s2).length === 0;
        save(server.root, 'probe-cron-evidence-neg.json', result);
        fs.copyFileSync(path.join(server.root, 'logs', 'backend.log'), path.join(server.root, 'probe-cron-backend-neg.log'));
        result.verdict = Object.values(result.checks).every(Boolean) ? 'PASS' : 'FAIL';
    } catch (e) { failure = e; result.verdict = 'UNKNOWN'; result.error = String(e && e.stack || e); save(server.root, 'probe-cron-evidence-neg.json', result); }
    finally {
        if (cli) cli.close();
        try { await server.stop(); if (!failure && result.verdict === 'PASS') await server.destroy(); else console.error(`quarantined artifacts: ${server.root}`); }
        catch (e) { failure = Error(`${failure ? failure.message + '; ' : ''}cleanup failed: ${e.message}`); result.verdict = 'UNKNOWN'; }
    }
    if (failure) result.error = String(failure.stack || failure);
    return result;
}

async function phaseB() {
    const runId = `cron-ctl-${Date.now()}-${process.pid}`;
    // Control: no step-mod, no preload -> stock config.cronjobs stays populated.
    // Control: tolerant mod keeps all stock cronjobs firing but logs each
    // rejection as 'CRONJOB-FAIL <name>' instead of crash-looping the backend
    // (fresh seed lacks env 'activeRooms': stock roomsForceUpdate/genInvaders
    // send {_id:{$nin:undefined}} -> {_id:{}} -> lokijs "fun is not a function"
    // -> unhandled rejection, observed in runs cron-ctl-1793631764324/-2427678).
    // seedEnv additionally pre-seeds the key so those jobs can also complete
    // and produce observable writes; remaining failures are named evidence.
    const server = await createIsolatedServer({ runId, httpPort: 32322, cliPort: 32323, mods: [TOLERANT], seedEnv: {activeRooms: []} });
    const result = { runId, root: server.root, checks: {}, verdict: 'UNKNOWN' };
    let cli, failure;
    try {
        await server.start(); await server.assertIdentity();
        cli = new ScreepsCLI(server.cliOptions.host, server.cliOptions.port);
        await cli.connect();
        const s0 = await snapshot(cli);
        const room = await cli.eval("storage.db.rooms.findOne({status:{$ne:'out of borders'}}).then(r=>r && r._id)", 10000);
        if (room) await cli.eval(`storage.db.rooms.update({_id:${JSON.stringify(room)}},{$set:{nextForceUpdateTime:0}})`, 10000).catch(e => { result.preparedWriteError = String(e); });
        const deadline = Date.now() + CONTROL_OBSERVE_MS;
        let cronLines = [];
        while (Date.now() < deadline && cronLines.length === 0) { await sleep(1000); cronLines = cronLogLines(server.root); }
        await sleep(3000); // let in-flight jobs land
        cronLines = cronLogLines(server.root);
        const s = await snapshot(cli);
        const seedOnly = s.objects.nonSeed === 0;
        result.cronLogLines = cronLines;
        result.cronJobNames = [...new Set(cronLines.map(l => (l.match(/Running cronjob '([^']+)'/) || [])[1]).filter(Boolean))];
        result.cronJobFails = cronFailLines(server.root);
        result.before = { roomCronFieldsWithValues: s0.roomCronFields.filter(r => r.nextForceUpdateTime !== null || r.invaderGoal !== null || r.powerBankTime !== null || r.nextNpcMarketOrder !== null).length };
        result.after = { activeRooms: s.activeRooms, roomCronFieldsWithValues: s.roomCronFields.filter(r => r.nextForceUpdateTime !== null || r.invaderGoal !== null || r.powerBankTime !== null || r.nextNpcMarketOrder !== null).length, objectTypes: s.objectTypes, objectCount: s.objects.n, seedOnly };
        result.cronWriteDiffs = diffJson(s0, s);
        let runCronResponse;
        try { runCronResponse = { ok: true, value: await cli.eval("system.runCronjob('roomsForceUpdate')", 15000) }; }
        catch (e) { runCronResponse = { ok: false, error: String(e.message || e) }; }
        result.runCronjob = runCronResponse;
        result.checks.cronLogLinesPresent = cronLines.length > 0;
        result.checks.observableEffect = result.cronWriteDiffs.length > 0 || s.activeRooms.length > 0 || !seedOnly;
        result.checks.runCronjobExecuted = runCronResponse.ok === true;
        save(server.root, 'probe-cron-snapshot-ctl.json', s);
        save(server.root, 'probe-cron-evidence-ctl.json', result);
        fs.copyFileSync(path.join(server.root, 'logs', 'backend.log'), path.join(server.root, 'probe-cron-backend-ctl.log'));
        result.verdict = (result.checks.cronLogLinesPresent && result.checks.observableEffect) ? 'PASS' : 'FAIL';
    } catch (e) { failure = e; result.verdict = 'UNKNOWN'; result.error = String(e && e.stack || e); save(server.root, 'probe-cron-evidence-ctl.json', result); }
    finally {
        if (cli) cli.close();
        try { await server.stop(); if (!failure && result.verdict === 'PASS') await server.destroy(); else console.error(`quarantined artifacts: ${server.root}`); }
        catch (e) { failure = Error(`${failure ? failure.message + '; ' : ''}cleanup failed: ${e.message}`); result.verdict = 'UNKNOWN'; }
    }
    if (failure) result.error = String(failure.stack || failure);
    return result;
}

(async () => {
    const neg = await phaseA();
    console.log(JSON.stringify({ phase: 'disabled', verdict: neg.verdict, runId: neg.runId, checks: neg.checks, marker: neg.marker, runCronjob: neg.runCronjob, error: neg.error }));
    const ctl = await phaseB();
    console.log(JSON.stringify({ phase: 'control', verdict: ctl.verdict, runId: ctl.runId, checks: ctl.checks, cronJobNames: ctl.cronJobNames, runCronjob: ctl.runCronjob, after: ctl.after, error: ctl.error }));
    const verdict = neg.verdict === 'PASS' && ctl.verdict === 'PASS' ? 'PASS' :
        [neg.verdict, ctl.verdict].includes('FAIL') ? 'FAIL' : 'UNKNOWN';
    console.log(JSON.stringify({ status: 'experimental-only', verdict, disabledRunId: neg.runId, controlRunId: ctl.runId }));
    if (verdict !== 'PASS') process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
