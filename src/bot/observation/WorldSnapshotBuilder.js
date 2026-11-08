// WorldSnapshotBuilder (A1, contract A.2 §4.1, §10): PURE conversion of the
// Reader's internal plain "observation" into a deep-frozen Snapshot DTO.
// No Game/Memory access; input is plain data copied by the Reader.
//
// observation = {
//   tick, shard: string|null, captureStage: 'FULL'|'CRITICAL',
//   cpu: {used, limit, tickLimit, bucket: number|null, missingFields: string[]},
//   rooms: { [roomName]: roomObservation },
//   creeps: [creepObservation]
// }
// roomObservation = {
//   roomName, tick, visible: boolean,
//   eventLog: {raw: Array|null} | null,          (null => UNAVAILABLE when visible)
//   controller: {id, my, ownerName, reservationOwner, level, progress, progressTotal, ticksToDowngrade, safeModeTicks}|null,
//   energyAvailable, energyCapacityAvailable: number|undefined,
//   structures: [{id, objectType, pos, energy, capacity}],   (energy structures only)
//   spawns: [{id, name, pos, spawning: {name, needTime, remainingTime}|null}],
//   sources: [{id, pos, energy, energyCapacity, ticksToRegeneration}],
//   hostiles: [{id, ownerName, pos, body, hits, hitsMax}],
//   constructionSites: [{id, structureType, pos, my, progress, progressTotal}],
//   piles: [{id, objectType: 'resource'|'tombstone'|'ruin', pos, energy}],
//   creeps: [creepObservation]                   (own creeps currently in this room)
// }
// creepObservation = {name, id, roomName, pos, spawning, body, ticksToLive, energy, capacity, legacyRole}
//
// Unknown numbers (undefined/null/NaN) become Measured UNKNOWN(MISSING_FIELD) and
// are listed in missingFields; they never become 0.

const { measured, unknownMeasure, snapshotFingerprint } = require('../domain/dtos');
const { CONTRACT_VERSION } = require('../domain/version');
const { ReasonCode } = require('../domain/reasonCodes');
const { isPosition, isRoomName } = require('../domain/keys');
const { fingerprint } = require('../domain/fingerprint');
const { canonicalClone } = require('../domain/canonical');
const { deepFreeze } = require('../domain/freeze');

function isNum(v) {
    return typeof v === 'number' && isFinite(v);
}

function isNonNegInt(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** @returns {import('../domain/types').Measured} */
function meas(value, path, missing) {
    if (isNum(value)) return measured(value);
    if (missing) missing.push(path);
    return unknownMeasure(ReasonCode.MISSING_FIELD);
}

function pos(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const p = { roomName: raw.roomName, x: raw.x, y: raw.y };
    return isPosition(p) ? p : null;
}

function byId(field) {
    return function (a, b) { return a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0; };
}

/** Sort by key and drop duplicate keys (first wins). */
function sortedUnique(list, field) {
    const sorted = list.slice().sort(byId(field));
    const out = [];
    for (let i = 0; i < sorted.length; i++) {
        if (out.length === 0 || out[out.length - 1][field] !== sorted[i][field]) out.push(sorted[i]);
    }
    return out;
}

function sortedStrings(list) {
    const sorted = list.slice().sort();
    const out = [];
    for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) out.push(sorted[i]);
    return out;
}

/** Body parts; invalid type/hits get a placeholder (DTO needs them) and the path goes to missing. */
function bodyParts(body, path, missing) {
    const out = [];
    const list = Array.isArray(body) ? body : [];
    for (let i = 0; i < list.length; i++) {
        const part = list[i] || {};
        const typeOk = typeof part.type === 'string' && part.type !== '';
        const hitsOk = isNonNegInt(part.hits);
        if (!typeOk && missing) missing.push(path + '.' + i + '.type');
        if (!hitsOk && missing) missing.push(path + '.' + i + '.hits');
        out.push({
            type: typeOk ? part.type : 'unknown',
            boost: typeof part.boost === 'string' && part.boost !== '' ? part.boost : null,
            hits: Math.max(0, Math.min(100, hitsOk ? part.hits : 0)),
        });
    }
    return out;
}

/** Integer the DTO requires; an invalid value falls back to `fallback` and is listed as missing. */
function intOr(v, fallback, path, missing) {
    if (isNonNegInt(v)) return v;
    if (missing) missing.push(path);
    return fallback;
}

/** Measured whose absence is defined by the engine API (not applicable): UNKNOWN, but not a missing observation. */
function measOrNotApplicable(value, applicable, path, missing) {
    if (isNum(value)) return measured(value);
    if (applicable && missing) missing.push(path);
    return unknownMeasure(ReasonCode.MISSING_FIELD);
}

