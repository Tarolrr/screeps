// Runtime ports of contract A.2 (docs/strategy/CONTRACTS-A.md §5).
//
// Ports are the ONLY place where new code touches Screeps globals. They are
// created lazily from accessor functions (never read Game/Memory at require
// time). Distribution rule:
//   - ClockPort, CpuPort, LogPort: any app component (values only);
//   - GameReadPort: Reader (A1) only; read-only calls on Game;
//   - MemoryPort: StateStore (A2) only, one port per strategy namespace;
//   - Gateway (intents): does not exist in stage A.
// Pure layers (domain, models, planning, scheduling calculations) receive values,
// never ports.

const STRATEGY_NAMESPACES = Object.freeze(['strategy', 'strategyShadow', 'strategyMigration']);

/** Methods of Game/Room objects the GameReadPort may call (read-only). */
const READ_ONLY_GAME_CALLS = Object.freeze(['cpu.getUsed', 'cpu.getHeapStatistics', 'getObjectById', 'room.getEventLog', 'room.getTerrain', 'room.find', 'room.lookAt', 'room.lookForAt', 'room.lookForAtArea', 'map.describeExits', 'map.getRoomTerrain', 'map.getRoomStatus']);

function finiteOrNull(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
}

/**
 * @param {function(): *} getGame returns the current Game global (or undefined)
 * @returns {{tick: function(): (number|null)}}
 */
function createClockPort(getGame) {
    return Object.freeze({
        tick: function () {
            const game = getGame();
            const time = game ? game.time : undefined;
            return typeof time === 'number' && Number.isInteger(time) && time >= 0 ? time : null;
        },
    });
}

/**
 * @typedef {Object} CpuReading
 * @property {number|null} used Game.cpu.getUsed()
 * @property {number|null} limit Game.cpu.limit
 * @property {number|null} tickLimit Game.cpu.tickLimit
 * @property {number|null} bucket Game.cpu.bucket
 * @property {string[]} missingFields sorted names of fields that are null
 */

/**
 * @param {function(): *} getGame
 * @returns {{read: function(): CpuReading}}
 */
function createCpuPort(getGame) {
    return Object.freeze({
        read: function () {
            const game = getGame();
            const cpu = game && game.cpu ? game.cpu : null;
            let used = null;
            if (cpu && typeof cpu.getUsed === 'function') {
                try { used = finiteOrNull(cpu.getUsed()); } catch (error) { used = null; }
            }
            const reading = {
                bucket: cpu ? finiteOrNull(cpu.bucket) : null,
                limit: cpu ? finiteOrNull(cpu.limit) : null,
                tickLimit: cpu ? finiteOrNull(cpu.tickLimit) : null,
                used: used,
                missingFields: [],
            };
            const names = ['bucket', 'limit', 'tickLimit', 'used'];
            for (let i = 0; i < names.length; i++) if (reading[names[i]] === null) reading.missingFields.push('cpu.' + names[i]);
            return reading;
        },
    });
}

/**
 * Read-only access to Game for the Reader (A1). Returns raw engine objects;
 * the Reader must copy values into DTOs and never call mutating methods or
 * keep references beyond the tick. No other component receives this port.
 * @param {function(): *} getGame
 */
function createGameReadPort(getGame) {
    function game() {
        const g = getGame();
        if (!g) throw new Error('Game is not available');
        return g;
    }
    function sortedKeys(object) {
        return object ? Object.keys(object).sort() : [];
    }
    function roomByName(name) {
        const rooms = game().rooms;
        return rooms && Object.prototype.hasOwnProperty.call(rooms, name) ? rooms[name] : null;
    }
    return Object.freeze({
        /** @returns {number|null} */
        time: function () { const t = game().time; return typeof t === 'number' ? t : null; },
        /** @returns {string|null} */
        shardName: function () { const s = game().shard; return s && typeof s.name === 'string' ? s.name : null; },
        /** @returns {string[]} visible room names, sorted */
        roomNames: function () { return sortedKeys(game().rooms); },
        /** @returns {*} raw Room or null when not visible */
        room: roomByName,
        /** @returns {string[]} own creep names (incl. spawning), sorted */
        creepNames: function () { return sortedKeys(game().creeps); },
        creep: function (name) { const creeps = game().creeps; return creeps && Object.prototype.hasOwnProperty.call(creeps, name) ? creeps[name] : null; },
        /** @returns {string[]} own spawn names, sorted */
        spawnNames: function () { return sortedKeys(game().spawns); },
        spawn: function (name) { const spawns = game().spawns; return spawns && Object.prototype.hasOwnProperty.call(spawns, name) ? spawns[name] : null; },
        getObjectById: function (id) { const g = game(); return typeof g.getObjectById === 'function' ? g.getObjectById(id) : null; },
        /** @returns {Array|null} raw event log array (unfiltered) or null when unavailable */
        eventLog: function (roomName) {
            const room = roomByName(roomName);
            if (!room || typeof room.getEventLog !== 'function') return null;
            const log = room.getEventLog();
            return Array.isArray(log) ? log : null;
        },
        /** Read-only call list for documentation/tests. */
        allowedCalls: READ_ONLY_GAME_CALLS,
    });
}

