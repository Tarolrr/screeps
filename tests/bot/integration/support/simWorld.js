// Deterministic simulated Screeps world for STRAT-A5 integration tests.
//
// state(T) --step()--> state(T+1); Game(T+1).getEventLog() returns the events of that
// step (effectTick T), so snapshots and event logs are mutually consistent (no
// unexplained balance): harvest is income, transfers between own nodes are internal,
// upgrade spends energySpent, a legacy spawn spends the body cost.
//
// game() builds a fresh trap Game (like the engine builds one per tick): every
// non-read-only method call and every set/define/delete on Game objects is journaled
// as a violation; reading `creep.memory` (the getter that auto-creates
// Memory.creeps[name]) is journaled in `memoryGetterReads`.

const { createTrapGame } = require('../../support/trapRuntime');

const COST = { move: 50, work: 100, carry: 50, attack: 80, ranged_attack: 150, tough: 10, heal: 250, claim: 600 };
const ROOM = 'W1N1';

function store(energy, capacity) {
    const s = { energy: energy };
    Object.defineProperty(s, 'getUsedCapacity', { value: function () { return energy; }, enumerable: false, configurable: true });
    Object.defineProperty(s, 'getCapacity', { value: function () { return capacity; }, enumerable: false, configurable: true });
    Object.defineProperty(s, 'getFreeCapacity', { value: function () { return capacity - energy; }, enumerable: false, configurable: true });
    return s;
}

function P(x, y) { return { roomName: ROOM, x: x, y: y }; }

function bodyCost(body) { return body.reduce(function (s, p) { return s + COST[p]; }, 0); }

/**
 * @param {{time?: number, spawnAt?: {tick:number, name:string, role:string, body:string[]},
 *          hostiles?: function(number): Array, cpu?: function(number): object, ttl?: object,
 *          eventLog?: function(number): ('normal'|'missing'|'garbage')}} [options]
 */
