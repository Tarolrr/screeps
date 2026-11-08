// Synthetic Snapshot/StateView builders for A3 tests. Every built Snapshot is
// checked with the contract validator (not with A1 code).

const { measured, unknownMeasure, snapshotFingerprint, validateSnapshot } = require('../../../../src/bot/domain/dtos');
const { fingerprint } = require('../../../../src/bot/domain/fingerprint');
const { buildOperationKey } = require('../../../../src/bot/domain/keys');
const layout = require('../../../../src/bot/domain/stateLayout');
const { CONTRACT_VERSION } = require('../../../../src/bot/domain/version');

const ROOM = 'W5N8';
const CLASS_OF = { spawn: 'SPAWN_EXTENSION', extension: 'SPAWN_EXTENSION', storage: 'STORAGE_CONTAINER', container: 'STORAGE_CONTAINER', link: 'STORAGE_CONTAINER', terminal: 'STORAGE_CONTAINER', resource: 'PILE', tombstone: 'PILE', ruin: 'PILE', remote: 'REMOTE' };
const EV = { ATTACK: 1, BUILD: 4, HARVEST: 5, HEAL: 6, REPAIR: 7, UPGRADE: 9, TRANSFER: 12 };

function pos(x, y, room) { return { roomName: room || ROOM, x: x, y: y }; }

/** @returns EnergyNode */
function node(id, objectType, amount, x, y, room) {
    if (objectType === 'remote') id = 'remote:' + (room || ROOM) + ':' + id; // A1: remote:<room>:<sourceId>
    return { nodeId: id, nodeClass: CLASS_OF[objectType], objectType: objectType, roomName: room || ROOM, pos: pos(x || 20, y || 20, room), amount: amount === null ? unknownMeasure('MISSING_FIELD') : measured(amount), capacity: measured(1000) };
}

/**
 * @param {string} name
 * @param {object} o {id, room, x, y, energy, body: string[]|BodyPart[], spawning, envelope, role}
 */
function creep(name, o) {
    o = o || {};
    const body = (o.body || ['work', 'carry', 'move']).map(function (p) { return typeof p === 'string' ? { type: p, boost: null, hits: 100 } : p; });
    return {
        name: name, id: o.id || ('id_' + name), roomName: o.room || ROOM, pos: pos(o.x === undefined ? 10 : o.x, o.y === undefined ? 10 : o.y, o.room),
        spawning: !!o.spawning, body: body, ticksToLive: o.spawning ? unknownMeasure('MISSING_FIELD') : measured(1000),
        store: { energy: measured(o.energy || 0), capacity: measured(50) }, legacyRole: o.role === undefined ? 'harvester' : o.role,
        strategyEnvelope: o.envelope || null,
    };
}

/**
 * raw: [{i, event, objectId, data}]
 * @param {object} o {visibility, status, raw, rawLength, nodes, spawns, sources, energyAvailable}
 */
function room(tick, roomName, o) {
    o = o || {};
    const visible = o.visibility !== 'NOT_VISIBLE';
    const status = o.status || (visible ? 'CAPTURED' : 'NOT_VISIBLE');
    const entries = (o.raw || []).map(function (r) { return { originalArrayIndex: r.i, event: r.event, objectId: r.objectId === undefined ? null : r.objectId, data: r.data === undefined ? null : r.data }; });
    const rawLength = o.rawLength !== undefined ? o.rawLength : (entries.length === 0 ? 0 : Math.max.apply(null, entries.map(function (e) { return e.originalArrayIndex; })) + 1);
    const captured = status === 'CAPTURED';
    return {
        roomName: roomName, tick: tick, visibility: visible ? 'VISIBLE' : 'NOT_VISIBLE', controller: null,
        energyAvailable: visible ? measured(o.energyAvailable === undefined ? 300 : o.energyAvailable) : unknownMeasure('NO_VISIBILITY'),
        energyCapacityAvailable: visible ? measured(300) : unknownMeasure('NO_VISIBILITY'),
        energyNodes: visible ? (o.nodes || []).slice() : [],
        spawns: visible ? (o.spawns || []) : [],
        sources: visible ? (o.sources || [{ id: 'src1', pos: pos(5, 5, roomName), energy: measured(3000), energyCapacity: measured(3000), ticksToRegeneration: measured(100) }]) : [],
        hostiles: [], constructionSites: [],
        eventLog: { effectTick: tick - 1, observedAt: tick, status: status, rawLength: captured ? rawLength : null, rawFingerprint: captured ? fingerprint(o.rawFingerprintOf || entries) : null, entries: captured ? entries : null },
        missingFields: [],
    };
}

function spawnObj(id, spawningName, needTime, remaining, roomName) {
    return { id: id, name: 'Spawn_' + id, roomName: roomName || ROOM, pos: pos(20, 20, roomName), spawning: spawningName ? { name: spawningName, needTime: needTime || 9, remainingTime: remaining === undefined ? 8 : remaining } : null };
}

