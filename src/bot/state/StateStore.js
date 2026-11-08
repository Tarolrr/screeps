// StateStore schema1 of contract A.2 (ARCHITECTURE §6, CONTRACTS-A.md §5, §10 A2).
// Details and the API surface: docs/strategy/STATE-A.md.
//
// The only owner of the MemoryPorts strategy / strategyShadow / strategyMigration.
// It never touches any other Memory key (the ports cannot address them).
//
// open(tick)
//   - one session per tick: a second open in the same tick returns the same
//     session (no re-read); a new tick re-reads Memory (the runtime re-parses it);
//   - namespace absent -> empty schema1 in the session (written lazily on the
//     first accepted write or checkpoint, so a read-only tick writes nothing);
//   - unknown newer schema, corrupt control/meta, unknown migration format, or
//     an older schema (migration required) -> REJECTED(INCOMPATIBLE_SCHEMA, ev):
//     the namespaces are NOT modified (byte-identical), every write is refused;
//   - damaged domain records are quarantined (view.quarantine), stay in Memory
//     and cannot be overwritten or deleted by component writers;
//   - an incompatible Memory.strategyShadow only disables shadow;
//   - a RUNNING migration freezes every writer (READ_ONLY); a RUNNING migration
//     past its window is cancelled here (source intact, restart delay applies);
//   - CPU: when the namespace JSON text equals the text this heap last decoded
//     or wrote (private mirror), the previous decoded view is reused.
//
// Memory vs view: the view is a deep-frozen copy. Accepted patches are applied
// to the view (copy-on-write) AND to the live Memory objects of this tick
// (own-property defines on plain, unfrozen JSON copies) and to a private mirror
// used for change detection. Memory never holds frozen objects, so operator
// console edits after the loop take effect; they are detected on the next open
// because the namespace text differs from the mirror.
//
// apply(expectedRevision, patches): see STATE-A.md "Запись".

const { READY, REJECTED, UNKNOWN } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { fingerprint } = require('../domain/fingerprint');
const { isPlainObject, checkJsonSafe } = require('../domain/canonical');
const { deepFreeze } = require('../domain/freeze');
const layout = require('../domain/stateLayout');
const E = require('../domain/enums');
const { SCHEMA_VERSION } = require('../domain/version');
const { decode, NAMESPACES, DecodeStatus } = require('./StateCodec');
const R = require('./Retention');
const { createMigrationRegistry, createMigrationRunner, finalizeSchema1 } = require('./MigrationRegistry');
const { own, has, put, isForbiddenKey, findForbiddenKey, shallowCopy, jsonClone } = require('./objects');

const NS_STRATEGY = NAMESPACES.STRATEGY;
const NS_SHADOW = NAMESPACES.SHADOW;
const NS_MIGRATION = NAMESPACES.MIGRATION;
const BLOCK_LOG_EVERY = 100;
/** recentPatchIds entry = patchId + RECENT_HASH_SEP + fingerprint(patch content). */
const RECENT_HASH_SEP = '|';

/** Shadow record containers with count limits (path prefix -> limit). */
const COUNT_LIMITS = Object.freeze([
    { path: ['ledger', 'reservations'], limit: layout.LIMITS.shadowReservations },
    { path: ['observedOperations'], limit: layout.LIMITS.observedOperations },
    { path: ['proposals'], limit: layout.LIMITS.proposals },
]);

