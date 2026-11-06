'use strict';

// Controller-side snapshot evidence for the research step gate. A snapshot is
// only meaningful bound to the gameTime the ack reports: the gate's barrier
// evidence (drains, post-barrier journal scan), a double-read stability check,
// per-process writer journals showing zero field-set writes between the drain
// and the snapshot read, field-key expiry checks, and instrumentation coverage
// all have to agree. A stable gameTime alone is NOT proof of quiescence.
const fs = require('fs');
const path = require('path');
const {setTimeout: sleep} = require('timers/promises');

function fieldSetEval(rooms, users) {
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
  ]).then(r => ({gameTime: r[0], activeRooms: r[1], ttlGameTime: r[2], ttlActiveRooms: r[3],
    memoryRaw: r[4], ttlMemory: r[5], objects: r[6]}))`;
}

async function readFieldSet(cli, rooms, users, timeoutMs = 15000) {
  // Split transport: one combined Promise.all response (memory + full
  // object rows) can exceed the ~10 KB CLI pipe and poison the eval with a
  // truncated buffer (UNKNOWN snapshot-1 timeouts on eco-02-d2-area/ctrl).
  // Per-group evals keep each response under the ceiling with the same data.
  const r = await cli.eval(`Promise.all([
    storage.env.get('gameTime'),
    storage.env.smembers('activeRooms'),
    storage.env.ttl('gameTime'),
    storage.env.ttl('activeRooms')
  ]).then(r => ({gameTime: r[0], activeRooms: r[1], ttlGameTime: r[2], ttlActiveRooms: r[3]}))`, timeoutMs);
  const memGets = users.map(u => `storage.env.get(${JSON.stringify('memory:' + u)})`).join(',');
  const memTtls = users.map(u => `storage.env.ttl(${JSON.stringify('memory:' + u)})`).join(',');
  const memR = await cli.eval(`Promise.all([
    Promise.all([${memGets || 'Promise.resolve(null)'}]),
    Promise.all([${memTtls || 'Promise.resolve(null)'}])
  ]).then(r => ({memoryRaw: r[0], ttlMemory: r[1]}))`, timeoutMs);
  const objects = {};
  for (const room of rooms) {
    objects[room] = [].concat(
      await cli.eval(`storage.db['rooms.objects'].find({$and:[{room:${JSON.stringify(room)}},{type:'creep'}]})`, timeoutMs),
      await cli.eval(`storage.db['rooms.objects'].find({$and:[{room:${JSON.stringify(room)}},{type:{$ne:'creep'}}]})`, timeoutMs));
  }
  const memory = {};
  users.forEach((u, i) => { memory[u] = memR.memoryRaw[i] ? JSON.parse(memR.memoryRaw[i]) : null; });
  return {gameTime: Number(r.gameTime), activeRooms: (r.activeRooms || []).slice().sort(),
    memory, objects,
    // Queue occupancy is not readable through this CLI surface; emptiness is
    // asserted by the stage sequence plus drain bookkeeping, not by this read.
    queues: 'asserted-by-protocol-not-read',
    ttl: {gameTime: r.ttlGameTime, activeRooms: r.ttlActiveRooms, memory: memR.ttlMemory}};
}

function coverageReport(root) {
  const files = {};
  for (const file of fs.readdirSync(root)) {
    const match = /^step-coverage-([a-z]+)-\d+\.json$/.exec(file);
    if (!match) continue;
    try { files[match[1]] = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
    catch (error) { files[match[1]] = {parseError: String(error)}; }
  }
  const reasons = [];
  const wrapped = (f, name) => f && f.hooks && f.hooks[name] && f.hooks[name] !== 'absent';
  for (const role of ['main', 'runner', 'processor']) {
    if (!files[role]) reasons.push(`missing ${role} coverage`);
  }
  if (files.main) {
    for (const h of ['activateRoom', 'updateAccessibleRoomsList', 'updateRoomStatusData']) {
      if (!wrapped(files.main, h)) reasons.push(`main.${h} not wrapped`);
    }
  }
  if (files.processor && !wrapped(files.processor, 'activateRoom')) reasons.push('processor.activateRoom not wrapped');
  if (files.runner) {
    if (!wrapped(files.runner, 'usersQueueDrain')) reasons.push('runner users queue drain missing');
    if (!wrapped(files.runner, 'saveUserMemory')) reasons.push('runner.saveUserMemory not wrapped');
  }
  for (const role of ['main', 'runner', 'processor', 'backend']) {
    const f = files[role];
    if (!f) continue;
    if (!f.storage || !f.storage.resolved) reasons.push(`${role} storage journal unresolved`);
    else {
      if (!f.storage.envWrapped || !f.storage.envWrapped.includes('set')) reasons.push(`${role} env journal uncovered`);
      if (!f.storage.dbWrapped || !f.storage.dbWrapped['rooms.objects'] || !f.storage.dbWrapped['rooms.objects'].length) {
        reasons.push(`${role} rooms.objects journal uncovered`);
      }
    }
  }
  if (!files.backend) reasons.push('missing backend coverage: CLI writes would not be journaled');
  return {files, complete: reasons.length === 0, reasons};
}

// Field-set storage writes that violate the barrier. Matches step-mod.js
// journalScan semantics: a journaled store is a violation when it was initiated
// after barrierTs, or when its store-done/store-error terminal is missing or
// landed after barrierTs (straddled the barrier / still in-flight). A delayed
// writer that was drained before the barrier is not flagged. store records are
// matched to terminals by the per-process seq within each journal file.
function postBarrierWrites(root, drainStartTs, barrierTs = drainStartTs) {
  const out = [];
  for (const file of fs.readdirSync(root)) {
    if (!/^step-journal-.*\.jsonl$/.test(file)) continue;
    const stores = new Map(); // seq -> {rec, terminal}
    for (const line of fs.readFileSync(path.join(root, file), 'utf8').split('\n')) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { out.push({file, parseError: true}); continue; }
      if (rec.kind === 'store' && (rec.fs || rec.aux)) {
        if (!Number.isFinite(rec.seq)) { out.push({file, proc: rec.proc, op: rec.op, reason: 'unmatched'}); continue; }
        const e = stores.get(rec.seq) || {rec: null, terminal: null};
        e.rec = rec;
        stores.set(rec.seq, e);
      }
      if ((rec.kind === 'store-done' || rec.kind === 'store-error') && Number.isFinite(rec.seq)) {
        const e = stores.get(rec.seq) || {rec: null, terminal: null};
        e.terminal = rec;
        stores.set(rec.seq, e);
      }
    }
    for (const {rec, terminal} of stores.values()) {
      if (!rec) continue;
      if (rec.t > barrierTs || !terminal || terminal.t > barrierTs) {
        out.push({file, proc: rec.proc, op: rec.op, key: rec.key, collection: rec.collection, t: rec.t,
          reason: rec.t > barrierTs ? 'after-barrier' : (terminal ? 'completed-after-barrier' : 'unterminated')});
      }
    }
  }
  return out;
}

// Capture a snapshot bound to ack.gameTime. Returns {ok, snapshot, problems,
// evidence}; never throws for quiescence failures — ok:false plus reasons is
// the UNKNOWN signal. Throws only on unusable input.
async function captureSnapshot(cli, root, ack, fixture, opts = {}) {
  const {settleMs = 200, betweenReads = null, timeoutMs = 15000} = opts;
  if (!ack || ack.status !== 'cycle-finished-unverified') throw Error('snapshot requires a finished-cycle ack');
  if (!Number.isFinite(ack.gameTime)) throw Error('UNKNOWN: ack lacks calibrated gameTime');
  if (!Number.isFinite(ack.drainStartTs) || !Number.isFinite(ack.barrierTs)) throw Error('UNKNOWN: ack lacks barrier evidence');
  const problems = [];
  if ((ack.postBarrierWrites || []).length) problems.push(`ack recorded ${ack.postBarrierWrites.length} post-barrier writes`);
  const coverage = coverageReport(root);
  if (!coverage.complete) problems.push(`instrumentation coverage degraded: ${coverage.reasons.join('; ')}`);
  let first = null, second = null;
  try { first = await readFieldSet(cli, fixture.rooms, fixture.users, timeoutMs); }
  catch (error) { problems.push(`first field read failed: ${error.message}`); }
  if (first && betweenReads) await betweenReads();
  await sleep(settleMs);
  try { second = await readFieldSet(cli, fixture.rooms, fixture.users, timeoutMs); }
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
  const snapshot = second ? {...second, gameTime: second.gameTime} : null;
  return {ok: problems.length === 0, snapshot, problems,
    evidence: {bound, stable, postBarrierWrites: writes, ttlOk, coverage, ackGameTime: ack.gameTime}};
}

module.exports = {captureSnapshot, readFieldSet, coverageReport, postBarrierWrites};