/**
 * @param {number} tick
 * @param {object} rooms {[room]: roomOptions}
 * @param {object[]} creeps CreepSnapshot[]; cargo nodes are added to visible rooms
 * @param {string[]} [missingFields]
 */
function snapshot(tick, rooms, creeps, missingFields) {
    const out = { dtoType: 'Snapshot', contractVersion: CONTRACT_VERSION, tick: tick, shard: 'shard0', captureStage: 'FULL', cpu: { used: measured(1), limit: measured(20), tickLimit: measured(500), bucket: measured(10000) }, rooms: {}, ownCreeps: {}, missingFields: missingFields || [], fingerprint: 'fnv1a64:0000000000000000' };
    for (const name in rooms) out.rooms[name] = room(tick, name, rooms[name]);
    (creeps || []).forEach(function (c) {
        out.ownCreeps[c.name] = c;
        const r = out.rooms[c.roomName];
        if (r && r.visibility === 'VISIBLE') r.energyNodes.push({ nodeId: 'creep:' + c.name, nodeClass: 'CARGO', objectType: 'creep', roomName: c.roomName, pos: c.pos, amount: c.store.energy, capacity: c.store.capacity });
    });
    for (const name in out.rooms) out.rooms[name].energyNodes.sort(function (a, b) { return a.nodeId < b.nodeId ? -1 : 1; });
    out.fingerprint = snapshotFingerprint(out);
    const check = validateSnapshot(out, { checkFingerprint: true });
    if (!check.ok) throw new Error('invalid test snapshot: ' + JSON.stringify(check.errors));
    return out;
}

function stateView(shadow, o) {
    o = o || {};
    const strategy = layout.emptyStrategyRoot({ buildId: 'b-0000000000000000' });
    strategy.revision = 1;
    strategy.lastClosedTick = o.lastClosedTick === undefined ? null : o.lastClosedTick;
    const view = { dtoType: 'StateView', status: 'OPEN', sessionTick: 1, blockedReason: null, quarantine: [], strategy: strategy, shadow: shadow || layout.emptyShadowRoot() };
    const check = layout.validateStateView(view);
    if (!check.ok) throw new Error('invalid test state view: ' + JSON.stringify(check.errors));
    return view;
}

/** Reference application of StatePatch[] (what A2's apply must do for these paths). */
function applyPatches(shadow, patches) {
    const root = JSON.parse(JSON.stringify(shadow || layout.emptyShadowRoot()));
    patches.forEach(function (p) {
        let obj = root;
        for (let i = 0; i < p.path.length - 1; i++) {
            const seg = p.path[i];
            if (!Object.prototype.hasOwnProperty.call(obj, seg)) obj[seg] = (i === 1 && p.path[0] === 'rooms') ? layout.emptyShadowRoom() : {};
            obj = obj[seg];
        }
        const last = p.path[p.path.length - 1];
        if (p.op === 'set') obj[last] = JSON.parse(JSON.stringify(p.value));
        else delete obj[last];
    });
    return root;
}

function opKey(action, occurrence, domain) {
    return buildOperationKey({ domain: domain || ROOM, ownerEpoch: 1, demandStableKey: ROOM + '/feeding/spawn1', generation: 1, action: action, occurrence: occurrence || '0' });
}

function operation(action, o) {
    o = o || {};
    return {
        operationKey: o.key || opKey(action, o.occurrence),
        state: o.state || 'ISSUED',
        createdAt: o.issuedAt === undefined ? 1000 : o.issuedAt,
        updatedAt: o.issuedAt === undefined ? 1000 : o.issuedAt,
        issuedAt: o.issuedAt === undefined ? 1000 : o.issuedAt,
        lastCommandId: o.commandId || 'cmd-1',
        actorRef: o.actorRef === undefined ? 'id_c1' : o.actorRef,
        targetRef: o.targetRef === undefined ? 'spawn1' : o.targetRef,
        requestedAmount: o.requested === undefined ? 50 : o.requested,
        confirmedAmount: o.confirmed || 0,
        reservationIds: [],
        lastReceipt: null,
        lastEffect: null,
        reasonCode: o.reasonCode || null,
    };
}

function receipt(op, o) {
    o = o || {};
    const threw = o.kind === 'THREW';
    return { kind: threw ? 'THREW' : 'RETURNED', commandId: op.lastCommandId, operationKey: op.operationKey, action: 'x', actorRef: op.actorRef || 'a', targetRef: null, tick: op.issuedAt, code: threw ? null : (o.code === undefined ? 0 : o.code), errorCode: threw ? 'Error' : null };
}

module.exports = { ROOM, EV, pos, node, creep, room, spawnObj, snapshot, stateView, applyPatches, opKey, operation, receipt };
