'use strict';

// Research-only gate. The ack additionally carries drain evidence for detached
// per-tick writers (processor activateRoom/history/room-stat calls, runner
// console/notification calls, main activateRoom/updateAccessibleRoomsList/
// updateRoomStatusData), a quiescence barrier timestamp, a post-barrier write
// scan over per-process writer journals, and the calibrated gameTime. A coherent
// snapshot still requires the controller-side checks in snapshot-client.js;
// the ack alone does not certify a snapshot.
//
// Storage-write journal design (2026-11 revision): mods load inside
// common.configManager.load() strictly BEFORE common.storage._connect() in
// every process (backend/lib/index.js:14->16, driver/lib/index.js:95->101), so
// storage.env/storage.db are still empty facades at mod-load time and cannot be
// wrapped directly. Instead the mod wraps RpcClient.prototype.request
// (common/lib/rpc.js:125) — the single choke point every env/db/queue/pubsub
// operation flows through once _connect() binds the client. The wrap is
// installed at mod load, before any RpcClient instance exists, so every later
// bound or dynamic request is journaled and its promise registered into the
// role's drain set.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const integrity = require('./step-integrity');

const FAULT_MAX_MS = 8000;
const RPCMARK = Symbol('e2eRpcJournal');
// Field set that a bound snapshot must prove quiescent.
const FIELD_ENV = key => key === 'gameTime' || key === 'activeRooms' || /^memory:/.test(String(key));
// Runtime-consumed cache inputs; journaled for attribution, not part of the set.
const AUX_ENV = key => key === 'accessibleRooms' || key === 'roomStatusData';
const FIELD_DB = new Set(['rooms.objects']);
// RPC methods that mutate env state -> {rpcMethod: envSurfaceName}
const ENV_MUTATIONS = {
  dbEnvSet: 'set', dbEnvSetex: 'setex', dbEnvExpire: 'expire', dbEnvDel: 'del',
  dbEnvHmset: 'hmset', dbEnvHset: 'hset', dbEnvSadd: 'sadd'
};
const ENV_READ_RPC = new Set(['dbEnvGet', 'dbEnvMget', 'dbEnvTtl', 'dbEnvHmget', 'dbEnvHget', 'dbEnvSmembers']);
// Non-mutating collection methods reachable through the 'dbRequest' RPC method.
// 'clear' is deliberately NOT here: it deletes every document in the collection.
const DB_READ_METHODS = new Set(['find', 'findOne', 'by', 'count', 'ensureIndex', 'findEx']);
const DB_MUTATING_METHODS = ['insert', 'update', 'bulk', 'clear', 'removeWhere'];
// Queue writes (mutations); long-poll waits queueFetch/queueWhenAllDone are
// journaled but never drain-tracked (see describeRpc).
const QUEUE_RPC = new Set(['queueAdd', 'queueAddMulti', 'queueMarkDone', 'queueReset']);
const KNOWN_COLLECTIONS = ['rooms.objects', 'rooms', 'rooms.flags', 'rooms.intents',
  'rooms.history', 'rooms.terrain', 'users', 'users.code', 'users.intents',
  'users.console', 'users.notifications', 'users.segments', 'users.power_creeps',
  'env', 'transactions', 'market.orders', 'market.stats', 'leaderboard'];