/**
 * Energy nodes of one room by physical class (spawn/extension, storage/container,
 * cargo of own creeps, piles/tombstones/ruins, remote sources). Sorted by nodeId.
 * Sources of rooms whose controller is not ours are REMOTE nodes
 * `remote:<room>:<sourceId>`; sources of own rooms are not stocks (harvest flow).
 * @param {object} roomObservation
 * @param {string[]} [missing] collects missing-field paths
 * @returns {Array<object>}
 */
function classifyEnergyNodes(roomObservation, missing) {
    const room = roomObservation;
    const roomName = room.roomName;
    const nodes = [];
    const structures = room.structures || [];
    for (let i = 0; i < structures.length; i++) {
        const s = structures[i];
        const type = s.objectType;
        const nodeClass = (type === 'spawn' || type === 'extension') ? 'SPAWN_EXTENSION' : 'STORAGE_CONTAINER';
        nodes.push({
            nodeId: String(s.id), nodeClass: nodeClass, objectType: type, roomName: roomName, pos: pos(s.pos),
            amount: meas(s.energy, 'energyNodes.' + s.id + '.amount', missing),
            capacity: meas(s.capacity, 'energyNodes.' + s.id + '.capacity', missing),
        });
    }
    const creeps = room.creeps || [];
    for (let i = 0; i < creeps.length; i++) {
        const c = creeps[i];
        if (c.spawning) continue;
        nodes.push({
            nodeId: 'creep:' + c.name, nodeClass: 'CARGO', objectType: 'creep', roomName: roomName, pos: pos(c.pos),
            amount: meas(c.energy, 'energyNodes.creep:' + c.name + '.amount', missing),
            capacity: meas(c.capacity, 'energyNodes.creep:' + c.name + '.capacity', missing),
        });
    }
    const piles = room.piles || [];
    for (let i = 0; i < piles.length; i++) {
        const p = piles[i];
        nodes.push({
            nodeId: String(p.id), nodeClass: 'PILE', objectType: p.objectType, roomName: roomName, pos: pos(p.pos),
            amount: meas(p.energy, 'energyNodes.' + p.id + '.amount', missing),
            capacity: unknownMeasure(ReasonCode.MISSING_FIELD), // not applicable to piles; not a missing observation
        });
    }
    const ownedRoom = !!(room.controller && room.controller.my === true);
    if (!ownedRoom) {
        const sources = room.sources || [];
        for (let i = 0; i < sources.length; i++) {
            const s = sources[i];
            nodes.push({
                nodeId: 'remote:' + roomName + ':' + s.id, nodeClass: 'REMOTE', objectType: 'remote', roomName: roomName, pos: pos(s.pos),
                amount: meas(s.energy, 'energyNodes.remote:' + roomName + ':' + s.id + '.amount', missing),
                capacity: meas(s.energyCapacity, 'energyNodes.remote:' + roomName + ':' + s.id + '.capacity', missing),
            });
        }
    }
    return sortedUnique(nodes, 'nodeId');
}

function ownRoom(room) {
    return !!(room.controller && room.controller.my === true);
}

function buildEventLog(room, tick) {
    const base = { effectTick: tick - 1, observedAt: tick };
    if (!room.visible) return Object.assign(base, { status: 'NOT_VISIBLE', rawLength: null, rawFingerprint: null, entries: null });
    const raw = room.eventLog ? room.eventLog.raw : null;
    const unavailable = Object.assign({}, base, { status: 'UNAVAILABLE', rawLength: null, rawFingerprint: null, entries: null });
    if (!Array.isArray(raw)) return unavailable;
    const entries = [];
    for (let i = 0; i < raw.length; i++) {
        const e = raw[i];
        if (!e || typeof e !== 'object' || !isNonNegInt(e.event)) return unavailable;
        let data = null;
        if (e.data !== undefined && e.data !== null) {
            try { data = canonicalClone(e.data); } catch (error) { return unavailable; }
            if (data === null || typeof data !== 'object' || Array.isArray(data)) data = data === null ? null : { value: data };
        }
        entries.push({ originalArrayIndex: i, event: e.event, objectId: typeof e.objectId === 'string' && e.objectId !== '' ? e.objectId : null, data: data });
    }
    return Object.assign(base, { status: 'CAPTURED', rawLength: raw.length, rawFingerprint: fingerprint(entries), entries: entries });
}