function isTick(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function textOf(value) {
    if (value === undefined) return null;
    try { return JSON.stringify(value); } catch (error) { return null; }
}

function startsWith(path, prefix) {
    if (prefix.length > path.length) return false;
    for (let i = 0; i < prefix.length; i++) if (path[i] !== prefix[i]) return false;
    return true;
}

function samePath(a, b) {
    return a.length === b.length && startsWith(a, b);
}

function invalid(patchId, errors, extra) {
    return REJECTED(ReasonCode.INVALID_RECORD, Object.assign({ patchId: patchId, errors: errors.slice(0, 20) }, extra || {}));
}

function patchIdOf(p) {
    return isPlainObject(p) && typeof own(p, 'patchId') === 'string' ? own(p, 'patchId') : null;
}

/** Content hash of a patch (writer, namespace, path, op, value). */
function patchHash(p) {
    return fingerprint({ writer: p.writer, namespace: p.namespace, path: p.path, op: p.op, value: has(p, 'value') ? p.value : null });
}

function parseRecent(entry) {
    const i = entry.lastIndexOf(RECENT_HASH_SEP + 'fnv1a64:');
    return i === -1 ? { id: entry, hash: null } : { id: entry.slice(0, i), hash: entry.slice(i + 1) };
}

function publicQuarantine(entries) {
    const list = entries.map(function (q) { return Object.freeze({ namespace: q.namespace, key: q.key === '' ? '*' : q.key, reasonCode: q.reasonCode }); });
    list.sort(function (a, b) {
        if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return Object.freeze(list);
}

/** True when some existing intermediate container on `path` is not a plain object. */
function treeConflict(tree, path) {
    let node = tree;
    for (let i = 0; i < path.length - 1; i++) {
        const child = own(node, path[i]);
        if (child === undefined || child === null) return false; // will be created
        if (!isPlainObject(child)) return true;
        node = child;
    }
    return false;
}

/** Apply one set/delete to a mutable JSON tree (Memory objects or the private mirror). */
function applyToTree(tree, namespace, path, op, value) {
    let node = tree;
    for (let i = 0; i < path.length - 1; i++) {
        let child = own(node, path[i]);
        if (child === undefined || child === null) {
            child = namespace === NS_SHADOW && i === 1 && path[0] === 'rooms' ? layout.emptyShadowRoom() : {};
            put(node, path[i], child);
        }
        node = child;
    }
    const key = path[path.length - 1];
    if (op === E.PatchOp.SET) put(node, key, jsonClone(value));
    else if (has(node, key)) delete node[key];
}

/**
 * @param {Object} options
 * @param {{strategy: object, strategyShadow: object, strategyMigration: object}} options.memory MemoryPorts
 * @param {{buildId?: string, contractVersion?: string, schemaVersion?: number, policyVersion?: string}} [options.buildInfo]
 * @param {{debug?:function, info?:function, warn:function, error:function}} [options.log]
 * @param {{tick: function(): (number|null)}} [options.clock] current tick: lets faultStore() open the session
 *   lazily and refuses writes through a session of an earlier tick
 * @param {ReturnType<typeof createMigrationRegistry>} [options.registry]
 */
function createStateStore(options) {
    const ports = options.memory;
    if (!ports || !ports.strategy || !ports.strategyShadow || !ports.strategyMigration) throw new TypeError('createStateStore needs memory ports strategy, strategyShadow, strategyMigration');
    const buildInfo = options.buildInfo || {};
    const meta = { buildId: typeof buildInfo.buildId === 'string' && buildInfo.buildId ? buildInfo.buildId : null, policyVersion: typeof buildInfo.policyVersion === 'string' && buildInfo.policyVersion ? buildInfo.policyVersion : null };
    const log = options.log || null;
    const clock = options.clock || null;
    const registry = options.registry || createMigrationRegistry();

    /** Current session (one per tick). */
    let session = null;
    /** Per namespace: {text (lazy from mirror), mirror (private JSON copy of Memory), decoded}. */
    const cache = {};
    const heapFaults = new Map();
    const degradation = {};
    let lastBlock = { text: null, tick: null };
    let lastQuarantineCount = 0;
    let runner = null;
    /** Heap-local content identity for StateView fingerprints (nonce = first open tick of this heap). */
    let nonce = null;
    let contentSeq = 0;

    function logWarn(code, fields) { if (log) log.warn(code, fields); }

    function decodeCached(namespace, raw) {
        const text = textOf(raw);
        const c = cache[namespace];
        if (c && text !== null) {
            if (c.text === null) c.text = textOf(c.mirror);
            if (c.text === text) return { decoded: c.decoded, size: text.length, hit: true };
        }
        const decoded = decode(namespace, raw, { meta: meta });
        if (decoded.status === DecodeStatus.OK && text !== null) cache[namespace] = { text: text, mirror: JSON.parse(text), decoded: decoded };
        else delete cache[namespace];
        return { decoded: decoded, size: text === null ? 0 : text.length, hit: false };
    }

    function suspend(tick, evidence) {
        const result = REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, evidence);
        session = { tick: tick, status: E.StateStatus.SUSPENDED, view: null, result: result, evidence: evidence };
        const text = JSON.stringify(evidence);
        if (log && (text !== lastBlock.text || lastBlock.tick === null || tick - lastBlock.tick >= BLOCK_LOG_EVERY)) {
            log.error('STATE_INCOMPATIBLE', evidence);
            lastBlock = { text: text, tick: tick };
        }
        return result;
    }

    function rebuildView() {
        const s = session;
        s.view = Object.freeze({
            dtoType: 'StateView',
            status: s.status,
            sessionTick: s.tick,
            blockedReason: null,
            quarantine: publicQuarantine(s.quarantine),
            strategy: s.strategy,
            shadow: s.shadow,
        });
        s.result = READY(s.view, fingerprint({ nonce: nonce, content: contentSeq, revision: s.strategy.revision, status: s.status, quarantine: s.quarantine.length }));
    }

    /**
     * @param {number} tick
     * @returns {object} READY(StateView) | REJECTED(INCOMPATIBLE_SCHEMA, ev) | UNKNOWN(...)
     */
    function open(tick) {
        if (!isTick(tick)) return UNKNOWN(ReasonCode.MISSING_FIELD, ['tick']);
        if (session !== null && session.tick === tick) return session.result;
        if (nonce === null) nonce = tick;
        const raw = {};
        const names = [NS_STRATEGY, NS_SHADOW, NS_MIGRATION];
        for (let i = 0; i < names.length; i++) {
            try {
                raw[names[i]] = ports[names[i]].read();
            } catch (error) {
                const result = UNKNOWN(ReasonCode.INVALID_RECORD, ['memory.' + names[i]]);
                session = { tick: tick, status: null, view: null, result: result };
                return result;
            }
        }
        let migration = decode(NS_MIGRATION, raw[NS_MIGRATION]);
        if (migration.status === DecodeStatus.INCOMPATIBLE) {
            return suspend(tick, { namespace: NS_MIGRATION, code: migration.errors[0].code, schemaVersion: migration.schemaVersion });
        }
        if (migration.value !== null && migration.value.status === E.MigrationStatus.RUNNING && tick >= migration.value.deadlineTick) {
            // Abandoned run (e.g. no step after a reset): cancel per ARCHITECTURE §6; source stays.
            migrator().expire(tick);
            migration = decode(NS_MIGRATION, ports[NS_MIGRATION].read());
            if (migration.status === DecodeStatus.INCOMPATIBLE) return suspend(tick, { namespace: NS_MIGRATION, code: migration.errors[0].code, schemaVersion: migration.schemaVersion });
        }
        const running = migration.value !== null && migration.value.status === E.MigrationStatus.RUNNING;
        const s = decodeCached(NS_STRATEGY, raw[NS_STRATEGY]);
        if (s.decoded.status === DecodeStatus.INCOMPATIBLE) {
            const e = s.decoded.errors[0];
            return suspend(tick, { namespace: NS_STRATEGY, code: e.code, schemaVersion: s.decoded.schemaVersion, supported: SCHEMA_VERSION, field: e.field || null, error: e.error || null });
        }
        if (s.decoded.status === DecodeStatus.OLDER) {
            const plan = registry.plan(s.decoded.schemaVersion, SCHEMA_VERSION);
            return suspend(tick, { namespace: NS_STRATEGY, code: 'OLDER_SCHEMA', schemaVersion: s.decoded.schemaVersion, supported: SCHEMA_VERSION, migration: running ? 'RUNNING' : plan.kind === 'READY' ? 'REQUIRED' : 'UNAVAILABLE' });
        }
        const sh = decodeCached(NS_SHADOW, raw[NS_SHADOW]);
        const shadowBlocked = sh.decoded.status === DecodeStatus.INCOMPATIBLE;
        let quarantine = s.decoded.quarantine.slice();
        if (shadowBlocked) {
            quarantine.push({ namespace: NS_SHADOW, path: [], key: '*', reasonCode: ReasonCode.INCOMPATIBLE_SCHEMA, code: sh.decoded.errors[0].code });
            logWarn('STATE_SHADOW_INCOMPATIBLE', { code: sh.decoded.errors[0].code, schemaVersion: sh.decoded.schemaVersion });
        } else {
            quarantine = quarantine.concat(sh.decoded.quarantine);
        }
        if (!s.hit || !sh.hit) contentSeq++;
        const strategy = s.decoded.value;
        const shadow = shadowBlocked ? null : sh.decoded.value;
        if (!Object.isFrozen(strategy)) deepFreeze(strategy);
        if (shadow !== null && !Object.isFrozen(shadow)) deepFreeze(shadow);
        session = {
            tick: tick,
            status: running ? E.StateStatus.READ_ONLY : E.StateStatus.OPEN,
            strategy: strategy,
            shadow: shadow,
            shadowBlocked: shadowBlocked,
            quarantine: quarantine,
            size: s.size + sh.size,
            raw: { strategy: raw[NS_STRATEGY], strategyShadow: shadowBlocked ? undefined : raw[NS_SHADOW] },
            view: null,
            result: null,
        };
        if (quarantine.length !== lastQuarantineCount && quarantine.length > 0) logWarn('STATE_QUARANTINE', { count: quarantine.length, first: quarantine[0].namespace + ':' + quarantine[0].key });
        lastQuarantineCount = quarantine.length;
        rebuildView();
        return session.result;
    }

    function quarantineRooms() {
        const out = {};
        session.quarantine.forEach(function (q) {
            if (q.namespace === NS_SHADOW && q.path[0] === 'rooms' && q.path.length >= 2) out[q.path[1]] = 'QUARANTINED_DATA';
        });
        return out;
    }

    function recordDegradation(code, evidence) {
        degradation[code] = Object.assign({ code: code, tick: session ? session.tick : null }, evidence);
        logWarn('STATE_DEGRADED', degradation[code]);
    }

    function sessionProblem(expectedRevision) {
        const exp = isTick(expectedRevision) ? expectedRevision : null;
        if (session === null || session.status === null) return REJECTED(ReasonCode.STALE_INPUT, { expectedRevision: exp, actualRevision: null, cause: 'NO_SESSION' });
        if (session.status === E.StateStatus.SUSPENDED) return REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, { cause: 'SUSPENDED' });
        const actual = session.strategy.revision;
        if (session.status === E.StateStatus.READ_ONLY) return REJECTED(ReasonCode.STALE_INPUT, { expectedRevision: exp, actualRevision: actual, cause: 'MIGRATION_FREEZE' });
        if (clock) {
            const now = clock.tick();
            if (isTick(now) && now > session.tick) return REJECTED(ReasonCode.STALE_INPUT, { expectedRevision: exp, actualRevision: actual, cause: 'SESSION_EXPIRED', sessionTick: session.tick });
        }
        return null;
    }

    /** Write the batch into Memory (live objects of this tick) and the private mirror. */
    function persist(work) {
        const touched = {};
        work.forEach(function (w) { touched[w.namespace] = true; });
        const order = [NS_SHADOW, NS_STRATEGY].filter(function (ns) { return touched[ns]; });
        for (let n = 0; n < order.length; n++) {
            const ns = order[n];
            const c = cache[ns];
            let rawRoot = session.raw[ns];
            let mirror = c ? c.mirror : null;
            const created = rawRoot === undefined;
            if (created) {
                const base = ns === NS_STRATEGY ? session.strategy : session.shadow;
                rawRoot = jsonClone(base);
                mirror = jsonClone(base);
            } else if (mirror === null) {
                mirror = JSON.parse(JSON.stringify(rawRoot));
            }
            for (let i = 0; i < work.length; i++) {
                const w = work[i];
                if (w.namespace !== ns) continue;
                applyToTree(rawRoot, ns, w.path, w.op, w.value);
                applyToTree(mirror, ns, w.path, w.op, w.value);
            }
            if (created) {
                ports[ns].write(rawRoot);
                session.raw[ns] = ports[ns].read();
            }
            cache[ns] = { text: null, mirror: mirror, decoded: null };
        }
    }

    /**
     * Core of apply. mode.internal: writer 'state' maintenance (faults, eviction,
     * compaction): not recorded in recentPatchIds and does NOT bump revision, so
     * sibling components in the same tick never get STALE_INPUT because of it.
     */
    function applyBatch(expectedRevision, patches, mode) {
        const problem = sessionProblem(expectedRevision);
        if (problem !== null) return problem;
        const actual = session.strategy.revision;
        if (!Array.isArray(patches)) return invalid(null, [{ path: '$', code: 'EXPECTED_ARRAY' }]);
        if (!isTick(expectedRevision)) return invalid(null, [{ path: '$/expectedRevision', code: 'EXPECTED_INTEGER' }]);

        const recent = session.strategy.recentPatchIds;
        const recentHash = {};
        for (let i = 0; i < recent.length; i++) { const e = parseRecent(recent[i]); put(recentHash, e.id, e.hash); }
        const seen = {};
        const work = [];
        const hashes = [];
        let replayed = 0;
        for (let i = 0; i < patches.length; i++) {
            const p = patches[i];
            const id = patchIdOf(p);
            const check = layout.validateStatePatch(p);
            if (!check.ok) return invalid(id, check.errors);
            for (let j = 0; j < p.path.length; j++) if (isForbiddenKey(p.path[j])) return invalid(id, [{ path: '$/path/' + j, code: 'FORBIDDEN_KEY' }]);
            if (has(p, 'value')) {
                const bad = findForbiddenKey(p.value);
                if (bad !== null) return invalid(id, [{ path: '$/value' + bad.slice(1), code: 'FORBIDDEN_KEY' }]);
            }
            if (has(seen, id)) return invalid(id, [{ path: '$/patchId', code: 'DUPLICATE_PATCH_ID' }]);
            put(seen, id, true);
            const hash = mode.internal ? null : patchHash(p);
            if (!mode.internal && has(recentHash, id)) {
                const stored = own(recentHash, id);
                if (stored !== null && stored !== hash) return invalid(id, [{ path: '$/patchId', code: 'PATCH_ID_REUSED' }]);
                replayed++;
                continue; // idempotent replay
            }
            if (p.namespace === NS_SHADOW && session.shadowBlocked) return REJECTED(ReasonCode.INCOMPATIBLE_SCHEMA, { patchId: id, namespace: NS_SHADOW });
            for (let q = 0; q < session.quarantine.length; q++) {
                const entry = session.quarantine[q];
                if (entry.namespace !== p.namespace) continue;
                if (samePath(entry.path, p.path)) return invalid(id, [{ path: '$/path', code: 'QUARANTINED' }], { quarantined: entry.key });
                if (startsWith(p.path, entry.path)) return invalid(id, [{ path: '$/path', code: 'QUARANTINED_PARENT' }], { quarantined: entry.key });
                if (startsWith(entry.path, p.path)) return invalid(id, [{ path: '$/path', code: 'QUARANTINE_CONFLICT' }], { quarantined: entry.key });
            }
            work.push(p);
            hashes.push(hash);
        }
        if (work.length === 0) {
            if (expectedRevision > actual) return REJECTED(ReasonCode.STALE_INPUT, { expectedRevision: expectedRevision, actualRevision: actual });
            const value = replayed > 0 ? { revision: actual, replayed: true } : { revision: actual };
            return READY(value, fingerprint(value));
        }
        if (expectedRevision !== actual) return REJECTED(ReasonCode.STALE_INPUT, { expectedRevision: expectedRevision, actualRevision: actual });

        // ---- copy-on-write application to the view
        const fresh = new Set();
        const created = [];
        const values = [];
        const roots = {};
        roots[NS_STRATEGY] = shallowCopy(session.strategy);
        fresh.add(roots[NS_STRATEGY]);
        roots[NS_SHADOW] = session.shadow === null ? null : shallowCopy(session.shadow);
        if (roots[NS_SHADOW] !== null) fresh.add(roots[NS_SHADOW]);
        let delta = 0;
        let shadowTouched = false;
        const touchedRooms = {};

        function sizeOf(value, key) {
            const t = textOf(value);
            return t === null ? 0 : t.length + key.length + 4;
        }
        function walk(namespace, segments) {
            let node = roots[namespace];
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                let child = own(node, seg);
                if (child === undefined || child === null) {
                    child = namespace === NS_SHADOW && i === 1 && segments[0] === 'rooms' ? layout.emptyShadowRoom() : {};
                    put(node, seg, child);
                    fresh.add(child);
                    created.push(child);
                    delta += sizeOf(child, seg);
                } else if (!fresh.has(child)) {
                    child = shallowCopy(child);
                    put(node, seg, child);
                    fresh.add(child);
                }
                node = child;
            }
            return node;
        }
        const evictions = [];
        function removeRoom(room) {
            const rooms = walk(NS_SHADOW, ['rooms']);
            delta -= sizeOf(own(rooms, room), room);
            delete rooms[room];
            evictions.push({ namespace: NS_SHADOW, path: ['rooms', room], op: E.PatchOp.DELETE });
        }

        for (let i = 0; i < work.length; i++) {
            const p = work[i];
            const parent = walk(p.namespace, p.path.slice(0, p.path.length - 1));
            const key = p.path[p.path.length - 1];
            const old = own(parent, key);
            delta -= old === undefined ? 0 : sizeOf(old, key);
            if (p.op === E.PatchOp.SET) {
                const v = jsonClone(p.value);
                put(parent, key, v);
                values.push(v);
                delta += sizeOf(v, key);
            } else if (has(parent, key)) {
                delete parent[key];
            }
            if (p.namespace === NS_SHADOW) {
                shadowTouched = true;
                if (p.path[0] === 'rooms') touchedRooms[p.path[1]] = 'TOUCHED_BY_BATCH';
            }
        }

        // ---- record-count limits (shadow)
        const shadowRoot = roots[NS_SHADOW];
        if (shadowRoot !== null && shadowTouched) {
            const protectedRooms = Object.assign(quarantineRooms(), touchedRooms);
            const roomCount = Object.keys(shadowRoot.rooms).length;
            if (roomCount > layout.LIMITS.shadowRooms) {
                const pick = R.selectEvictableRooms(shadowRoot, { tick: session.tick, need: roomCount - layout.LIMITS.shadowRooms, minAge: R.ROOM_EVICTION_MIN_AGE, protectedRooms: protectedRooms });
                if (!pick.satisfied) {
                    recordDegradation('ROOM_LIMIT', { rooms: roomCount, limit: layout.LIMITS.shadowRooms, blocked: pick.blocked.length });
                    return invalid(work[0].patchId, [{ path: '$/rooms', code: 'TOO_MANY_KEYS' }], { degraded: true, limit: layout.LIMITS.shadowRooms });
                }
                pick.evict.forEach(removeRoom);
            }
            const roomNames = Object.keys(touchedRooms);
            for (let i = 0; i < roomNames.length; i++) {
                const room = own(shadowRoot.rooms, roomNames[i]);
                if (room && Object.keys(room.observedBindings).length > layout.LIMITS.observedBindingsPerRoom) {
                    return invalid(work[0].patchId, [{ path: '$/rooms/' + roomNames[i] + '/observedBindings', code: 'TOO_MANY_KEYS' }], { limit: layout.LIMITS.observedBindingsPerRoom });
                }
            }
            for (let i = 0; i < COUNT_LIMITS.length; i++) {
                let container = shadowRoot;
                COUNT_LIMITS[i].path.forEach(function (seg) { container = own(container, seg); });
                if (Object.keys(container).length > COUNT_LIMITS[i].limit) {
                    return invalid(work[0].patchId, [{ path: '$/' + COUNT_LIMITS[i].path.join('/'), code: 'TOO_MANY_KEYS' }], { limit: COUNT_LIMITS[i].limit });
                }
            }
        }

        // ---- 256 KiB guard: optional (shadow) growth refused; stale rooms compacted first
        const newEntries = mode.internal ? [] : work.map(function (p, i) { return p.patchId + RECENT_HASH_SEP + hashes[i]; });
        newEntries.forEach(function (entry) { delta += entry.length + 3; });
        let size = session.size + delta;
        if (size > R.SIZE_LIMIT_BYTES && delta > 0 && shadowTouched && shadowRoot !== null) {
            const pick = R.selectEvictableRooms(shadowRoot, { tick: session.tick, need: 0, minAge: R.ROOM_EVICTION_MIN_AGE, protectedRooms: Object.assign(quarantineRooms(), touchedRooms) });
            const order = pick.evict.map(function (room) { const last = R.roomLastSeen(own(shadowRoot.rooms, room)); return { room: room, last: last === null ? -1 : last }; })
                .sort(function (a, b) { return a.last !== b.last ? a.last - b.last : (a.room < b.room ? -1 : 1); });
            for (let i = 0; i < order.length && session.size + delta > R.SIZE_LIMIT_BYTES; i++) removeRoom(order[i].room);
            size = session.size + delta;
            if (size > R.SIZE_LIMIT_BYTES && delta > 0) {
                recordDegradation('SIZE_LIMIT', { sizeBytes: size, limitBytes: R.SIZE_LIMIT_BYTES });
                return REJECTED(ReasonCode.BUDGET_DEFERRED, { patchId: work[0].patchId, sizeBytes: size, limitBytes: R.SIZE_LIMIT_BYTES, degraded: true });
            }
        }

        // ---- Memory-side preconditions (never mutate Memory partially)
        const memoryWork = work.map(function (p) { return { namespace: p.namespace, path: p.path, op: p.op, value: p.value }; }).concat(evictions);
        const strategyRoot = roots[NS_STRATEGY];
        const revision = mode.internal ? actual : actual + 1;
        if (!mode.internal) {
            memoryWork.push({ namespace: NS_STRATEGY, path: ['revision'], op: E.PatchOp.SET, value: revision });
            const ids = recent.concat(newEntries).slice(-layout.LIMITS.recentPatchIds);
            memoryWork.push({ namespace: NS_STRATEGY, path: ['recentPatchIds'], op: E.PatchOp.SET, value: ids });
            put(strategyRoot, 'revision', revision);
            put(strategyRoot, 'recentPatchIds', Object.freeze(ids));
        }
        for (let i = 0; i < memoryWork.length; i++) {
            const w = memoryWork[i];
            const rawRoot = session.raw[w.namespace];
            if (rawRoot !== undefined && treeConflict(rawRoot, w.path)) return invalid(work[0].patchId, [{ path: '$/path', code: 'MEMORY_CONFLICT' }], { namespace: w.namespace, at: w.path.join('.') });
        }

        // ---- commit: freeze view, write Memory + mirror, swap references
        for (let i = 0; i < created.length; i++) deepFreeze(created[i]);
        for (let i = 0; i < values.length; i++) deepFreeze(values[i]);
        fresh.forEach(function (node) { Object.freeze(node); });
        try {
            persist(memoryWork);
        } catch (error) {
            if (log) log.error('STATE_WRITE_FAULT', { message: String(error && error.message ? error.message : error).slice(0, 200) });
            // Memory may be partially updated: force a full re-decode on the next open.
            delete cache[NS_STRATEGY];
            delete cache[NS_SHADOW];
            return invalid(work[0].patchId, [{ path: '$', code: 'MEMORY_WRITE_FAILED' }]);
        }
        session.strategy = strategyRoot;
        if (shadowTouched) session.shadow = shadowRoot;
        session.size = Math.max(0, size);
        refreshCacheDecoded();
        contentSeq++;
        if (evictions.length > 0 && log && log.info) log.info('STATE_ROOMS_EVICTED', { rooms: evictions.map(function (e) { return e.path[1]; }).sort() });
        rebuildView();
        const value = { revision: revision };
        return READY(value, fingerprint(value));
    }

    function refreshCacheDecoded() {
        [NS_STRATEGY, NS_SHADOW].forEach(function (ns) {
            const c = cache[ns];
            const root = ns === NS_STRATEGY ? session.strategy : session.shadow;
            if (!c || root === null) return;
            c.text = null;
            c.decoded = { status: DecodeStatus.OK, schemaVersion: SCHEMA_VERSION, value: root, quarantine: session.quarantine.filter(function (q) { return q.namespace === ns; }), errors: [] };
        });
    }

    /**
     * Public apply (composition root, operator tools). Components use forWriter handles.
     * @param {number} expectedRevision
     * @param {Array<object>} patches StatePatch[]
     */
    function apply(expectedRevision, patches) {
        return applyBatch(expectedRevision, patches, { internal: false });
    }

    function view() {
        return session !== null && session.view ? session.view : null;
    }

    /**
     * Writer-bound handle: every patch gets `writer` stamped; a patch declaring
     * a different writer rejects the whole batch.
     * @param {string} writer StateWriter other than 'state'
     */
    function forWriter(writer) {
        if (!E.isEnumValue(E.StateWriter, writer) || writer === E.StateWriter.STATE) throw new TypeError('forWriter: writer must be observation, finance or planning, got ' + String(writer));
        return Object.freeze({
            writer: writer,
            view: view,
            apply: function (expectedRevision, patches) {
                if (!Array.isArray(patches)) return invalid(null, [{ path: '$', code: 'EXPECTED_ARRAY' }]);
                const stamped = [];
                for (let i = 0; i < patches.length; i++) {
                    const p = patches[i];
                    if (!isPlainObject(p)) { stamped.push(p); continue; }
                    if (has(p, 'writer') && own(p, 'writer') !== writer) return invalid(patchIdOf(p), [{ path: '$/writer', code: 'WRITER_MISMATCH' }], { handleWriter: writer });
                    const copy = shallowCopy(p);
                    put(copy, 'writer', writer);
                    stamped.push(copy);
                }
                return applyBatch(expectedRevision, stamped, { internal: false });
            },
        });
    }

    const readOnly = Object.freeze({
        view: view,
        apply: function () { return invalid(null, [{ path: '$', code: 'READ_ONLY_HANDLE' }]); },
    });

    /**
     * Checkpoint. Accepted writes are already in Memory (write-through); this
     * only creates absent namespaces (schema1) and reports the revision. Not a
     * durable commit: the runtime serializes Memory at tick end.
     * @param {string} label
     */
    function checkpoint(label) {
        const problem = sessionProblem(null);
        if (problem !== null) return REJECTED(problem.reasonCode, Object.assign({ label: String(label) }, problem.evidence));
        [NS_STRATEGY, NS_SHADOW].forEach(function (ns) {
            const root = ns === NS_STRATEGY ? session.strategy : session.shadow;
            if (root === null || session.raw[ns] !== undefined) return;
            const rawRoot = jsonClone(root);
            ports[ns].write(rawRoot);
            session.raw[ns] = ports[ns].read();
            cache[ns] = { text: null, mirror: jsonClone(root), decoded: null };
        });
        refreshCacheDecoded();
        const value = { label: String(label), revision: session.strategy.revision };
        return READY(value, fingerprint(value));
    }

    /**
     * Writer-'state' maintenance of strategyShadow.rooms (internal: no revision
     * bump). Evicts rooms not observed for ROOM_RETENTION_TICKS, and stale rooms
     * (>= ROOM_EVICTION_MIN_AGE) when the room count is within ROOM_HEADROOM of
     * the limit. Rooms with disputed or quarantined data are never evicted.
     * @param {number} [tick] defaults to the session tick
     */
    function compact(tick) {
        if (session === null || session.status !== E.StateStatus.OPEN) return REJECTED(ReasonCode.STALE_INPUT, { cause: session && session.status ? session.status : 'NO_SESSION' });
        const shadow = session.shadow;
        const now = isTick(tick) ? tick : session.tick;
        if (shadow === null) return READY({ evicted: [] }, fingerprint({ evicted: [] }));
        const protectedRooms = quarantineRooms();
        const gc = R.selectEvictableRooms(shadow, { tick: now, need: 0, minAge: R.ROOM_RETENTION_TICKS, protectedRooms: protectedRooms });
        const evict = gc.evict.slice();
        const remaining = Object.keys(shadow.rooms).length - evict.length;
        const target = layout.LIMITS.shadowRooms - R.ROOM_HEADROOM;
        if (remaining > target) {
            const p = Object.assign({}, protectedRooms);
            evict.forEach(function (r) { p[r] = 'ALREADY_SELECTED'; });
            const pick = R.selectEvictableRooms(shadow, { tick: now, need: remaining - target, minAge: R.ROOM_EVICTION_MIN_AGE, protectedRooms: p });
            pick.evict.forEach(function (r) { evict.push(r); });
            if (!pick.satisfied) recordDegradation('ROOM_PRESSURE', { rooms: Object.keys(shadow.rooms).length - evict.length, target: target });
        }
        evict.sort();
        if (evict.length === 0) return READY({ evicted: [] }, fingerprint({ evicted: [] }));
        const patches = evict.map(function (room) { return { patchId: 'evict:' + room + ':' + now, writer: E.StateWriter.STATE, namespace: NS_SHADOW, path: ['rooms', room], op: E.PatchOp.DELETE }; });
        const result = applyBatch(session.strategy.revision, patches, { internal: true });
        if (result.kind !== 'READY') return result;
        return READY({ evicted: evict, revision: result.value.revision }, fingerprint({ evicted: evict, revision: result.value.revision }));
    }

    /**
     * Explicit operator/maintenance call: remove ONE quarantined record from
     * Memory and from the quarantine list. Returns the raw value (JSON-safe
     * copy, or null) so the caller can archive it. Component writers can never
     * overwrite or delete a quarantined record.
     * @param {string} namespace 'strategy' | 'strategyShadow'
     * @param {string} key quarantine key as in view.quarantine
     */
    function releaseQuarantine(namespace, key) {
        const problem = sessionProblem(null);
        if (problem !== null) return problem;
        let entry = null;
        for (let i = 0; i < session.quarantine.length; i++) {
            const q = session.quarantine[i];
            if (q.namespace === namespace && q.key === key && q.path.length > 0) entry = q;
        }
        if (entry === null) return invalid(null, [{ path: '$/key', code: 'NOT_QUARANTINED' }], { namespace: String(namespace), key: String(key) });
        let node = session.raw[namespace];
        for (let i = 0; i < entry.path.length - 1 && node !== undefined; i++) node = own(node, entry.path[i]);
        const last = entry.path[entry.path.length - 1];
        const rawValue = isPlainObject(node) || Array.isArray(node) ? own(node, last) : undefined;
        const archived = rawValue !== undefined && checkJsonSafe(rawValue).ok ? jsonClone(rawValue) : null;
        if (isPlainObject(node) && has(node, last)) delete node[last];
        const c = cache[namespace];
        if (c) {
            let m = c.mirror;
            for (let i = 0; i < entry.path.length - 1 && m !== undefined; i++) m = own(m, entry.path[i]);
            if (isPlainObject(m) && has(m, last)) delete m[last];
        }
        session.quarantine = session.quarantine.filter(function (q) { return q !== entry; });
        session.size = Math.max(0, session.size - (textOf(rawValue) || '').length);
        refreshCacheDecoded();
        contentSeq++;
        rebuildView();
        logWarn('STATE_QUARANTINE_RELEASED', { namespace: namespace, key: key });
        return READY({ namespace: namespace, key: key, raw: archived }, fingerprint({ namespace: namespace, key: key }));
    }

    function currentTick() {
        if (clock) {
            const t = clock.tick();
            if (isTick(t)) return t;
        }
        return session !== null ? session.tick : null;
    }

    /**
     * FaultBoundary store backed by strategy.faults (internal writes: no
     * revision bump). load() returns a mutable copy. When the store is not OPEN
     * (suspended, migration freeze, no tick) or the write is refused, the status
     * lives in heap only (lost on reset) and the namespace is not touched.
     */
    function faultStore() {
        return Object.freeze({
            load: function (component) {
                if (heapFaults.has(component)) return Object.assign({}, heapFaults.get(component));
                const t = currentTick();
                if (t !== null) open(t);
                const v = view();
                if (v === null || !isPlainObject(v.strategy.faults)) return null;
                const stored = own(v.strategy.faults, component);
                return stored ? Object.assign({}, stored) : null;
            },
            save: function (component, status) {
                const copy = Object.assign({}, status);
                const t = currentTick();
                if (t !== null) open(t);
                if (session !== null && session.status === E.StateStatus.OPEN) {
                    const result = applyBatch(session.strategy.revision, [{ patchId: 'fault:' + component, writer: E.StateWriter.STATE, namespace: NS_STRATEGY, path: ['faults', component], op: E.PatchOp.SET, value: copy }], { internal: true });
                    if (result.kind === 'READY') { heapFaults.delete(component); return; }
                    logWarn('FAULT_STORE_FALLBACK', { component: String(component).slice(0, 100), reason: result.reasonCode || result.kind });
                }
                heapFaults.set(component, copy);
            },
        });
    }

    /** Migration runner bound to this store's ports (stage A: tests/tools only). */
    function migrator() {
        if (runner === null) {
            runner = createMigrationRunner({
                ports: { source: ports.strategy, migration: ports.strategyMigration },
                registry: registry,
                targetVersion: SCHEMA_VERSION,
                validateTarget: function (draft) { return layout.validateStrategyRoot(draft); },
                finalize: finalizeSchema1,
                onSwap: function () { session = null; delete cache[NS_STRATEGY]; },
                log: log,
            });
        }
        return runner;
    }

    return Object.freeze({
        open: open,
        apply: apply,
        checkpoint: checkpoint,
        compact: compact,
        releaseQuarantine: releaseQuarantine,
        view: view,
        /** Root API for the composition root: {view, apply, forWriter}. Never hand it to a component. */
        api: function () { return Object.freeze({ view: view, apply: apply, forWriter: forWriter }); },
        /** frame.services.state: {view, apply} where apply always refuses (components write via forWriter handles). */
        readOnlyApi: function () { return readOnly; },
        faultStore: faultStore,
        migrator: migrator,
        /** Diagnostics: status, approximate serialized size, degradations. */
        health: function () {
            return {
                status: session === null ? null : session.status,
                tick: session === null ? null : session.tick,
                sizeBytes: session !== null && session.size !== undefined ? session.size : null,
                limitBytes: R.SIZE_LIMIT_BYTES,
                blocked: session !== null && session.status === E.StateStatus.SUSPENDED ? session.evidence : null,
                degradation: Object.keys(degradation).sort().map(function (k) { return degradation[k]; }),
            };
        },
    });
}

module.exports = { createStateStore, RECENT_HASH_SEP };
