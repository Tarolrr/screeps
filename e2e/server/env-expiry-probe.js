'use strict';
// env-expiry-probe: mandatory env keys must carry no expiry across a long hold.
// The storage layer deletes expired env keys every 10s
// (storage/lib/db.js:295-315). Expiry metadata lives in a separate Loki record
// (env.get(2).data[name] = absolute ms deadline; db.js:582-600); dbEnvTtl
// returns -1 when there is no record AND when the deadline already passed
// (db.js:614-628), so ttl==-1 alone is ambiguous. Method used here:
//   1. storage.env.ttl(key) readback for every mandatory key (expect -1,
//      documented as ambiguous, not proof);
//   2. a scratch setex/expire key that MUST actually expire within the hold —
//      proves the purge machinery and the observation window work (control);
//   3. all mandatory keys still readable after a >= 25s hold spanning at least
//      two 10s purge cycles, on a gated instance where nothing rewrites them
//      (gameTime frozen — no main loop runs during the hold);
//   4. the on-disk db.json env records ($loki 1 values / $loki 2 expiration)
//      read back after the hold — mandatory keys must appear only in the
//      values doc, never in the expiration doc. db.json lags up to one
//      autosave interval (10s); the hold covers that.
// Queue note: users/rooms queues are in-memory in the storage process
// (storage/lib/queue.js via RPC queueFetch/queueAdd/...), they are NOT env
// keys; the pubsub channels tickStarted/roomsDone/queueDone: are transient.
// The env keys relevant to the gate fixture are therefore: gameTime,
// activeRooms, memory:<userId>, memorySegments:<userId>, accessibleRooms,
// roomStatusData, mainLoopPaused, tickRate. All found keys are enumerated.
// Ports 32324/32325. Re-runnable.
// Usage: ~/.local/node22/bin/node e2e/server/env-expiry-probe.js
const path = require('path'), fs = require('fs');
const { setTimeout: sleep } = require('timers/promises');
const { createIsolatedServer } = require('./instance');
const { Harness } = require('../harness');

const HOLD_MS = 25000; // >= 2 x 10s purge cycles
const MOD = path.join(__dirname, 'step-mod.js');
const PRELOAD = path.join(__dirname, 'step-preload.js');
const save = (root, name, value) => fs.writeFileSync(path.join(root, name),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });

(async () => {
    const runId = `env-expiry-${Date.now()}-${process.pid}`;
    const server = await createIsolatedServer({
        runId, httpPort: 32324, cliPort: 32325,
        mods: [MOD], preload: PRELOAD
    });
    const result = { runId, checks: {}, keys: {}, verdict: 'UNKNOWN' };
    let h, failure;
    try {
        await server.start(); await server.assertIdentity();
        h = new Harness({ cliHost: server.cliOptions.host, cliPort: server.cliOptions.port });
        await h.connect();
        await h.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])", 10000);
        const room = await h.eval("storage.db['rooms.objects'].findOne({type:'controller'}).then(x=>x && x.room)", 10000);
        if (!room) throw Error('missing controller room');
        // Real user -> mandatory memory:<userId> env key + activeRooms seed.
        const user = await h.createUser({
            username: `expiry${process.pid}`, roomName: room, spawn: true,
            modules: { main: "module.exports.loop=function(){};" }
        });
        const mandatory = [
            'gameTime', 'activeRooms', `memory:${user}`,
            `memorySegments:${user}`, 'accessibleRooms', 'roomStatusData',
            'mainLoopPaused', 'tickRate'
        ];
        // Enumerate every readable key we can reach via the sandbox API:
        // presence via get/mget/smembers (env has no keys() method).
        const probe = async key => {
            const out = { key };
            try { out.value = await h.eval(`storage.env.get(${JSON.stringify(key)})`, 10000); } catch (e) { out.getError = String(e.message || e); }
            try { out.set = await h.eval(`storage.env.smembers(${JSON.stringify(key)})`, 10000); } catch (e) { /* not a set */ }
            try { out.ttl = await h.eval(`storage.env.ttl(${JSON.stringify(key)})`, 10000); } catch (e) { out.ttlError = String(e.message || e); }
            return out;
        };
        const t0 = Date.now();
        for (const k of mandatory) result.keys[k] = { t0: await probe(k) };
        // Control: an expiring scratch key MUST die inside the hold.
        await h.eval("storage.env.setex('e2e-expiry-scratch', 5, 'x')", 10000);
        result.scratch = { setex: 'e2e-expiry-scratch ttl=5s', t0: await probe('e2e-expiry-scratch') };
        // Also exercise expire() on a second scratch key.
        await h.eval("storage.env.set('e2e-expiry-scratch2','y').then(()=>storage.env.expire('e2e-expiry-scratch2',4))", 10000);
        // Hold >= 25s, spanning >= 2 purge cycles, sampling at ~5s.
        const samples = [];
        while (Date.now() - t0 < HOLD_MS) {
            await sleep(5000);
            const s = { at: Date.now() - t0, keys: {} };
            for (const k of mandatory) s.keys[k] = await probe(k);
            s.scratch = await h.eval("storage.env.get('e2e-expiry-scratch')", 10000);
            s.scratch2 = await h.eval("storage.env.get('e2e-expiry-scratch2')", 10000);
            samples.push(s);
        }
        const last = samples[samples.length - 1];
        result.samples = samples;
        result.checks.scratchExpired = last.scratch === null || last.scratch === undefined;
        result.checks.scratch2Expired = last.scratch2 === null || last.scratch2 === undefined;
        result.checks.gameTimePersisted = last.keys['gameTime'].value !== null && last.keys['gameTime'].value !== undefined;
        result.checks.gameTimeFrozen = String(last.keys['gameTime'].value) === String(result.keys['gameTime'].t0.value);
        result.checks.memoryKeyPersisted = last.keys[`memory:${user}`].value !== null && last.keys[`memory:${user}`].value !== undefined;
        result.checks.activeRoomsPersisted = Array.isArray(last.keys['activeRooms'].set) ? last.keys['activeRooms'].set.includes(room)
            : (last.keys['activeRooms'].value !== null && last.keys['activeRooms'].value !== undefined);
        result.checks.allTtlMinusOne = mandatory.every(k => last.keys[k].ttl === -1 || last.keys[k].ttl === undefined);
        // db.json expiry metadata readback: the expiration doc ($loki 2) must
        // not contain any mandatory key. Autosave lag <= 10s < hold length.
        // Loki rewrites the whole file; retry once on a torn read.
        let dbFile = null, lastErr = null;
        for (let i = 0; i < 3 && !dbFile; i++) {
            try { dbFile = JSON.parse(fs.readFileSync(path.join(server.root, 'db.json'), 'utf8')); }
            catch (e) { lastErr = e; await sleep(1200); }
        }
        try {
            if (!dbFile) throw lastErr || Error('db.json unreadable');
            const envColl = dbFile.collections.find(c => c.name === 'env');
            const valuesDoc = envColl.data.find(x => x.$loki === 1);
            const expirationDoc = envColl.data.find(x => x.$loki === 2);
            result.diskEnv = {
                valueKeys: valuesDoc ? Object.keys(valuesDoc.data).sort() : null,
                expirationKeys: expirationDoc ? Object.keys(expirationDoc.data).sort() : [],
                expirationDeadlineEntries: expirationDoc ? expirationDoc.data : {}
            };
            save(server.root, 'probe-expiry-envdoc.json', { valuesDoc, expirationDoc });
            result.checks.noExpiryMetadataOnDisk = !expirationDoc || mandatory.every(k => !(k in expirationDoc.data));
        } catch (e) { result.diskEnvError = String(e); result.checks.noExpiryMetadataOnDisk = false; }
        result.checks.user = user; result.room = room;
        save(server.root, 'probe-expiry-evidence.json', result);
        result.verdict = Object.entries(result.checks).filter(([k]) => k !== 'user' && k !== 'room').every(([, v]) => v) ? 'PASS' : 'FAIL';
    } catch (e) { failure = e; result.verdict = 'UNKNOWN'; result.error = String(e && e.stack || e); try { save(server.root, 'probe-expiry-evidence.json', result); } catch {} }
    finally {
        if (h) h.close();
        try { await server.stop(); if (!failure && result.verdict === 'PASS') await server.destroy(); else console.error(`quarantined artifacts: ${server.root}`); }
        catch (e) { failure = Error(`${failure ? failure.message + '; ' : ''}cleanup failed: ${e.message}`); result.verdict = 'UNKNOWN'; }
    }
    console.log(JSON.stringify({ status: 'experimental-only', verdict: result.verdict, runId, checks: result.checks, diskEnv: result.diskEnv, error: result.error || (failure && String(failure)) }));
    if (result.verdict !== 'PASS') process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
