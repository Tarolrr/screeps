// ScreepsReader (A1, contract A.2 §10): the only component that reads the world.
//
//   createReader({gameRead, cpu}) -> { capture(tick, scope, observationBudget) -> Result<Snapshot> }
//   scope = {rooms: string[] | 'ALL_VISIBLE', stage: 'FULL'}
//
// Strictly read-only:
//   - only GameReadPort calls (time, roomNames, room, creepNames, creep, eventLog) plus
//     read-only getters on the raw objects it returns (room.find, store.getUsedCapacity/
//     getCapacity); no intents, no assignments;
//   - NEVER touches `creep.memory` (that getter auto-creates Memory.creeps[name]).
//     Legacy role is read only through the optional `gameRead.creepMemory(name)` hook
//     (a port method that must read Memory.creeps[name] without creating it); absent
//     hook => legacyRole null. the creation envelope (`strategy`) is copied from the same port read (A.4);
//   - raw objects never leave this module: everything is copied into plain data
//     and converted by WorldSnapshotBuilder (deep-frozen Snapshot).
// Budget: `observationBudget.admit({name, budgetClass:'optional', estimateCpu, cursor})`
// before the creeps block and before every visible room. A non-READY answer is returned
// unchanged (DEFERRED(cursor, BUDGET_DEFERRED) / UNKNOWN(MISSING_FIELD, ...)): there is no
// partial snapshot; cursor.deferredRooms lists rooms not captured, and the tick without
// a snapshot is an observation gap for A3 (never zero flows).
// Stateless: no heap cache between ticks.

const { READY, REJECTED } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { validateSnapshot } = require('../domain/dtos');
const { buildSnapshot } = require('./WorldSnapshotBuilder');

// Numeric FIND_* constants (values are part of the Screeps API); not read from globals.
const FIND = Object.freeze({
    HOSTILE_CREEPS: 103, SOURCES: 105, DROPPED_RESOURCES: 106, STRUCTURES: 107, CONSTRUCTION_SITES: 111,
    MY_SPAWNS: 112, TOMBSTONES: 118, RUINS: 123,
});
// lab/powerSpawn/nuker omitted (not part of the energy contour in stage A); tower included since contract A.3 (see REPLAY.md)
const ENERGY_STRUCTURES = Object.freeze({ spawn: true, extension: true, storage: true, container: true, link: true, terminal: true, tower: true });
// uncalibrated estimates; A6 measures the real cost
const ESTIMATE_ROOM_CPU = 0.3;
const ESTIMATE_CREEP_CPU = 0.02;

function plainPos(p) {
    if (!p || typeof p !== 'object') return null;
    return { roomName: p.roomName, x: p.x, y: p.y };
}

function list(room, type) {
    const found = room.find(type);
    return Array.isArray(found) ? found : [];
}

function ownerName(object) {
    const owner = object ? object.owner : null;
    return owner && typeof owner.username === 'string' ? owner.username : null;
}

/** @returns {{energy: (number|null), capacity: (number|null)}} */
function readStore(object) {
    const store = object ? object.store : null;
    if (!store || typeof store !== 'object') return { energy: null, capacity: null };
    let energy = null;
    if (typeof store.getUsedCapacity === 'function') energy = store.getUsedCapacity('energy');
    else if (typeof store.energy === 'number') energy = store.energy;
    let capacity = null;
    if (typeof store.getCapacity === 'function') capacity = store.getCapacity('energy');
    return { energy: typeof energy === 'number' ? energy : null, capacity: typeof capacity === 'number' ? capacity : null };
}

function copyBody(body) {
    const out = [];
    if (!Array.isArray(body)) return out;
    for (let i = 0; i < body.length; i++) out.push({ type: body[i].type, boost: body[i].boost === undefined ? null : body[i].boost, hits: body[i].hits });
    return out;
}

