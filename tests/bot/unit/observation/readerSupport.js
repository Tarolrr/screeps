// Fake Game world for Reader tests: trap Game + guarded engine-like objects.
// Every object returned by room.find / game maps is wrapped by guard(): calling any
// method other than the read-only store getters, assigning, defining or deleting a
// property, and reading `.memory` are violations.

const { createTrapGame, createTrapMemory, TrapViolation } = require('../../support/trapRuntime');
const { createRuntimePorts } = require('../../../../src/bot/app/ports');

const STORE_GETTERS = ['getUsedCapacity', 'getCapacity'];
const violations = [];

function guard(obj, label) {
    if (obj === null || typeof obj !== 'object') return obj;
    return new Proxy(obj, {
        get: function (t, key, receiver) {
            if (typeof key === 'symbol') return Reflect.get(t, key, receiver);
            if (key === 'memory') { violations.push('memory read ' + label); throw new TrapViolation('memory', label); }
            const v = Reflect.get(t, key, receiver);
            if (typeof v === 'function') {
                return function () {
                    if (STORE_GETTERS.indexOf(String(key)) === -1) { violations.push('call ' + label + '.' + String(key)); throw new TrapViolation('call', label + '.' + String(key)); }
                    return v.apply(t, arguments);
                };
            }
            return guard(v, label + '.' + String(key));
        },
        set: function (t, key) { violations.push('set ' + label + '.' + String(key)); throw new TrapViolation('set', label + '.' + String(key)); },
        defineProperty: function (t, key) { violations.push('define ' + label + '.' + String(key)); throw new TrapViolation('define', label); },
        deleteProperty: function (t, key) { violations.push('delete ' + label + '.' + String(key)); throw new TrapViolation('delete', label); },
    });
}

function store(energy, capacity) {
    const s = { energy: energy };
    Object.defineProperty(s, 'getUsedCapacity', { value: function () { return energy; }, enumerable: false, configurable: true });
    Object.defineProperty(s, 'getCapacity', { value: function () { return capacity; }, enumerable: false, configurable: true });
    return s;
}

function P(room, x, y) { return { roomName: room, x: x, y: y }; }

function maybeReverse(list, permute) { return permute ? list.slice().reverse() : list; }

/**
 * @param {{permute?: boolean, time?: number, hideCpu?: boolean, gap?: boolean, own?: object}} [opts]
 * permute reverses every collection and key insertion order (same world).
 */