function createSim(options) {
    const o = options || {};
    const st = {
        time: o.time === undefined ? 1000 : o.time,
        controller: { id: 'ctrl1', progress: 0 },
        spawn: { id: 'spawn1', name: 'Spawn1', pos: P(25, 25), energy: 300, cap: 300, spawning: null },
        exts: [{ id: 'ext1', pos: P(26, 25), energy: 50, cap: 50 }, { id: 'ext2', pos: P(27, 25), energy: 50, cap: 50 }],
        sources: [{ id: 'src1', pos: P(10, 10), energy: 3000 }, { id: 'src2', pos: P(40, 40), energy: 3000 }],
        creeps: [
            { name: 'h1', id: 'c_h1', role: 'harvester', body: ['work', 'work', 'carry', 'move'], pos: P(11, 10), energy: 0, cap: 50, ttl: (o.ttl && o.ttl.h1) || 1200, spawning: false },
            { name: 'm1', id: 'c_m1', role: 'mule', body: ['carry', 'carry', 'move', 'move'], pos: P(24, 25), energy: 0, cap: 100, ttl: (o.ttl && o.ttl.m1) || 1100, spawning: false },
            { name: 'u1', id: 'c_u1', role: 'upgrader', body: ['work', 'carry', 'move'], pos: P(30, 30), energy: 20, cap: 50, ttl: (o.ttl && o.ttl.u1) || 1000, spawning: false },
        ],
        tombs: [],
        events: [],
    };
    const memoryGetterReads = [];

    function creep(name) { return st.creeps.filter(function (c) { return c.name === name; })[0] || null; }

    function step() {
        const ev = [];
        const sp = st.spawn;
        const m1 = creep('m1');
        const h1 = creep('h1');
        const u1 = creep('u1');
        // mule delivers first (spawn, then extensions)
        if (m1 && !m1.spawning && m1.energy > 0) {
            const targets = [sp].concat(st.exts);
            for (let i = 0; i < targets.length; i++) {
                const t = targets[i];
                const amt = Math.min(m1.energy, t.cap - t.energy);
                if (amt <= 0) continue;
                ev.push({ event: 12, objectId: m1.id, data: { targetId: t.id, amount: amt, resourceType: 'energy' } });
                m1.energy -= amt; t.energy += amt;
                break;
            }
        }
        if (h1 && !h1.spawning) {
            if (h1.energy + 4 <= h1.cap) {
                ev.push({ event: 5, objectId: h1.id, data: { targetId: 'src1', amount: 4 } });
                h1.energy += 4; st.sources[0].energy -= 4;
            } else if (m1 && !m1.spawning && m1.energy < m1.cap) {
                const amt = Math.min(h1.energy, m1.cap - m1.energy);
                ev.push({ event: 12, objectId: h1.id, data: { targetId: m1.id, amount: amt, resourceType: 'energy' } });
                h1.energy -= amt; m1.energy += amt;
            }
        }
        if (u1 && !u1.spawning) {
            if (u1.energy > 0) {
                ev.push({ event: 9, objectId: u1.id, data: { amount: 1, energySpent: 1 } });
                u1.energy -= 1; st.controller.progress += 1;
            } else if (sp.energy >= 250 && !sp.spawning) {
                ev.push({ event: 12, objectId: sp.id, data: { targetId: u1.id, amount: 50, resourceType: 'energy' } });
                sp.energy -= 50; u1.energy += 50;
            }
        }
        // legacy spawning progress / new spawn
        if (sp.spawning) {
            sp.spawning.remainingTime -= 1;
            if (sp.spawning.remainingTime <= 0) {
                const c = creep(sp.spawning.name);
                c.spawning = false; c.ttl = 1500; c.pos = P(25, 26);
                sp.spawning = null;
            }
        }
        if (o.spawnAt && st.time === o.spawnAt.tick && !sp.spawning) {
            let cost = bodyCost(o.spawnAt.body);
            const pool = [sp].concat(st.exts);
            const avail = pool.reduce(function (s, n) { return s + n.energy; }, 0);
            if (avail >= cost) {
                for (let i = 0; i < pool.length && cost > 0; i++) { const take = Math.min(pool[i].energy, cost); pool[i].energy -= take; cost -= take; }
                const need = 3 * o.spawnAt.body.length;
                sp.spawning = { name: o.spawnAt.name, needTime: need, remainingTime: need };
                st.creeps.push({ name: o.spawnAt.name, id: 'c_' + o.spawnAt.name, role: o.spawnAt.role, body: o.spawnAt.body.slice(), pos: P(25, 25), energy: 0, cap: 50 * o.spawnAt.body.filter(function (p) { return p === 'carry'; }).length, ttl: null, spawning: true });
            }
        }
        for (let i = st.creeps.length - 1; i >= 0; i--) {
            const c = st.creeps[i];
            if (c.spawning) continue;
            c.ttl -= 1;
            if (c.ttl <= 0) {
                if (c.energy > 0) st.tombs.push({ id: 'tomb_' + c.name, pos: c.pos, energy: c.energy });
                st.creeps.splice(i, 1);
            }
        }
        st.events = ev;
        st.time += 1;
    }

    function creepObject(c) {
        const obj = {
            name: c.name, id: c.id, room: { name: ROOM }, pos: c.pos, spawning: c.spawning, ticksToLive: c.spawning ? undefined : c.ttl,
            body: c.body.map(function (t) { return { type: t, hits: 100 }; }), store: store(c.energy, c.cap), owner: { username: 'me' }, my: true,
            moveTo: function () { return 0; }, harvest: function () { return 0; }, transfer: function () { return 0; }, upgradeController: function () { return 0; }, say: function () { return 0; },
        };
        Object.defineProperty(obj, 'memory', { enumerable: false, get: function () {
            memoryGetterReads.push(c.name);
            // engine semantics: Memory.creeps[name], created when absent
            return api.creepMemory ? api.creepMemory(c.name) : {};
        } });
        return obj;
    }

    /** Fresh trap Game of the current tick. */
    function game(extra) {
        const sp = st.spawn;
        const hostiles = o.hostiles ? o.hostiles(st.time) : [];
        const structures = [
            { id: sp.id, structureType: 'spawn', my: true, pos: sp.pos, store: store(sp.energy, sp.cap) },
        ].concat(st.exts.map(function (e) { return { id: e.id, structureType: 'extension', my: true, pos: e.pos, store: store(e.energy, e.cap) }; }));
        const finds = {
            103: hostiles,
            105: st.sources.map(function (s) { return { id: s.id, pos: s.pos, energy: s.energy, energyCapacity: 3000, ticksToRegeneration: 300 }; }),
            106: [],
            107: structures,
            111: [],
            112: [{ id: sp.id, name: sp.name, pos: sp.pos, spawning: sp.spawning ? { name: sp.spawning.name, needTime: sp.spawning.needTime, remainingTime: sp.spawning.remainingTime } : null, spawnCreep: function () { return 0; } }],
            118: st.tombs.map(function (t) { return { id: t.id, pos: t.pos, store: store(t.energy, 0) }; }),
            123: [],
        };
        // the engine hands out event logs parsed inside the isolate: same realm as the bundle
        let events = api.realm ? api.realm(st.events) : st.events.slice();
        const logMode = o.eventLog ? o.eventLog(st.time) : 'normal';
        if (logMode === 'missing') events = undefined;              // getEventLog unavailable
        else if (logMode === 'garbage') events = api.realm ? api.realm([{ event: 'bogus' }]) : [{ event: 'bogus' }]; // malformed entry
        const room = {
            name: ROOM,
            controller: { id: 'ctrl1', pos: P(25, 40), my: true, owner: { username: 'me' }, level: 2, progress: st.controller.progress, progressTotal: 45000, ticksToDowngrade: 10000 },
            energyAvailable: sp.energy + st.exts.reduce(function (s, e) { return s + e.energy; }, 0),
            energyCapacityAvailable: sp.cap + st.exts.reduce(function (s, e) { return s + e.cap; }, 0),
            find: function (type) { return (finds[type] || []).slice(); },
            getEventLog: function () { return events; },
            createConstructionSite: function () { return 0; },
            // read-only helpers real dist2 uses (plain terrain, nothing at positions)
            getTerrain: function () { return { get: function () { return 0; } }; },
            lookForAt: function () { return []; },
            lookAt: function () { return []; },
            lookForAtArea: function () { return []; },
        };
        const creeps = {};
        st.creeps.slice().sort(function (a, b) { return a.name < b.name ? -1 : 1; }).forEach(function (c) { creeps[c.name] = creepObject(c); });
        const cpu = o.cpu ? o.cpu(st.time) : { used: 1, limit: 20, tickLimit: 500, bucket: 10000 };
        const byId = {};
        [finds[105], finds[107], finds[112], [room.controller]].forEach(function (list) { list.forEach(function (x) { byId[x.id] = x; }); });
        for (const n in creeps) byId[creeps[n].id] = creeps[n];
        return createTrapGame({ time: st.time, rooms: { W1N1: room }, creeps: creeps, getObjectById: function (id) { return byId[id] || null; }, spawns: { Spawn1: { name: 'Spawn1', id: sp.id, room: { name: ROOM }, spawnCreep: function () { return 0; } } }, cpu: cpu }, Object.assign({ mode: 'record' }, extra || {}));
    }

    const api = {
        /** function(value) -> copy in the sandbox realm (set by the artifact harness) */
        realm: null,
        /** function(name) -> Memory.creeps[name] (engine getter semantics; set by the harness) */
        creepMemory: null,
        state: st,
        step: step,
        game: game,
        memoryGetterReads: memoryGetterReads,
        get time() { return st.time; },
        legacyCreepMemory: function () {
            const out = {};
            st.creeps.forEach(function (c) { out[c.name] = { role: c.role }; });
            return out;
        },
    };
    return api;
}

module.exports = { createSim, ROOM, bodyCost };
