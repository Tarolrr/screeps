// Runtime ports of contract A.2 (docs/strategy/CONTRACTS-A.md §5).
//
// Ports are the ONLY place where new code touches Screeps globals. They are
// created lazily from accessor functions (never read Game/Memory at require
// time). Distribution rule:
//   - ClockPort, CpuPort, LogPort: any app component (values only);
//   - GameReadPort: Reader (A1) only; read-only calls on Game;
//   - MemoryPort: StateStore (A2) only, one port per strategy namespace;
//   - Gateway (intents): does not exist in stage A.
//   - VisualPort, ConsolePort, OperatorFlagReader (contract A.5): presenter only
//     (present.shadow); RoomVisual drawing is not a game intent, console lines are
//     operator output, the flag reader only reads Memory.strategyView (copy);
//   - OperatorCommandPort + CommandHost (contract A.5): console commands `strat.*` only
//     (installed by stageA.js on the first loop); writes ONLY Memory.strategyView and
//     Memory.strategyShadow.exportRequest (operator paths), each value validated.
// Pure layers (domain, models, planning, scheduling calculations) receive values,
// never ports.

const STRATEGY_NAMESPACES = Object.freeze(['strategy', 'strategyShadow', 'strategyMigration']);

const { validateStrategyView, LAYOUT_SCHEMAS, STRATEGY_VIEW_NAMESPACE } = require('../domain/stateLayout');
const { validate } = require('../domain/schema');
const { isRoomName } = require('../domain/keys');

/** Operator view flags larger than this (JSON chars) are treated as invalid (never parsed into the tick). */
const MAX_VIEW_FLAGS_CHARS = 8192;
/** Shapes the VisualPort forwards to RoomVisual. */
const VISUAL_SHAPES = Object.freeze(['text', 'rect', 'line', 'circle', 'poly']);
/** Longest console line the ConsolePort forwards (characters). */
const MAX_CONSOLE_LINE = 600;