/**
 * Namespaced Memory port. Only StateStore (A2) receives MemoryPorts; legacy
 * namespaces (resourceManager, creeps, rooms, spawns, flags, loggerState, ...)
 * can never be addressed.
 * @param {function(): *} getMemory returns the Memory global
 * @param {string} namespace one of STRATEGY_NAMESPACES
 */
function createMemoryPort(getMemory, namespace) {
    if (STRATEGY_NAMESPACES.indexOf(namespace) === -1) throw new TypeError('MemoryPort namespace not allowed: ' + String(namespace));
    function memory() {
        const m = getMemory();
        if (!m || typeof m !== 'object') throw new Error('Memory is not available');
        return m;
    }
    return Object.freeze({
        namespace: namespace,
        /** @returns {*} raw namespace value (untrusted, validate before use) or undefined */
        read: function () { return memory()[namespace]; },
        /** Replace the namespace root. Value must be JSON data built by StateCodec. */
        write: function (value) {
            if (value === undefined) throw new TypeError('MemoryPort.write(undefined) is not allowed; use remove()');
            memory()[namespace] = value;
        },
        remove: function () { delete memory()[namespace]; },
    });
}

/**
 * Structured log port. Lines are prefixed '[strategy]' and capped per tick so
 * a fault loop cannot flood the console.
 * @param {{sink?: function(string): void, maxLinesPerTick?: number}} [options]
 */
function createLogPort(options) {
    const sink = options && options.sink ? options.sink : function (line) { if (typeof console !== 'undefined') console.log(line); };
    const maxLines = options && options.maxLinesPerTick !== undefined ? options.maxLinesPerTick : 20;
    let written = 0;
    let suppressed = 0;
    function emit(level, code, fields) {
        if (written >= maxLines) { suppressed++; return; }
        written++;
        let text = '[strategy] ' + level + ' ' + code;
        if (fields !== undefined) {
            try { text += ' ' + JSON.stringify(fields); } catch (error) { text += ' <unserializable>'; }
        }
        sink(text);
    }
    return Object.freeze({
        debug: function (code, fields) { emit('DEBUG', code, fields); },
        info: function (code, fields) { emit('INFO', code, fields); },
        warn: function (code, fields) { emit('WARN', code, fields); },
        error: function (code, fields) { emit('ERROR', code, fields); },
        /** Called by TickRunner at tick start. */
        beginTick: function () {
            if (suppressed > 0) sink('[strategy] WARN LOG_SUPPRESSED {"lines":' + suppressed + '}');
            written = 0;
            suppressed = 0;
        },
    });
}

/**
 * Resolve the Screeps globals lazily. Kept in one place so that tests can
 * substitute them and so that require() never reads them.
 * @param {{getGame?: function(): *, getMemory?: function(): *, sink?: function(string): void}} [overrides]
 */
function createRuntimePorts(overrides) {
    const o = overrides || {};
    /* global Game, Memory */
    const getGame = o.getGame || function () { return typeof Game !== 'undefined' ? Game : undefined; };
    const getMemory = o.getMemory || function () { return typeof Memory !== 'undefined' ? Memory : undefined; };
    const memory = {};
    for (let i = 0; i < STRATEGY_NAMESPACES.length; i++) memory[STRATEGY_NAMESPACES[i]] = createMemoryPort(getMemory, STRATEGY_NAMESPACES[i]);
    return Object.freeze({
        clock: createClockPort(getGame),
        cpu: createCpuPort(getGame),
        gameRead: createGameReadPort(getGame),
        memory: Object.freeze(memory),
        log: createLogPort({ sink: o.sink }),
    });
}

module.exports = {
    STRATEGY_NAMESPACES,
    READ_ONLY_GAME_CALLS,
    createClockPort,
    createCpuPort,
    createGameReadPort,
    createMemoryPort,
    createLogPort,
    createRuntimePorts,
};