function readFault(root, name, label) {
  let fault = null;
  try { fault = JSON.parse(fs.readFileSync(path.join(root, 'step-control', name), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const delay = fault && fault.delayMs || 0;
  if (!Number.isInteger(delay) || delay < 0 || delay > FAULT_MAX_MS) throw Error(`invalid ${label} delay`);
  return {fault, delay};
}

module.exports = function install(config) {
  const root = process.env.SCREEPS_E2E_ROOT;
  const marker = process.env.SCREEPS_E2E_MARKER;
  let owner;
  try {
    if (!root || !marker || fs.realpathSync(root) !== fs.realpathSync(process.cwd())) throw Error('root mismatch');
    owner = JSON.parse(fs.readFileSync(path.join(root, 'ownership.json'), 'utf8'));
    if (owner.root !== root || owner.marker !== marker || !owner.runId) throw Error('owner mismatch');
  } catch (error) {
    console.error('E2E gate identity failure:', error.message);
    process.exit(78); // config-manager otherwise catches mod errors and continues uncontrolled
  }

  let role = 'process';
  const journalFile = path.join(root, `step-journal-${process.pid}.jsonl`);
  function journal(record) {
    try { fs.appendFileSync(journalFile, JSON.stringify(record) + '\n', {mode: 0o600}); }
    catch (error) { console.error('E2E journal write failure:', error.message); process.exit(78); }
  }

  // pendingRef.set points at the role-specific drain set once the engine init
  // fires; before that (and in non-engine processes) journal-only applies.
  const pendingRef = {set: null};
  const coverage = {pid: process.pid, role: 'unknown', hooks: {},
    storage: {attempts: 0, source: [], mode: null, rpcWrapped: false,
      envWrapped: [], dbWrapped: {}, resolved: false, connected: false}};

  let storeSeq = 0;

  function trackPromise(out) {
    if (pendingRef.set && out && typeof out.then === 'function') {
      pendingRef.set.add(out);
      const rm = () => pendingRef.set.delete(out);
      // Fulfilled promises leave the drain set early; rejected ones STAY so a
      // later drain's Promise.all observes the failure instead of missing a
      // rejection that settled before the snapshot (fail closed).
      out.then(rm, () => {});
    }
    return out;
  }

  // Classify one RpcClient.request call. Returns null for pure reads (not
  // journaled). `track` marks records whose promise must be awaited by the
  // role's drain set: storage mutations and queue writes only. Long-poll waits
  // (queueFetch, queueWhenAllDone) are deliberately NOT tracked — an in-flight
  // fetch parked in the drain set would deadlock markDone: engine loops issue
  // the next fetch without awaiting the previous room's detached chain
  // (processor.js: the processRoom->markDone chain is not returned).
  function describeRpc(method, args) {
    if (ENV_READ_RPC.has(method)) return null;
    if (Object.prototype.hasOwnProperty.call(ENV_MUTATIONS, method)) {
      const key = args.length ? String(args[0]) : null;
      return {op: `env.${ENV_MUTATIONS[method]}`, key, fs: FIELD_ENV(key), aux: AUX_ENV(key), track: true};
    }
    if (method === 'dbRequest') {
      const collection = String(args[0]);
      const m = String(args[1]);
      if (DB_READ_METHODS.has(m)) return null;
      return {op: `db.${collection}.${m}`, collection, fs: FIELD_DB.has(collection), aux: false, track: true};
    }
    if (method === 'dbUpdate' || method === 'dbBulk') {
      const collection = String(args[0]);
      return {op: `db.${collection}.${method === 'dbUpdate' ? 'update' : 'bulk'}`, collection, fs: FIELD_DB.has(collection), aux: false, track: true};
    }
    if (method === 'dbFindEx') return null;
    if (method === 'dbResetAllData') return {op: 'db.resetAllData', fs: true, aux: false, track: true};
    if (method === 'queueFetch' || method === 'queueWhenAllDone') return {op: `queue.${method}`, fs: false, aux: false, track: false};
    if (QUEUE_RPC.has(method)) return {op: `queue.${method}`, fs: false, aux: false, track: true};
    if (method === 'publish') return {op: 'pubsub.publish', fs: false, aux: false, track: true};
    return {op: `rpc.${method}`, fs: false, aux: false, track: true};
  }

  let storageObjects = {env: null, db: null};
  let cachedManifest = null;
  // Resolves the live @screeps/common module instance in THIS process (same
  // resolved path as the driver's require -> same module cache entry). Fails
  // closed: callers exit(78) on throw.
  function resolveStorage() {
    const out = {env: null, db: null, rpcClientProto: null, collections: [], source: []};
    const manifest = cachedManifest || (cachedManifest = integrity.verifyManifest());
    const req = Module.createRequire(path.join(manifest.base, 'engine', 'dist', 'main.js'));
    let common = null;
    try { common = req('@screeps/common'); } catch (error) { throw Error(`common module resolution failed: ${error.message}`); }
    if (!common || typeof common !== 'object' || !common.storage || !common.rpc || !common.rpc.RpcClient) {
      throw Error('common storage/rpc surface unavailable');
    }
    if (common.storage.env && typeof common.storage.env === 'object') { out.env = common.storage.env; out.source.push('common.env'); }
    if (common.storage.db && typeof common.storage.db === 'object') { out.db = common.storage.db; out.source.push('common.db'); }
    out.rpcClientProto = common.rpc.RpcClient.prototype;
    out.source.push('common.rpc');
    const declared = common.configManager && common.configManager.config &&
      common.configManager.config.common && common.configManager.config.common.dbCollections;
    out.collections = Array.from(new Set([...(declared || []), ...KNOWN_COLLECTIONS]));
    if (!out.env || !out.db) throw Error('storage env/db exports unavailable');
    return out;
  }

  let journalArmed = false;
  // Arms the write journal once per process by wrapping
  // RpcClient.prototype.request. All env/db/queue mutations flow through it:
  // _connect() binds rpcClient.request for env/queue methods and collection
  // facades call it dynamically. Reads are skipped (journaled surface is
  // mutations only) but every request promise is drain-tracked.
  function armStorageJournal() {
    coverage.storage.attempts++;
    const s = resolveStorage(); // throws -> caller exits 78
    storageObjects.env = s.env;
    storageObjects.db = s.db;
    coverage.storage.source = s.source;
    if (!journalArmed) {
      const proto = s.rpcClientProto;
      if (proto.request && proto.request[RPCMARK]) {
        journalArmed = true; // already wrapped in this process
      } else {
        const orig = proto.request;
        if (typeof orig !== 'function') throw Error('RpcClient.request unavailable');
        const wrapped = function (method, ...args) {
          const rec = describeRpc(method, args);
          let seq = 0;
          if (rec) {
            seq = ++storeSeq;
            journal({kind: 'store', seq, proc: role, op: rec.op, key: rec.key, collection: rec.collection,
              fs: !!rec.fs, aux: !!rec.aux, t: Date.now()});
          }
          const out = orig.apply(this, [method, ...args]);
          if (rec) {
            if (out && typeof out.then === 'function') {
              out.then(() => journal({kind: 'store-done', seq, proc: role, op: rec.op, t: Date.now()}),
                       error => journal({kind: 'store-error', seq, proc: role, op: rec.op, error: String(error), t: Date.now()}));
            } else {
              journal({kind: 'store-error', seq, proc: role, op: rec.op, error: 'non-promise result', t: Date.now()});
            }
          }
          if (rec && rec.track) trackPromise(out);
          return out;
        };
        wrapped[RPCMARK] = true;
        proto.request = wrapped;
        journalArmed = true;
      }
      coverage.storage.mode = 'rpc';
      coverage.storage.rpcWrapped = journalArmed;
      coverage.storage.envWrapped = Object.values(ENV_MUTATIONS);
      coverage.storage.dbWrapped = {};
      for (const name of s.collections) coverage.storage.dbWrapped[name] = DB_MUTATING_METHODS.slice();
      coverage.storage.resolved = journalArmed;
    }
    // Surface-materialization evidence: _connect() populates env/db in place
    // after mods load; connected=true proves the facade methods now exist.
    coverage.storage.connected = !!(storageObjects.env && typeof storageObjects.env.set === 'function' &&
      storageObjects.db && storageObjects.db['rooms.objects'] && typeof storageObjects.db['rooms.objects'].find === 'function');
    return journalArmed;
  }

  function writeCoverage(extra) {
    Object.assign(coverage, extra || {});
    coverage.role = role;
    coverage.ts = Date.now();
    const file = path.join(root, `step-coverage-${role}-${process.pid}.json`);
    try { fs.writeFileSync(file, JSON.stringify(coverage), {mode: 0o600}); }
    catch (error) { console.error('E2E coverage write failure:', error.message); process.exit(78); }
  }

  // Wrap a detached driver-level writer (whitelist only — never a regex sweep
  // over driver functions: sync factories like getRoomStatsUpdater must not be
  // promisified). Journals the call, applies an optional injected delay/reject
  // fault, and registers the promise into the drain set.
  function wrapDetached(obj, name, pending, faultFile, label) {
    const orig = obj[name];
    obj[name] = function (...args) {
      const {fault, delay} = readFault(root, faultFile, label);
      const promise = new Promise(resolve => setTimeout(resolve, delay)).then(() => {
        if (fault && fault.reject) throw Error(`injected ${name} failure`);
        return orig.apply(this, args);
      });
      journal({kind: 'writer', proc: role, op: name, t: Date.now()});
      pending.add(promise);
      const rm = () => pending.delete(promise);
      promise.then(rm, () => {}); // rejected writers stay in the drain set -> UNKNOWN
      return promise;
    };
    coverage.hooks[name] = faultFile;
  }

  function wrapDetachedIfPresent(obj, name, pending, faultFile, label) {
    if (typeof obj[name] === 'function') wrapDetached(obj, name, pending, faultFile, label);
    else coverage.hooks[name] = 'absent';
  }

  // Inject a deliberately untracked field-set write after the quiescence
  // barrier (negative control). Single-shot: the file is consumed. The write
  // goes through the real storage facade so it lands in the rpc journal —
  // detection would otherwise be vacuous.
  function consumeInjection() {
    const file = path.join(root, 'step-control', 'injected-write.json');
    let inj = null;
    try { inj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    fs.unlinkSync(file);
    if (!inj || typeof inj !== 'object') throw Error('invalid injected write');
    if (!journalArmed) {
      journal({kind: 'injection-skipped', proc: role, op: inj.op, t: Date.now()});
      throw Error('journal disarmed: injected write would not be detected');
    }
    if (inj.op === 'env.set' && storageObjects.env && typeof storageObjects.env.set === 'function') {
      storageObjects.env.set(String(inj.key), String(inj.value)); // intentionally detached
    } else if (inj.op === 'db.insert' && storageObjects.db && storageObjects.db[inj.collection] &&
               typeof storageObjects.db[inj.collection].insert === 'function') {
      storageObjects.db[inj.collection].insert(inj.doc); // intentionally detached
    } else {
      journal({kind: 'injection-skipped', proc: role, op: inj.op, t: Date.now()});
      throw Error('injected write channel unavailable');
    }
    return inj;
  }

  // Post-barrier scan. A field-set write is a violation when it was initiated
  // after the barrier, or when it lacked a journaled terminal (store-done /
  // store-error) at or before barrierTs — i.e. it straddled the barrier or
  // never completed. A delayed-but-drained writer completes before the
  // barrier and is NOT flagged. store/store-done pairs are matched by the
  // per-process seq; drains are scoped to this cycle (t >= cycleStartTs).
  function journalScan(cycleStartTs, drainStartTs, barrierTs) {
    const postBarrier = [], drains = [];
    for (const file of fs.readdirSync(root)) {
      if (!/^step-journal-.*\.jsonl$/.test(file)) continue;
      const stores = new Map(); // seq -> {rec, terminal}
      for (const line of fs.readFileSync(path.join(root, file), 'utf8').split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { postBarrier.push({file, parseError: true}); continue; }
        if (rec.kind === 'store' && (rec.fs || rec.aux)) {
          if (!Number.isFinite(rec.seq)) { postBarrier.push({file, proc: rec.proc, op: rec.op, reason: 'unmatched'}); continue; }
          const e = stores.get(rec.seq) || {rec: null, terminal: null};
          e.rec = rec;
          stores.set(rec.seq, e);
        }
        if ((rec.kind === 'store-done' || rec.kind === 'store-error') && Number.isFinite(rec.seq)) {
          const e = stores.get(rec.seq) || {rec: null, terminal: null};
          e.terminal = rec;
          stores.set(rec.seq, e);
        }
        if ((rec.kind === 'drain' || rec.kind === 'barrier') && Number.isFinite(rec.t) && rec.t >= cycleStartTs) drains.push(rec);
      }
      // If the drain threw, no barrier exists (barrierTs unset): post-barrier
      // violation analysis is moot — the cycle already fails on customComplete.
      if (!Number.isFinite(barrierTs)) continue;
      for (const {rec, terminal} of stores.values()) {
        if (!rec) continue;
        if (rec.t > barrierTs || !terminal || terminal.t > barrierTs) {
          postBarrier.push({file, proc: rec.proc, op: rec.op, key: rec.key, collection: rec.collection, t: rec.t,
            reason: rec.t > barrierTs ? 'after-barrier' : (terminal ? 'completed-after-barrier' : 'unterminated')});
        }
      }
    }
    return {postBarrier, drains};
  }

  function coverageScan() {
    const files = {};
    for (const file of fs.readdirSync(root)) {
      const match = /^step-coverage-(main|runner|processor|backend|process)-\d+\.json$/.exec(file);
      if (!match) continue;
      try { files[match[1]] = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
      catch (error) { files[match[1]] = {parseError: String(error)}; }
    }
    const wrapped = (file, name) => file && file.hooks && file.hooks[name] && file.hooks[name] !== 'absent';
    const hooksOk = files.main && files.runner && files.processor &&
      wrapped(files.main, 'activateRoom') && wrapped(files.main, 'updateAccessibleRoomsList') &&
      wrapped(files.main, 'updateRoomStatusData') && wrapped(files.main, 'incrementGameTime') &&
      wrapped(files.processor, 'activateRoom') &&
      wrapped(files.runner, 'usersQueueDrain') && wrapped(files.runner, 'saveUserMemory');
    const storageOk = files.main && files.runner && files.processor &&
      [files.main, files.runner, files.processor].every(f => f.storage && f.storage.resolved &&
        f.storage.envWrapped.includes('set') && f.storage.dbWrapped['rooms.objects'] &&
        f.storage.dbWrapped['rooms.objects'].length > 0);
    return {files, hooksOk: !!hooksOk, storageOk: !!storageOk, complete: !!(hooksOk && storageOk)};
  }

  if (config.backend && config.cronjobs) {
    role = 'backend';
    const cronDisabled = process.env.SCREEPS_E2E_KEEP_CRON !== '1';
    if (cronDisabled) config.cronjobs = {}; // isolated test topology: no backend cron scheduling
    fs.writeFileSync(path.join(root, 'step-backend-cron-disabled.json'), JSON.stringify({pid:process.pid, runId:owner.runId, cronDisabled}), {mode:0o600, flag:'wx'});
  }

  // Journal storage mutations in every process the mod loads into. Arming is
  // synchronous and fail-closed: if the rpc choke point cannot be wrapped the
  // process exits rather than running unjournaled.
  try { armStorageJournal(); }
  catch (error) { console.error('E2E storage journal failure:', error.message); process.exit(78); }
  writeCoverage();
  // Re-arm/evidence refresh: the storage facade is populated by _connect()
  // after mods load; the timer only exists to flip coverage.storage.connected
  // once the facade materializes (and to retry in the unlikely event the first
  // resolution raced an unloadable module). Failures stay fail-closed.
  let armAttempts = 0;
  const armTimer = setInterval(() => {
    try { armStorageJournal(); }
    catch (error) { console.error('E2E storage journal failure:', error.message); clearInterval(armTimer); return process.exit(78); }
    if ((coverage.storage.connected && journalArmed) || ++armAttempts > 15) { clearInterval(armTimer); writeCoverage(); }
  }, 1000);
  if (armTimer.unref) armTimer.unref();

  if (!config.engine) return; // backend/storage load the same mod list
  config.engine.on('init', type => {
    try { engineInit(type); }
    catch (error) { console.error('E2E init instrumentation failure:', error.message); process.exit(78); }
  });
  function engineInit(type) {
    if (['main','runner','processor'].includes(type)) {
      role = type;
      try { integrity.verifyManifest(); integrity.register(root,type); } catch (error) { console.error(error); process.exit(78); }
      armStorageJournal();
    }
    if (type === 'processor') {
      // processRoom deliberately does not await its detached writers. Drain the
      // real storage promises before allowing this processor to mark a room done.
      const driver = config.engine.driver, pending = new Set();
      pendingRef.set = pending;
      const audit = record => fs.appendFileSync(path.join(root, `step-processor-${process.pid}.jsonl`), JSON.stringify(record) + '\n', {mode:0o600});
      config.engine.on('processorLoopStage', (stage, room) => {
        if (['getRoomData','processRoom','saveRoom','finish'].includes(stage)) audit({stage, room:room || null});
        if (stage === 'saveRoom' && fs.existsSync(path.join(root,'step-control','processor-fault.json'))) throw Error('injected processor failure');
      });
      const log = console.log;
      console.log = function (...args) {
        if (typeof args[0] === 'string' && args[0].startsWith('Error processing room ')) audit({stage:'error', message:args.map(String).join(' ')});
        return log.apply(this, args);
      };
      const errorLog = console.error;
      console.error = function (...args) {
        if (typeof args[0] === 'string' && args[0].startsWith('Error in processor loop:')) audit({stage:'error', message:args.map(String).join(' ')});
        return errorLog.apply(this, args);
      };
      const activate = driver.activateRoom;
      if (typeof activate === 'function') {
        driver.activateRoom = function (...args) {
          const {fault, delay} = readFault(root, 'activate-fault.json', 'test');
          const promise = new Promise(resolve => setTimeout(resolve, delay)).then(() => {
            if (fault && fault.reject) throw Error('injected activateRoom failure');
            return activate.apply(this, args);
          });
          journal({kind:'writer', proc:role, op:'activateRoom', t:Date.now()});
          pending.add(promise);
          const rm = () => pending.delete(promise);
          promise.then(rm, () => {}); // rejected writers stay in the drain set -> UNKNOWN
          return promise;
        };
        coverage.hooks.activateRoom = 'activate-fault.json';
      } else coverage.hooks.activateRoom = 'absent';
      // processor.js launches room history persistence (history.upload /
      // history.saveTick via saveRoomHistory) and room-stat saves
      // (roomsStatsSave) without awaiting them (~dist:458-469). Whitelist the
      // real detached entry points only — a regex sweep would promisify sync
      // factories (getRoomStatsUpdater) and break the processor. sendNotification
      // is also invoked unawaited from intent ticks; its storage writes are
      // auto-drained by the rpc tracker even without a named hook.
      if (driver.history && typeof driver.history === 'object') {
        for (const name of ['saveTick', 'upload']) {
          if (typeof driver.history[name] === 'function') {
            wrapDetached(driver.history, name, pending, 'history-fault.json', 'history');
            coverage.hooks[`history.${name}`] = 'history-fault.json';
          } else coverage.hooks[`history.${name}`] = 'absent';
        }
        coverage.hooks.historyFns = 2;
      } else { coverage.hooks['history.saveTick'] = 'absent'; coverage.hooks['history.upload'] = 'absent'; coverage.hooks.historyFns = 0; }
      wrapDetachedIfPresent(driver, 'roomsStatsSave', pending, 'roomstat-fault.json', 'roomstat');
      writeCoverage();
      const create = driver.queue.create;
      driver.queue.create = function (...args) {
        return Promise.resolve(create.apply(this, args)).then(queue => {
          if (args[0] === 'rooms' && args[1] === 'read') {
            const mark = queue.markDone.bind(queue);
            queue.markDone = function (...markArgs) {
              const work = [...pending];
              return Promise.all(work).then(() => {
                for (const promise of work) pending.delete(promise);
                journal({kind:'drain', proc:role, queue:'rooms', count:work.length, t:Date.now()});
                return mark(...markArgs);
              });
            };
          }
          return queue;
        });
      };
    }
    if (type === 'runner') {
      let user = null;
      const driver = config.engine.driver, runnerPending = new Set();
      pendingRef.set = runnerPending;
      const saveMemory = driver.saveUserMemory;
      if (typeof saveMemory === 'function') {
        driver.saveUserMemory = function (...args) {
          const {fault, delay} = readFault(root, 'memory-fault.json', 'memory');
          return new Promise(resolve => setTimeout(resolve,delay)).then(() => {
            if (fault && fault.reject) throw Error('injected memory save failure');
            return saveMemory.apply(this,args);
          });
        };
        coverage.hooks.saveUserMemory = 'memory-fault.json';
      } else coverage.hooks.saveUserMemory = 'absent';
      const auditRunner = record => fs.appendFileSync(path.join(root, `step-runner-${process.pid}.jsonl`), JSON.stringify(record) + '\n', {mode:0o600});
      const runnerError = console.error;
      console.error = function (...args) {
        if (typeof args[0] === 'string' && args[0].startsWith('Error in runner loop:')) auditRunner({user, stage:'error', error:args.map(String).join(' ')});
        return runnerError.apply(this,args);
      };
      config.engine.on('runnerLoopStage', (stage, value) => {
        if (stage === 'runUser') user = String(value);
        if (stage === 'saveResultStart') {
          auditRunner({user, stage:'start', error:value && value.error ? String(value.error) : null, hasMemory:!!(value && value.memory), hasIntents:!!(value && value.intents)});
        }
        if (stage === 'saveResultFinish') auditRunner({user, stage:'saved'});
      });
      // runner.js launches console/error notification work without awaiting it
      // (~dist:23-28). Whitelist the real detached entry points and drain them
      // into the user queue drain; every storage write they issue is also
      // auto-drained by the rpc tracker. Transient pubsub console output is not
      // storage state.
      for (const name of ['sendConsoleMessages', 'sendConsoleError', 'sendNotification']) {
        wrapDetachedIfPresent(driver, name, runnerPending, 'notify-fault.json', 'notify');
      }
      coverage.hooks.notifyFns = 3;
      // Drain pending runner writes before a fetched user item is marked done.
      const createUser = driver.queue.create;
      driver.queue.create = function (...args) {
        return Promise.resolve(createUser.apply(this, args)).then(queue => {
          if (args[0] === 'users') {
            const mark = queue.markDone.bind(queue);
            queue.markDone = function (...markArgs) {
              const work = [...runnerPending];
              return Promise.all(work).then(() => {
                for (const promise of work) runnerPending.delete(promise);
                journal({kind:'drain', proc:role, queue:'users', count:work.length, t:Date.now()});
                return mark(...markArgs);
              });
            };
          }
          return queue;
        });
      };
      coverage.hooks.usersQueueDrain = 'users';
      writeCoverage();
    }
    if (type !== 'main') return;
    role = 'main';
    const dir = path.join(root, 'step-control');
    try { fs.mkdirSync(dir, {mode: 0o700}); }
    catch (error) { console.error('E2E gate requires a fresh control directory:', error.message); process.exit(78); }
    const session = crypto.randomBytes(24).toString('hex');
    const stagesExpected = ['start', 'getUsers', 'addUsersToQueue', 'waitForUsers', 'getRooms', 'addRoomsToQueue', 'waitForRooms', 'commit1', 'global', 'commit2', 'incrementGameTime', 'notifyRoomsDone', 'custom', 'finish'];
    const driver = config.engine.driver;
    // The pinned driver always exposes this surface; the synthetic offline
    // harness (step-selftest) does not. Strict gates (finite gameTime, complete
    // cross-process coverage) apply only when the real surface is present —
    // under the pinned manifest it cannot silently degrade.
    const driverSurface = ['incrementGameTime', 'getGameTime', 'getRoomStatsUpdater', 'makeRuntime']
      .every(name => typeof driver[name] === 'function');
    let sequence = 0, stages = [], active = false, customComplete = false, queuedUsers = null, queuedRooms = null, resetDuringCycle = false, controllerToken = null;
    let gameTime = null, cycleStartTs = null, drainStartTs = null, barrierTs = null;
    const globalPending = new Set();
    pendingRef.set = globalPending;
    const mainActivate = driver.activateRoom;
    if (typeof mainActivate === 'function') {
      driver.activateRoom = function (...args) {
        const p = Promise.resolve().then(() => mainActivate.apply(this,args));
        journal({kind:'writer', proc:role, op:'activateRoom', t:Date.now()});
        globalPending.add(p);
        const rm = () => globalPending.delete(p);
        p.then(rm, () => {}); // rejected writers stay in the drain set -> UNKNOWN
        return p;
      };
      coverage.hooks.activateRoom = 'drain-only';
    } else coverage.hooks.activateRoom = 'absent';
    // main.js launches updateAccessibleRoomsList and updateRoomStatusData
    // without awaiting them (~dist:77-87, before roomsDone), gated on
    // gameTime > lastUpdate + 20. Drain both into the custom-stage barrier;
    // they write env accessibleRooms/roomStatusData that runtime data consumes.
    for (const [name, faultFile, label] of [
      ['updateAccessibleRoomsList', 'access-rooms-fault.json', 'access-rooms'],
      ['updateRoomStatusData', 'room-status-fault.json', 'room-status']]) {
      wrapDetachedIfPresent(driver, name, globalPending, faultFile, label);
    }
    // gameTime binding: the 'incrementGameTime' stage is emitted without datum;
    // the new time exists only as the driver.incrementGameTime() resolution
    // (env.set resolves to the value written). Wrap it and capture the value;
    // fall back to driver.getGameTime() if the resolution is not finite.
    const incTime = driver.incrementGameTime;
    if (typeof incTime === 'function') {
      driver.incrementGameTime = function (...args) {
        return Promise.resolve(incTime.apply(this, args)).then(value => {
          const n = Number(value);
          if (Number.isFinite(n)) { gameTime = n; return value; }
          if (typeof driver.getGameTime === 'function') {
            return Promise.resolve(driver.getGameTime()).then(g => {
              const m = Number(g);
              if (Number.isFinite(m)) gameTime = m;
              return value;
            });
          }
          return value;
        });
      };
      coverage.hooks.incrementGameTime = 'bound';
    } else coverage.hooks.incrementGameTime = 'absent';
    const custom = config.engine.mainLoopCustomStage;
    config.engine.mainLoopCustomStage = async function (...args) {
      const result = await custom.apply(this,args);
      drainStartTs = Date.now();
      await Promise.all([...globalPending]); globalPending.clear();
      barrierTs = Date.now();
      journal({kind:'barrier', proc:role, drainStart:drainStartTs, t:barrierTs});
      consumeInjection(); // negative-control hook: untracked post-barrier write
      return result;
    };
    const resetAll = driver.queue.resetAll;
    driver.queue.resetAll = function (...args) { resetDuringCycle = true; return resetAll.apply(this, args); };
    const offsets = new Map();
    function auditDelta() {
      const out = {runner:[], processor:[]};
      for (const file of fs.readdirSync(root)) {
        const match = /^step-(runner|processor)-.*\.jsonl$/.exec(file);
        if (!match) continue;
        const data = fs.readFileSync(path.join(root,file), 'utf8'), offset = offsets.get(file) || 0;
        if (offset > data.length) throw Error('audit truncated');
        out[match[1]].push(...data.slice(offset).split('\n').filter(Boolean).map(JSON.parse));
        offsets.set(file,data.length);
      }
      return out;
    }
    const originalCustom = config.engine.mainLoopCustomStage;
    config.engine.mainLoopCustomStage = function (...args) {
      return Promise.resolve().then(() => originalCustom.apply(this, args)).then(value => { customComplete = true; return value; });
    };
    const write = (name, value) => {
      const tmp = path.join(dir, `${name}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(value), {mode: 0o600, flag: 'wx'});
      fs.renameSync(tmp, path.join(dir, name));
    };
    write('ready.json', {session, runId: owner.runId, pid: process.pid, protocol: 1});
    writeCoverage();
    config.engine.on('mainLoopStage', (stage, data) => {
      if (stage === 'addUsersToQueue') queuedUsers = Array.isArray(data) ? data.map(user => String(user._id)) : null;
      if (stage === 'addRoomsToQueue') queuedRooms = Array.isArray(data) ? data.slice() : null;
      if (stage === 'incrementGameTime') {
        gameTime = typeof data === 'number' && Number.isFinite(data) ? data
          : (data && typeof data === 'object' && Number.isFinite(data.gameTime) ? data.gameTime : gameTime);
        // Fault-file presence forces the same detached invocation the engine
        // would make at +gameTime > lastUpdate + 20 (main.js:79). This is how
        // fault probes exercise the gated writers below tick 21; the writes are
        // real and journaled.
        for (const [name, faultFile] of [['updateAccessibleRoomsList','access-rooms-fault.json'],['updateRoomStatusData','room-status-fault.json']]) {
          if (typeof driver[name] === 'function' && fs.existsSync(path.join(dir, faultFile))) {
            try { driver[name](); journal({kind:'forced-writer', proc:role, op:name, t:Date.now()}); }
            catch (error) { journal({kind:'forced-writer-error', proc:role, op:name, error:String(error), t:Date.now()}); }
          }
        }
      }
      if (stage === 'start') { stages = ['start']; customComplete = false; resetDuringCycle = false; gameTime = null; cycleStartTs = Date.now(); drainStartTs = null; barrierTs = null; }
      else stages.push(stage);
      if (stage === 'finish' && active) {
        active = false;
        let audit, valid = false;
        const scan = (drainStartTs === null || cycleStartTs === null) ? {postBarrier: [], drains: []} : journalScan(cycleStartTs, drainStartTs, barrierTs);
        const cov = coverageScan();
        try {
          audit = auditDelta();
          valid = !resetDuringCycle && customComplete && JSON.stringify(stages) === JSON.stringify(stagesExpected) && Array.isArray(queuedUsers) && Array.isArray(queuedRooms)
            && queuedUsers.every(id => audit.runner.filter(item => item.user === id && item.stage === 'start' && !item.error && item.hasMemory).length === 1 && audit.runner.filter(item => item.user === id && item.stage === 'saved').length === 1)
            && !audit.runner.some(item => item.error)
            && queuedRooms.every(id => audit.processor.filter(item => item.room === id && item.stage === 'saveRoom').length === 1)
            && !audit.processor.some(item => item.stage === 'error')
            && scan.postBarrier.length === 0
            && journalArmed
            && (!driverSurface || (Number.isFinite(gameTime) && cov.complete));
        } catch (error) { audit = {error:String(error)}; }
        write(`ack-${sequence}.json`, {session, token:controllerToken, sequence, stages, queuedUsers, queuedRooms, resetDuringCycle, audit,
          gameTime, gameTimeBound: Number.isFinite(gameTime), engineSurface: driverSurface,
          cycleStartTs, drainStartTs, barrierTs, drains: scan.drains, postBarrierWrites: scan.postBarrier,
          coverage: cov, status: valid ? 'cycle-finished-unverified' : 'unknown'});
      }
    });
    if (!global.__screepsStepPreload) {
      console.error('E2E scheduler preload missing'); process.exit(78);
    }
    global.__screepsStepSchedule = function schedule(loop, delay) {
      setTimeout(() => {
        const poll = () => {
          const name = path.join(dir, `command-${sequence + 1}.json`);
          let cmd;
          try { cmd = JSON.parse(fs.readFileSync(name, 'utf8')); }
          catch (error) {
            if (error.code === 'ENOENT') return setTimeout(poll, 20);
            console.error('E2E invalid command:', error.message); return process.exit(78);
          }
          let lease;
          try { integrity.verifyManifest(); lease=JSON.parse(fs.readFileSync(path.join(dir,'controller.json'),'utf8')); } catch(error) { console.error('E2E guard failure:',error.message); return process.exit(78); }
          if (fs.existsSync(path.join(dir,'poisoned.json')) || !cmd.token || lease.token !== cmd.token || lease.session !== session || (controllerToken && controllerToken !== cmd.token) || cmd.session !== session || cmd.sequence !== sequence + 1 || cmd.action !== 'step') {
            console.error('E2E invalid step command'); return process.exit(78);
          }
          controllerToken = cmd.token; sequence++;
          active = true;
          loop();
        };
        poll();
      }, delay);
    };
  }
};
