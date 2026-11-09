'use strict';
// Paged CLI reads for the STRAT suite.
//
// The admin CLI prints eval results through util.inspect, which truncates
// strings longer than 10000 characters (docs/testing/orders.md): a full dist2
// Memory (orders + creep task memory) or a room with ~10 creeps does not fit,
// and the truncated payload loses its end marker (deterministic eval timeout).
//
// pagedEval() evaluates the expression ONCE server-side, serialises the result
// into a string held in the CLI connection's sandbox global, and returns it in
// chunks whose encoded size stays under the print ceiling. The reassembled
// string is verified against the server-side length and FNV-1a hash, so a lost
// or reordered chunk is detected (thrown), never silently accepted.
//
// captureSnapshotPaged() is captureSnapshot() from e2e/server/snapshot-client.js
// (unchanged semantics: ack binding, double-read stability, post-barrier journal
// scan, TTL and coverage checks) with the single combined field-set read done
// through pagedEval — one server-side Promise.all, i.e. at least as coherent as
// the original combined read, without the 10 KB truncation.
const { setTimeout: sleep } = require('timers/promises');
const { coverageReport, postBarrierWrites } = require('../server/snapshot-client');

// Encoded payload budget per chunk (print ceiling is 10000 chars of the
// util.inspect'ed marker+encodeURIComponent(JSON) string).
const CHUNK_BUDGET = 7000;

function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}
const FNV_SRC = 'function(s){var h=0x811c9dc5;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return h>>>0;}';

let pageSeq = 0;

async function pagedEval(cli, expr, timeoutMs = 15000) {
    const slot = `p${process.pid}_${++pageSeq}`;
    const head = await cli.eval(`Promise.resolve(${expr}).then(function(r){
        var s = JSON.stringify(r === undefined ? null : r);
        globalThis.__stratPages = globalThis.__stratPages || {};
        globalThis.__stratPages[${JSON.stringify(slot)}] = s;
        return {len: s.length, h: (${FNV_SRC})(s)};
    })`, timeoutMs);
    if (!head || !Number.isInteger(head.len)) throw new Error('paged read: bad head');
    let out = '';
    let guard = 0;
    try {
        while (out.length < head.len) {
            if (++guard > 5000) throw new Error('paged read: too many chunks');
            const c = await cli.eval(`(function(){
                var s = globalThis.__stratPages[${JSON.stringify(slot)}], o = ${out.length}, n = 3000;
                for (;;) {
                    var sub = s.substr(o, n);
                    if (n <= 16 || encodeURIComponent(JSON.stringify(sub)).length <= ${CHUNK_BUDGET}) return {o: o, d: sub};
                    n = Math.floor(n / 2);
                }
            })()`, timeoutMs);
            if (!c || c.o !== out.length || typeof c.d !== 'string' || !c.d.length) throw new Error('paged read: chunk mismatch');
            out += c.d;
        }
    } finally {
        try { await cli.eval(`(delete globalThis.__stratPages[${JSON.stringify(slot)}], true)`, timeoutMs); } catch {}
    }
    if (out.length !== head.len || fnv1a(out) !== head.h) throw new Error(`paged read: integrity mismatch len ${out.length}/${head.len}`);
    return JSON.parse(out);
}

// Same field set as snapshot-client.js fieldSetEval(), one server-side read.
function fieldSetExpr(rooms, users) {
    const memGets = users.map(u => `storage.env.get(${JSON.stringify('memory:' + u)})`).join(',');
    const memTtls = users.map(u => `storage.env.ttl(${JSON.stringify('memory:' + u)})`).join(',');
    const roomFinds = rooms.map(r => `storage.db['rooms.objects'].find({room:${JSON.stringify(r)}})`).join(',');
    return `Promise.all([
        storage.env.get('gameTime'),
        storage.env.smembers('activeRooms'),
        storage.env.ttl('gameTime'),
        storage.env.ttl('activeRooms'),
        Promise.all([${memGets || 'Promise.resolve(null)'}]),
        Promise.all([${memTtls || 'Promise.resolve(null)'}]),
        Promise.all([${roomFinds || 'Promise.resolve(null)'}])
    ]).then(function(r){ return {gameTime: r[0], activeRooms: r[1], ttlGameTime: r[2], ttlActiveRooms: r[3],
        memoryRaw: r[4], ttlMemory: r[5], objects: r[6]}; })`;
}