function readController(c) {
    if (!c) return null;
    return {
        id: c.id, my: c.my === true, ownerName: ownerName(c),
        reservationOwner: c.reservation && typeof c.reservation.username === 'string' ? c.reservation.username : null,
        level: c.level, progress: c.progress, progressTotal: c.progressTotal, ticksToDowngrade: c.ticksToDowngrade, safeModeTicks: c.safeMode,
    };
}

function readRoom(room, name, tick, eventRaw) {
    const structures = [];
    const all = list(room, FIND.STRUCTURES);
    for (let i = 0; i < all.length; i++) {
        const s = all[i];
        if (!ENERGY_STRUCTURES[s.structureType] || s.my === false) continue;
        const st = readStore(s);
        structures.push({ id: s.id, objectType: s.structureType, pos: plainPos(s.pos), energy: st.energy, capacity: st.capacity });
    }
    const spawns = list(room, FIND.MY_SPAWNS).map(function (s) {
        const sp = s.spawning;
        return {
            id: s.id, name: s.name, pos: plainPos(s.pos),
            spawning: sp ? { name: sp.name, needTime: sp.needTime, remainingTime: sp.remainingTime } : null,
        };
    });
    const sources = list(room, FIND.SOURCES).map(function (s) {
        return { id: s.id, pos: plainPos(s.pos), energy: s.energy, energyCapacity: s.energyCapacity, ticksToRegeneration: s.ticksToRegeneration };
    });
    const hostiles = list(room, FIND.HOSTILE_CREEPS).map(function (h) {
        return { id: h.id, ownerName: ownerName(h), pos: plainPos(h.pos), body: copyBody(h.body), hits: h.hits, hitsMax: h.hitsMax };
    });
    const sites = list(room, FIND.CONSTRUCTION_SITES).map(function (s) {
        return { id: s.id, structureType: s.structureType, pos: plainPos(s.pos), my: s.my === true, progress: s.progress, progressTotal: s.progressTotal };
    });
    const piles = [];
    const dropped = list(room, FIND.DROPPED_RESOURCES);
    for (let i = 0; i < dropped.length; i++) {
        if (dropped[i].resourceType === 'energy') piles.push({ id: dropped[i].id, objectType: 'resource', pos: plainPos(dropped[i].pos), energy: dropped[i].amount });
    }
    const graves = [{ type: 'tombstone', items: list(room, FIND.TOMBSTONES) }, { type: 'ruin', items: list(room, FIND.RUINS) }];
    for (let g = 0; g < graves.length; g++) {
        for (let i = 0; i < graves[g].items.length; i++) {
            const item = graves[g].items[i];
            const st = readStore(item);
            if (st.energy === 0) continue; // nothing to account for
            piles.push({ id: item.id, objectType: graves[g].type, pos: plainPos(item.pos), energy: st.energy });
        }
    }
    return {
        roomName: name, tick: tick, visible: true,
        eventLog: { raw: eventRaw },
        controller: readController(room.controller),
        energyAvailable: room.energyAvailable, energyCapacityAvailable: room.energyCapacityAvailable,
        structures: structures, spawns: spawns, sources: sources, hostiles: hostiles, constructionSites: sites, piles: piles,
        creeps: [],
    };
}

function readCreep(gameRead, name) {
    const c = gameRead.creep(name);
    if (!c) return null;
    let legacyRole = null;
    let strategyEnvelope = null;
    if (typeof gameRead.creepMemory === 'function') {
        const mem = gameRead.creepMemory(name);
        if (mem && typeof mem === 'object' && typeof mem.role === 'string') legacyRole = mem.role;
        // creation envelope copy (A.4); validated again by the builder, null when absent/malformed
        if (mem && typeof mem === 'object' && mem.strategy && typeof mem.strategy === 'object') strategyEnvelope = mem.strategy;
    }
    const st = readStore(c);
    return {
        name: name, id: c.id, roomName: c.room && typeof c.room.name === 'string' ? c.room.name : null, pos: plainPos(c.pos),
        spawning: c.spawning === true, body: copyBody(c.body), ticksToLive: c.ticksToLive,
        energy: st.energy, capacity: st.capacity, legacyRole: legacyRole, strategyEnvelope: strategyEnvelope,
    };
}