/**
 * @param {object} roomObservation
 * @returns {object} RoomSnapshot (not frozen; buildSnapshot freezes the whole graph)
 */
function buildRoomSnapshot(roomObservation) {
    const room = roomObservation;
    const tick = room.tick;
    const missing = [];
    const empty = {
        roomName: room.roomName, tick: tick, visibility: 'NOT_VISIBLE', controller: null,
        energyAvailable: unknownMeasure(ReasonCode.NO_VISIBILITY), energyCapacityAvailable: unknownMeasure(ReasonCode.NO_VISIBILITY),
        energyNodes: [], spawns: [], sources: [], hostiles: [], constructionSites: [],
        eventLog: buildEventLog(room, tick), missingFields: [],
    };
    if (!room.visible) return empty;

    let controller = null;
    const c = room.controller;
    if (c) {
        const p = 'controller.';
        const ownerName = typeof c.ownerName === 'string' && c.ownerName !== '' ? c.ownerName : null;
        const owned = c.my === true || ownerName !== null; // progress/downgrade exist only for owned controllers
        controller = {
            id: String(c.id), my: c.my === true, ownerName: ownerName,
            reservationOwner: typeof c.reservationOwner === 'string' && c.reservationOwner !== '' ? c.reservationOwner : null,
            level: Math.min(8, intOr(c.level, 0, p + 'level', missing)),
            progress: measOrNotApplicable(c.progress, owned, p + 'progress', missing),
            progressTotal: measOrNotApplicable(c.progressTotal, owned, p + 'progressTotal', missing),
            ticksToDowngrade: measOrNotApplicable(c.ticksToDowngrade, owned, p + 'ticksToDowngrade', missing),
            // engine API: Controller.safeMode is undefined when safe mode is inactive
            safeModeTicks: c.safeModeTicks === undefined || c.safeModeTicks === null ? measured(0) : meas(c.safeModeTicks, p + 'safeModeTicks', missing),
        };
    }

    const spawns = [];
    const spawnList = room.spawns || [];
    for (let i = 0; i < spawnList.length; i++) {
        const s = spawnList[i];
        const sp = pos(s.pos);
        if (!sp) { missing.push('spawns.' + s.id + '.pos'); continue; }
        const st = s.spawning;
        let spawning = null;
        if (st) {
            const sp0 = 'spawns.' + s.id + '.spawning.';
            // never let a missing remainingTime look like a finished spawn: fall back to "not finished" (>= 1) and flag it
            const needOk = isNonNegInt(st.needTime);
            const remOk = isNonNegInt(st.remainingTime);
            const needTime = needOk ? st.needTime : intOr(undefined, Math.max(1, remOk ? st.remainingTime : 1), sp0 + 'needTime', missing);
            const remainingTime = remOk ? st.remainingTime : intOr(undefined, Math.max(1, needTime), sp0 + 'remainingTime', missing);
            spawning = { name: String(st.name), needTime: needTime, remainingTime: remainingTime };
        }
        spawns.push({ id: String(s.id), name: String(s.name), roomName: room.roomName, pos: sp, spawning: spawning });
    }
    const sources = [];
    const sourceList = room.sources || [];
    for (let i = 0; i < sourceList.length; i++) {
        const s = sourceList[i];
        const sp = pos(s.pos);
        if (!sp) { missing.push('sources.' + s.id + '.pos'); continue; }
        sources.push({
            id: String(s.id), pos: sp,
            energy: meas(s.energy, 'sources.' + s.id + '.energy', missing),
            energyCapacity: meas(s.energyCapacity, 'sources.' + s.id + '.energyCapacity', missing),
            // undefined while the source is not regenerating (energy known): not applicable, not missing
            ticksToRegeneration: measOrNotApplicable(s.ticksToRegeneration, !isNum(s.energy), 'sources.' + s.id + '.ticksToRegeneration', missing),
        });
    }
    const hostiles = [];
    const hostileList = room.hostiles || [];
    for (let i = 0; i < hostileList.length; i++) {
        const h = hostileList[i];
        const hp = pos(h.pos);
        if (!hp) { missing.push('hostiles.' + h.id + '.pos'); continue; }
        hostiles.push({
            id: String(h.id), ownerName: typeof h.ownerName === 'string' && h.ownerName !== '' ? h.ownerName : null, pos: hp,
            body: bodyParts(h.body, 'hostiles.' + h.id + '.body', missing),
            hits: intOr(h.hits, 0, 'hostiles.' + h.id + '.hits', missing), hitsMax: intOr(h.hitsMax, 0, 'hostiles.' + h.id + '.hitsMax', missing),
        });
    }
    const sites = [];
    const siteList = room.constructionSites || [];
    for (let i = 0; i < siteList.length; i++) {
        const s = siteList[i];
        const sp = pos(s.pos);
        if (!sp) { missing.push('constructionSites.' + s.id + '.pos'); continue; }
        sites.push({ id: String(s.id), structureType: String(s.structureType), pos: sp, my: s.my === true,
            progress: intOr(s.progress, 0, 'constructionSites.' + s.id + '.progress', missing), progressTotal: intOr(s.progressTotal, 0, 'constructionSites.' + s.id + '.progressTotal', missing) });
    }

    const snapshot = {
        roomName: room.roomName, tick: tick, visibility: 'VISIBLE', controller: controller,
        // energyAvailable exists only in rooms with an owned controller
        energyAvailable: measOrNotApplicable(room.energyAvailable, ownRoom(room), 'energyAvailable', missing),
        energyCapacityAvailable: measOrNotApplicable(room.energyCapacityAvailable, ownRoom(room), 'energyCapacityAvailable', missing),
        energyNodes: classifyEnergyNodes(room, missing),
        spawns: sortedUnique(spawns, 'id'), sources: sortedUnique(sources, 'id'), hostiles: sortedUnique(hostiles, 'id'),
        constructionSites: sortedUnique(sites, 'id'),
        eventLog: buildEventLog(room, tick),
        missingFields: [],
    };
    snapshot.missingFields = sortedStrings(missing);
    return snapshot;
}