async function readFieldSetPaged(cli, rooms, users, timeoutMs = 15000) {
    const r = await pagedEval(cli, fieldSetExpr(rooms, users), timeoutMs);
    const objects = {};
    rooms.forEach((room, i) => { objects[room] = r.objects[i] || []; });
    const memory = {};
    users.forEach((u, i) => { memory[u] = r.memoryRaw[i] ? JSON.parse(r.memoryRaw[i]) : null; });
    return {
        gameTime: Number(r.gameTime), activeRooms: (r.activeRooms || []).slice().sort(),
        memory, objects,
        queues: 'asserted-by-protocol-not-read',
        ttl: { gameTime: r.ttlGameTime, activeRooms: r.ttlActiveRooms, memory: r.ttlMemory },
        memoryBytes: users.map((u, i) => (r.memoryRaw[i] || '').length),
    };
}

// Mirror of snapshot-client.js captureSnapshot() using the paged read.
async function captureSnapshotPaged(cli, root, ack, fixture, opts = {}) {
    const { settleMs = 200, timeoutMs = 15000 } = opts;
    if (!ack || ack.status !== 'cycle-finished-unverified') throw Error('snapshot requires a finished-cycle ack');
    if (!Number.isFinite(ack.gameTime)) throw Error('UNKNOWN: ack lacks calibrated gameTime');
    if (!Number.isFinite(ack.drainStartTs) || !Number.isFinite(ack.barrierTs)) throw Error('UNKNOWN: ack lacks barrier evidence');
    const problems = [];
    if ((ack.postBarrierWrites || []).length) problems.push(`ack recorded ${ack.postBarrierWrites.length} post-barrier writes`);
    const coverage = coverageReport(root);
    if (!coverage.complete) problems.push(`instrumentation coverage degraded: ${coverage.reasons.join('; ')}`);
    let first = null, second = null;
    try { first = await readFieldSetPaged(cli, fixture.rooms, fixture.users, timeoutMs); }
    catch (error) { problems.push(`first field read failed: ${error.message}`); }
    await sleep(settleMs);
    try { second = await readFieldSetPaged(cli, fixture.rooms, fixture.users, timeoutMs); }
    catch (error) { problems.push(`second field read failed: ${error.message}`); }
    const stable = !!first && !!second && JSON.stringify(first) === JSON.stringify(second);
    if (first && second && !stable) problems.push('double-read mismatch: field set changed between reads');
    const bound = !!first && !!second && first.gameTime === ack.gameTime && second.gameTime === ack.gameTime;
    if (first && second && !bound) problems.push(`gameTime ${first.gameTime}/${second.gameTime} not bound to ack ${ack.gameTime}`);
    const writes = postBarrierWrites(root, ack.drainStartTs, ack.barrierTs);
    for (const w of writes) problems.push(`post-barrier field write: ${w.proc || '?'} ${w.op || '?'} ${w.key || w.collection || ''}`);
    let ttlOk = false;
    if (first) {
        ttlOk = first.ttl.gameTime === -1 && [-1, -2].includes(first.ttl.activeRooms) &&
            first.ttl.memory.every(t => t === -1);
        if (!ttlOk) problems.push(`field-set env keys carry expiry: ${JSON.stringify(first.ttl)}`);
    }
    const snapshot = second ? { ...second, gameTime: second.gameTime } : null;
    return {
        ok: problems.length === 0, snapshot, problems,
        evidence: { bound, stable, postBarrierWrites: writes, ttlOk, coverage, ackGameTime: ack.gameTime },
    };
}

module.exports = { pagedEval, readFieldSetPaged, captureSnapshotPaged, fnv1a, CHUNK_BUDGET };