function makeWorld(opts) {
    const o = opts || {};
    const permute = !!o.permute;
    const memory = createTrapMemory({ creeps: { h1: { role: 'harvester', home: 'W1N1' } }, rooms: {} }, { allowedRootKeys: [] });
    const creepData = [
        { name: 'h1', id: 'c1', room: 'W1N1', pos: P('W1N1', 10, 10), energy: 50, cap: 50, ttl: 1200 },
        { name: 'h2', id: 'c2', room: 'W1N1', pos: P('W1N1', 11, 10), energy: 0, cap: 50, ttl: 900 },
        { name: 'far', id: 'c3', room: 'W2N2', pos: P('W2N2', 3, 3), energy: 20, cap: 50, ttl: 400 },
    ];
    function creepObj(d) {
        const c = {
            name: d.name, id: d.id, room: { name: d.room }, pos: d.pos, spawning: false, ticksToLive: d.ttl,
            body: [{ type: 'work', hits: 100 }, { type: 'carry', hits: 100, boost: 'KH' }, { type: 'move', hits: 50 }],
            store: store(d.energy, d.cap), owner: { username: 'me' },
            moveTo: function () { return 0; }, transfer: function () { return 0; },
        };
        Object.defineProperty(c, 'memory', { enumerable: true, get: function () { memory.Memory.creeps[d.name] = memory.Memory.creeps[d.name] || {}; return memory.Memory.creeps[d.name]; } });
        return c;
    }
    const spawning = { name: 'h3', id: 'c4', room: { name: 'W1N1' }, pos: P('W1N1', 20, 20), spawning: true, body: [{ type: 'move', hits: 100 }], store: store(0, 0), owner: { username: 'me' } };
    Object.defineProperty(spawning, 'memory', { enumerable: true, get: function () { memory.Memory.creeps.h3 = {}; return memory.Memory.creeps.h3; } });

    const own = {
        controller: { id: 'ctrl1', my: true, owner: { username: 'me' }, level: 3, progress: 100, progressTotal: 45000, ticksToDowngrade: 9000 },
        energyAvailable: 450, energyCapacityAvailable: 800,
        [101 + 2]: [{ id: 'hs1', owner: { username: 'enemy' }, pos: P('W1N1', 40, 40), body: [{ type: 'attack', hits: 100 }], hits: 300, hitsMax: 300 }],
        105: [{ id: 'src1', pos: P('W1N1', 5, 5), energy: 3000, energyCapacity: 3000, ticksToRegeneration: 300 }, { id: 'src0', pos: P('W1N1', 6, 6), energy: o.gap ? undefined : 10, energyCapacity: 3000 }],
        106: [{ id: 'drop1', resourceType: 'energy', amount: 77, pos: P('W1N1', 7, 7) }, { id: 'drop2', resourceType: 'power', amount: 5, pos: P('W1N1', 8, 8) }],
        107: [
            { id: 'ext1', structureType: 'extension', my: true, pos: P('W1N1', 21, 21), store: store(50, 50) },
            { id: 'ext2', structureType: 'extension', my: true, pos: P('W1N1', 22, 21), store: store(0, 50) },
            { id: 'spawn1id', structureType: 'spawn', my: true, pos: P('W1N1', 20, 20), store: store(300, 300) },
            { id: 'stor1', structureType: 'storage', my: true, pos: P('W1N1', 25, 25), store: store(1000, 1000000) },
            { id: 'cont1', structureType: 'container', pos: P('W1N1', 6, 5), store: store(200, 2000) },
            { id: 'wall1', structureType: 'constructedWall', pos: P('W1N1', 1, 1), store: undefined },
            { id: 'ext-enemy', structureType: 'extension', my: false, pos: P('W1N1', 2, 2), store: store(50, 50) },
        ],
        111: [{ id: 'site1', structureType: 'extension', my: true, pos: P('W1N1', 30, 30), progress: 10, progressTotal: 3000 }],
        112: [{ id: 'spawn1id', name: 'Spawn1', pos: P('W1N1', 20, 20), spawning: { name: 'h3', needTime: 9, remainingTime: 4 } }],
        118: [{ id: 'tomb1', pos: P('W1N1', 9, 9), store: store(30, 0) }, { id: 'tomb0', pos: P('W1N1', 9, 10), store: store(0, 0) }],
        123: [{ id: 'ruin1', pos: P('W1N1', 12, 12), store: store(15, 0) }],
    };
    const foreign = {
        controller: { id: 'ctrl2', my: false, level: 0 },
        105: [{ id: 'src2', pos: P('W2N2', 30, 30), energy: 1500, energyCapacity: 3000, ticksToRegeneration: 10 }],
    };
    function makeRoom(name, data, events) {
        return {
            name: name, controller: data.controller, energyAvailable: data.energyAvailable, energyCapacityAvailable: data.energyCapacityAvailable,
            find: function (type) { return maybeReverse(data[type] || [], permute).map(function (x) { return guard(x, name + '.find(' + type + ')'); }); },
            getEventLog: function () { return o.noEventLog === name ? undefined : events; },
            createConstructionSite: function () { return 0; },
        };
    }
    const events = [
        { event: 5, objectId: 'c1', data: { targetId: 'spawn1id', amount: 50, resourceType: 'energy' } },
        { event: 1, objectId: 'hs1', data: { targetId: 'c2', damage: 30, attackType: 1 } },
        { event: 9, data: {} },
    ];
    const rooms = permute
        ? { W2N2: makeRoom('W2N2', foreign, []), W1N1: makeRoom('W1N1', own, events) }
        : { W1N1: makeRoom('W1N1', own, events), W2N2: makeRoom('W2N2', foreign, []) };
    const creeps = {};
    const all = creepData.map(creepObj).concat([spawning]);
    for (const c of maybeReverse(all, permute)) creeps[c.name] = guard(c, 'creep.' + c.name);
    const spawnsObj = { Spawn1: guard({ name: 'Spawn1' }, 'spawn') };
    const t = createTrapGame({
        time: o.time === undefined ? 5000 : o.time, rooms: rooms, creeps: creeps, spawns: spawnsObj,
        cpu: o.hideCpu ? { used: undefined, limit: 20, tickLimit: 500, bucket: undefined } : { used: 1.25, limit: 20, tickLimit: 500, bucket: 10000 },
    }, { allowedMethods: STORE_GETTERS });
    return { Game: t.Game, journal: t.journal, memory: memory, violations: violations };
}

/** Ports over a fake Game (getGame closure), optionally with a creepMemory hook. */
function makePorts(world, extra) {
    const ports = createRuntimePorts({ getGame: function () { return world.Game; }, getMemory: function () { return world.memory.Memory; } });
    if (extra && extra.creepMemory) {
        const gr = Object.assign({}, ports.gameRead, { creepMemory: function (name) { return world.memory.raw.creeps ? world.memory.raw.creeps[name] : undefined; } });
        return { gameRead: gr, cpu: ports.cpu };
    }
    return { gameRead: ports.gameRead, cpu: ports.cpu };
}

module.exports = { makeWorld, makePorts, guard, store, TrapViolation };