/**
 * @param {{gameRead: object, cpu: {read: function(): object}}} deps
 */
function createReader(deps) {
    const gameRead = deps.gameRead;
    const cpuPort = deps.cpu;
    if (!gameRead || !cpuPort) throw new TypeError('createReader needs {gameRead, cpu}');

    function admit(budget, block) {
        if (!budget || typeof budget.admit !== 'function') return null;
        const answer = budget.admit({ name: block.name, budgetClass: 'optional', estimateCpu: block.estimateCpu, cursor: block.cursor });
        return answer && answer.kind !== 'READY' ? answer : null;
    }

    /**
     * @param {number} tick
     * @param {{rooms: (string[]|'ALL_VISIBLE'), stage: string}} scope
     * @param {{admit: function(object): object}} observationBudget
     */
    function capture(tick, scope, observationBudget) {
        if (!Number.isInteger(tick) || tick < 0) return REJECTED(ReasonCode.STALE_INPUT, { tick: null, gameTime: null });
        if (!scope || scope.stage !== 'FULL') return REJECTED(ReasonCode.UNSUPPORTED_CAPABILITY, { stage: scope ? String(scope.stage) : null });
        const gameTime = gameRead.time();
        if (gameTime !== tick) return REJECTED(ReasonCode.STALE_INPUT, { tick: tick, gameTime: gameTime });

        let wanted;
        if (scope.rooms === 'ALL_VISIBLE') wanted = gameRead.roomNames().slice();
        else if (Array.isArray(scope.rooms)) wanted = scope.rooms.slice().sort().filter(function (n, i, a) { return i === 0 || a[i - 1] !== n; });
        else return REJECTED(ReasonCode.INVALID_RECORD, { field: 'scope.rooms' });

        const creepNames = gameRead.creepNames();
        const progress = { tick: tick, deferredRooms: wanted.slice(), capturedRooms: [], block: 'creeps' };

        const creepStop = admit(observationBudget, { name: 'observe.creeps', estimateCpu: ESTIMATE_CREEP_CPU * creepNames.length, cursor: progress });
        if (creepStop) return creepStop;
        const creeps = [];
        for (let i = 0; i < creepNames.length; i++) {
            const c = readCreep(gameRead, creepNames[i]);
            if (c) creeps.push(c);
        }

        const rooms = {};
        for (let i = 0; i < wanted.length; i++) {
            const name = wanted[i];
            const room = gameRead.room(name);
            if (!room) {
                rooms[name] = { roomName: name, tick: tick, visible: false, eventLog: null, creeps: [] };
                progress.capturedRooms.push(name);
                progress.deferredRooms = wanted.slice(i + 1);
                continue;
            }
            const cursor = { tick: tick, deferredRooms: wanted.slice(i), capturedRooms: progress.capturedRooms.slice(), block: 'room' };
            const stop = admit(observationBudget, { name: 'observe.room.' + name, estimateCpu: ESTIMATE_ROOM_CPU, cursor: cursor });
            if (stop) return stop;
            const eventRaw = gameRead.eventLog(name);
            const obs = readRoom(room, name, tick, eventRaw);
            obs.creeps = creeps.filter(function (c) { return c.roomName === name; });
            rooms[name] = obs;
            progress.capturedRooms.push(name);
            progress.deferredRooms = wanted.slice(i + 1);
        }

        const observation = {
            tick: tick, shard: gameRead.shardName(), captureStage: 'FULL',
            cpu: cpuPort.read(), rooms: rooms, creeps: creeps,
        };
        const snapshot = buildSnapshot(observation);
        const check = validateSnapshot(snapshot, { checkFingerprint: true });
        if (!check.ok) return REJECTED(ReasonCode.INVALID_RECORD, { errors: check.errors.slice(0, 5) });
        return READY(snapshot, snapshot.fingerprint);
    }

    return Object.freeze({ capture: capture });
}

module.exports = { createReader, FIND };