/** Methods of Game/Room objects the GameReadPort may call (read-only). */
const READ_ONLY_GAME_CALLS = Object.freeze(['cpu.getUsed', 'cpu.getHeapStatistics', 'getObjectById', 'room.getEventLog', 'room.getTerrain', 'room.find', 'room.lookAt', 'room.lookForAt', 'room.lookForAtArea', 'map.describeExits', 'map.getRoomTerrain', 'map.getRoomStatus', 'store.getUsedCapacity', 'store.getCapacity', 'store.getFreeCapacity']);

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
function createGameReadPort(getGame, getMemory) {
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
        /**
         * Read-only copy of selected legacy creep memory fields (contract A.3).
         * Reads Memory.creeps[name] directly (never the creep.memory getter, which
         * auto-creates entries); returns null when absent. Never writes Memory.
         * @returns {{role: string|null, strategy: {operationKey: string|null, homeRoom: string|null, ownerEpoch: number|null}|null}|null}
         */
        creepMemory: function (name) {
            const m = typeof getMemory === 'function' ? getMemory() : undefined;
            const creeps = m && Object.prototype.hasOwnProperty.call(m, 'creeps') ? m.creeps : null;
            if (!creeps || typeof creeps !== 'object' || !Object.prototype.hasOwnProperty.call(creeps, name)) return null;
            const entry = creeps[name];
            if (!entry || typeof entry !== 'object') return null;
            const env = entry.strategy && typeof entry.strategy === 'object' ? entry.strategy : null;
            return {
                role: typeof entry.role === 'string' ? entry.role : null,
                strategy: env ? {
                    operationKey: typeof env.operationKey === 'string' ? env.operationKey : null,
                    homeRoom: typeof env.homeRoom === 'string' ? env.homeRoom : null,
                    ownerEpoch: Number.isInteger(env.ownerEpoch) ? env.ownerEpoch : null,
                } : null,
            };
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
 * VisualPort (contract A.5): per-room drawing over `new RoomVisual(roomName)`. Drawing is
 * not a game intent (it only fills the tick's visual buffer). One RoomVisual per room and
 * game tick is reused. Shapes: text(room, text, x, y, style), rect(room, x, y, w, h, style),
 * line(room, x1, y1, x2, y2, style), circle(room, x, y, style), poly(room, points, style).
 * No-op (returns false) when RoomVisual is not available.
 * @param {function(): (function|undefined)} getRoomVisual returns the RoomVisual constructor
 * @param {function(): *} [getGame] for the per-tick cache key
 */
function createVisualPort(getRoomVisual, getGame) {
    let cacheTick = null;
    let cache = {};
    function visualOf(roomName) {
        const RV = getRoomVisual();
        if (typeof RV !== 'function' || !isRoomName(roomName)) return null;
        const game = getGame ? getGame() : undefined;
        const t = game && typeof game.time === 'number' ? game.time : null;
        if (t === null || t !== cacheTick) { cacheTick = t; cache = {}; }
        if (!Object.prototype.hasOwnProperty.call(cache, roomName)) cache[roomName] = new RV(roomName);
        return cache[roomName];
    }
    function shape(name) {
        return function (roomName) {
            const v = visualOf(roomName);
            if (v === null || typeof v[name] !== 'function') return false;
            v[name].apply(v, Array.prototype.slice.call(arguments, 1));
            return true;
        };
    }
    const port = { available: function () { return typeof getRoomVisual() === 'function'; } };
    for (let i = 0; i < VISUAL_SHAPES.length; i++) port[VISUAL_SHAPES[i]] = shape(VISUAL_SHAPES[i]);
    return Object.freeze(port);
}

/**
 * ConsolePort (contract A.5): operator console lines (HTML colour allowed), no '[strategy]'
 * prefix; lines are cut at MAX_CONSOLE_LINE. Rate limiting is the presenter's job.
 * @param {function(string): void} [sink]
 */
function createConsolePort(sink) {
    const out = sink || function (line) { if (typeof console !== 'undefined') console.log(line); };
    return Object.freeze({
        log: function (line) { out(String(line).slice(0, MAX_CONSOLE_LINE)); },
    });
}

/**
 * OperatorFlagReader (contract A.5): read-only accessor of Memory.strategyView. Returns a
 * JSON copy (the caller can never mutate Memory through it), `undefined` when absent, or
 * {invalid: code} when it cannot be copied or is larger than MAX_VIEW_FLAGS_CHARS. Never writes.
 * @param {function(): *} getMemory
 */
function createOperatorFlagReader(getMemory) {
    return Object.freeze({
        namespace: STRATEGY_VIEW_NAMESPACE,
        read: function () {
            const m = getMemory();
            if (!m || typeof m !== 'object' || !Object.prototype.hasOwnProperty.call(m, STRATEGY_VIEW_NAMESPACE)) return undefined;
            let text;
            try { text = JSON.stringify(m[STRATEGY_VIEW_NAMESPACE]); } catch (error) { return { invalid: 'UNSERIALIZABLE' }; }
            if (text === undefined) return undefined;
            if (text.length > MAX_VIEW_FLAGS_CHARS) return { invalid: 'TOO_LARGE' };
            return JSON.parse(text);
        },
    });
}

/**
 * OperatorCommandPort (contract A.5): the ONLY writers of the two operator paths, used by
 * the console commands (strat.visual / strat.export), never by a component.
 *   setOverlay(room, on) -> {ok, value} | {ok:false, error}   writes Memory.strategyView
 *   requestExport(request) -> {ok, value} | {ok:false, error}  writes Memory.strategyShadow.exportRequest
 *   readFlags() -> copy of Memory.strategyView (or undefined)
 * Values are validated (StrategyView / ExportRequest schemas) before the write; an invalid
 * existing Memory.strategyView is replaced by a fresh valid object; exportRequest is only
 * written into an existing Memory.strategyShadow object (StateStore owns its creation).
 * @param {function(): *} getMemory
 */
function createOperatorCommandPort(getMemory) {
    const flags = createOperatorFlagReader(getMemory);
    function memory() {
        const m = getMemory();
        if (!m || typeof m !== 'object') throw new Error('Memory is not available');
        return m;
    }
    return Object.freeze({
        readFlags: flags.read,
        setOverlay: function (roomName, on) {
            if (!isRoomName(roomName)) return { ok: false, error: 'BAD_ROOM_NAME' };
            if (typeof on !== 'boolean') return { ok: false, error: 'EXPECTED_BOOLEAN' };
            const current = flags.read();
            const base = current !== undefined && validateStrategyView(current).ok ? current : {};
            const next = { rooms: Object.assign({}, base.rooms || {}) };
            next.rooms[roomName] = { overlay: on };
            if (typeof base.console === 'boolean') next.console = base.console;
            const v = validateStrategyView(next);
            if (!v.ok) return { ok: false, error: v.errors[0].code };
            memory()[STRATEGY_VIEW_NAMESPACE] = next;
            return { ok: true, value: next };
        },
        requestExport: function (request) {
            const v = validate(LAYOUT_SCHEMAS.ExportRequest, request);
            if (!v.ok) return { ok: false, error: v.errors[0].code };
            const m = memory();
            const shadow = m.strategyShadow;
            if (!shadow || typeof shadow !== 'object' || Array.isArray(shadow)) return { ok: false, error: 'NO_SHADOW_STATE' };
            shadow.exportRequest = { requested: request.requested, ticks: request.ticks === undefined ? null : request.ticks, tickFrom: request.tickFrom === undefined ? null : request.tickFrom };
            return { ok: true, value: shadow.exportRequest };
        },
    });
}

/**
 * CommandHost (contract A.5): installs the operator console API on the global object
 * (`global.strat`). Called by the composition root on the first loop, never at require.
 * @param {function(): (object|undefined)} getGlobal
 */
function createCommandHost(getGlobal) {
    return Object.freeze({
        install: function (name, api) {
            if (name !== 'strat') throw new TypeError('CommandHost installs only `strat`');
            const g = getGlobal();
            if (!g || typeof g !== 'object') return false;
            g[name] = api;
            return true;
        },
    });
}

/**
 * Resolve the Screeps globals lazily. Kept in one place so that tests can
 * substitute them and so that require() never reads them.
 * @param {{getGame?: function(): *, getMemory?: function(): *, sink?: function(string): void,
 *          getRoomVisual?: function(): *, consoleSink?: function(string): void, getGlobal?: function(): *}} [overrides]
 */
function createRuntimePorts(overrides) {
    const o = overrides || {};
    /* global Game, Memory, RoomVisual, global */
    const getGame = o.getGame || function () { return typeof Game !== 'undefined' ? Game : undefined; };
    const getMemory = o.getMemory || function () { return typeof Memory !== 'undefined' ? Memory : undefined; };
    const getRoomVisual = o.getRoomVisual || function () { return typeof RoomVisual !== 'undefined' ? RoomVisual : undefined; };
    const getGlobal = o.getGlobal || function () { return typeof global !== 'undefined' ? global : typeof globalThis !== 'undefined' ? globalThis : undefined; };
    const memory = {};
    for (let i = 0; i < STRATEGY_NAMESPACES.length; i++) memory[STRATEGY_NAMESPACES[i]] = createMemoryPort(getMemory, STRATEGY_NAMESPACES[i]);
    return Object.freeze({
        clock: createClockPort(getGame),
        cpu: createCpuPort(getGame),
        gameRead: createGameReadPort(getGame, getMemory),
        memory: Object.freeze(memory),
        log: createLogPort({ sink: o.sink }),
        // contract A.5 (presenter / console commands only, see the header)
        visual: createVisualPort(getRoomVisual, getGame),
        console: createConsolePort(o.consoleSink),
        operatorFlags: createOperatorFlagReader(getMemory),
        operator: createOperatorCommandPort(getMemory),
        commands: createCommandHost(getGlobal),
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
    createVisualPort,
    createConsolePort,
    createOperatorFlagReader,
    createOperatorCommandPort,
    createCommandHost,
    createRuntimePorts,
    VISUAL_SHAPES,
    MAX_VIEW_FLAGS_CHARS,
};