function buildCreep(c, missing) {
    const p = 'ownCreeps.' + c.name + '.';
    const roomName = isRoomName(c.roomName) ? c.roomName : null;
    let ticksToLive;
    if (isNum(c.ticksToLive)) ticksToLive = measured(c.ticksToLive);
    else {
        ticksToLive = unknownMeasure(ReasonCode.MISSING_FIELD);
        if (!c.spawning) missing.push(p + 'ticksToLive'); // spawning creeps have no TTL yet: expected
    }
    return {
        name: String(c.name), id: typeof c.id === 'string' && c.id !== '' ? c.id : null, roomName: roomName, pos: pos(c.pos),
        spawning: c.spawning === true, body: bodyParts(c.body, p + 'body', missing), ticksToLive: ticksToLive,
        store: { energy: meas(c.energy, p + 'store.energy', missing), capacity: meas(c.capacity, p + 'store.capacity', missing) },
        legacyRole: typeof c.legacyRole === 'string' && c.legacyRole !== '' ? c.legacyRole : null,
        strategyEnvelope: null,
    };
}

/**
 * @param {object} observation internal plain format (see file header)
 * @returns {object} deep-frozen Snapshot with fingerprint
 */
function buildSnapshot(observation) {
    const missing = [];
    const cpu = observation.cpu || {};
    // cpu is self-describing Measured and excluded from the fingerprint, so its gaps are not in missingFields
    const cpuMeasured = {};
    const fields = ['used', 'limit', 'tickLimit', 'bucket'];
    for (let i = 0; i < fields.length; i++) cpuMeasured[fields[i]] = meas(cpu[fields[i]], 'cpu.' + fields[i], null);

    const rooms = {};
    const names = Object.keys(observation.rooms || {}).sort();
    for (let i = 0; i < names.length; i++) {
        const r = buildRoomSnapshot(observation.rooms[names[i]]);
        rooms[names[i]] = r;
        for (let j = 0; j < r.missingFields.length; j++) missing.push('rooms.' + names[i] + '.' + r.missingFields[j]);
    }
    const ownCreeps = {};
    const creepList = (observation.creeps || []).slice().sort(byId('name'));
    for (let i = 0; i < creepList.length; i++) {
        const name = creepList[i].name;
        if (Object.prototype.hasOwnProperty.call(ownCreeps, name)) continue;
        ownCreeps[name] = buildCreep(creepList[i], missing);
    }
    const snapshot = {
        dtoType: 'Snapshot', contractVersion: CONTRACT_VERSION, tick: observation.tick,
        shard: typeof observation.shard === 'string' && observation.shard !== '' ? observation.shard : null,
        captureStage: observation.captureStage || 'FULL',
        cpu: cpuMeasured, rooms: rooms, ownCreeps: ownCreeps, missingFields: sortedStrings(missing),
        fingerprint: 'fnv1a64:0000000000000000',
    };
    snapshot.fingerprint = snapshotFingerprint(snapshot);
    return deepFreeze(snapshot);
}

module.exports = { buildSnapshot, buildRoomSnapshot, classifyEnergyNodes };
