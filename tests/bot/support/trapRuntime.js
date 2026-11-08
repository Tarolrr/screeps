// Trap proxies for Game and Memory used by unit and loader tests.
//
// createTrapGame(spec): a fake Game whose every property read and method call
// is journaled. Only read-only methods (READ_ONLY_METHODS) may be called; any
// other method call (spawnCreep, moveTo, transfer, createConstructionSite,
// notify, ...) and any assignment/delete on Game objects is a violation that
// throws (mode 'throw', default) or is only journaled (mode 'record').
//
// createTrapMemory(initial, {allowedRootKeys}): a fake Memory whose reads and
// writes are journaled with their path. Writes under a root key that is not in
// allowedRootKeys are violations (throw or record). Pass allowedRootKeys: '*'
// to allow everything and only count writes (legacy loop tests).

const READ_ONLY_METHODS = Object.freeze(['getUsed', 'getHeapStatistics', 'getObjectById', 'getEventLog', 'getTerrain', 'find', 'lookAt', 'lookForAt', 'lookForAtArea', 'describeExits', 'getRoomTerrain', 'getRoomStatus', 'getUsedCapacity', 'getCapacity', 'getFreeCapacity', 'get', 'getRangeTo', 'inRangeTo', 'isEqualTo', 'isNearTo', 'findClosestByRange', 'findInRange', 'hasOwnProperty', 'toString', 'valueOf', 'toJSON']);

class TrapViolation extends Error {
    constructor(kind, where) {
        super('Trap violation: ' + kind + ' ' + where);
        this.name = 'TrapViolation';
        this.kind = kind;
        this.where = where;
    }
}

function isWrappable(value) {
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return true;
    const proto = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null; // plain object of any realm
}

function newJournal() {
    return { reads: [], calls: [], writes: [], violations: [] };
}

/**
 * @param {Object} [spec] plain description: {time, cpu:{used, limit, tickLimit, bucket}, rooms, creeps, spawns, shard}
 * @param {{mode?: 'throw'|'record', allowedMethods?: string[]}} [options]
 */
function createTrapGame(spec, options) {
    const mode = (options && options.mode) || 'throw';
    const allowed = READ_ONLY_METHODS.concat((options && options.allowedMethods) || []);
    const journal = newJournal();
    const s = spec || {};
    const cpuSpec = s.cpu || { used: 1, limit: 20, tickLimit: 500, bucket: 10000 };
    const base = {
        time: s.time === undefined ? 100 : s.time,
        shard: s.shard || { name: 'shard0', type: 'normal', ptr: false },
        cpu: {
            limit: cpuSpec.limit,
            tickLimit: cpuSpec.tickLimit,
            bucket: cpuSpec.bucket,
            getUsed: typeof cpuSpec.used === 'function' ? cpuSpec.used : function () { return cpuSpec.used; },
        },
        rooms: s.rooms || {},
        creeps: s.creeps || {},
        spawns: s.spawns || {},
        structures: s.structures || {},
        constructionSites: s.constructionSites || {},
        flags: s.flags || {},
        gcl: s.gcl || { level: 1, progress: 0, progressTotal: 1000000 },
        getObjectById: s.getObjectById || function () { return null; },
        notify: function () { return 0; },
        map: s.map || {},
        market: s.market || {},
    };
    if (cpuSpec.limit === undefined) delete base.cpu.limit;
    if (cpuSpec.tickLimit === undefined) delete base.cpu.tickLimit;
    if (cpuSpec.bucket === undefined) delete base.cpu.bucket;
    if (cpuSpec.used === undefined) delete base.cpu.getUsed;

    const proxies = new WeakMap();
    function violation(kind, where) {
        journal.violations.push({ kind: kind, where: where });
        if (mode === 'throw') throw new TrapViolation(kind, where);
    }
    function wrap(target, where) {
        if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return target;
        if (proxies.has(target)) return proxies.get(target);
        const proxy = new Proxy(target, {
            get: function (t, key, receiver) {
                const value = Reflect.get(t, key, receiver);
                if (typeof key === 'symbol') return value;
                const childWhere = where + '.' + String(key);
                journal.reads.push(childWhere);
                if (typeof value === 'function') {
                    return function () {
                        journal.calls.push(childWhere);
                        if (allowed.indexOf(String(key)) === -1) violation('call', childWhere);
                        return value.apply(t, arguments);
                    };
                }
                return wrap(value, childWhere);
            },
            set: function (t, key, value) {
                violation('set', where + '.' + String(key));
                t[key] = value;
                return true;
            },
            defineProperty: function (t, key, descriptor) {
                violation('defineProperty', where + '.' + String(key));
                return Reflect.defineProperty(t, key, descriptor);
            },
            deleteProperty: function (t, key) {
                violation('delete', where + '.' + String(key));
                return Reflect.deleteProperty(t, key);
            },
        });
        proxies.set(target, proxy);
        return proxy;
    }
    return { Game: wrap(base, 'Game'), journal: journal, raw: base };
}

/**
 * @param {Object} [initial] initial Memory content (deep-copied)
 * @param {{allowedRootKeys?: (string[]|'*'), mode?: 'throw'|'record'}} [options]
 */
function createTrapMemory(initial, options) {
    const allowedRoot = options && options.allowedRootKeys !== undefined ? options.allowedRootKeys : [];
    const mode = (options && options.mode) || 'throw';
    const journal = newJournal();
    const data = initial === undefined ? {} : JSON.parse(JSON.stringify(initial));
    const proxies = new WeakMap();

    function rootOf(where) {
        const parts = where.split('.');
        return parts.length > 1 ? parts[1] : null;
    }
    function checkWrite(kind, where) {
        journal.writes.push({ kind: kind, where: where });
        const root = rootOf(where);
        if (allowedRoot !== '*' && allowedRoot.indexOf(root) === -1) {
            journal.violations.push({ kind: kind, where: where });
            if (mode === 'throw') throw new TrapViolation(kind, where);
        }
    }
    function wrap(target, where) {
        if (!isWrappable(target)) return target;
        if (proxies.has(target)) return proxies.get(target);
        const proxy = new Proxy(target, {
            get: function (t, key, receiver) {
                const value = Reflect.get(t, key, receiver);
                if (typeof key === 'symbol') return value;
                journal.reads.push(where + '.' + String(key));
                return wrap(value, where + '.' + String(key));
            },
            set: function (t, key, value) {
                checkWrite('set', where + '.' + String(key));
                t[key] = value;
                return true;
            },
            defineProperty: function (t, key, descriptor) {
                checkWrite('defineProperty', where + '.' + String(key));
                return Reflect.defineProperty(t, key, descriptor);
            },
            deleteProperty: function (t, key) {
                checkWrite('delete', where + '.' + String(key));
                return Reflect.deleteProperty(t, key);
            },
        });
        proxies.set(target, proxy);
        return proxy;
    }
    return {
        Memory: wrap(data, 'Memory'),
        journal: journal,
        raw: data,
        /** JSON snapshot of the current content (what the runtime would serialize). */
        serialize: function () { return JSON.stringify(data); },
    };
}

module.exports = { READ_ONLY_METHODS, TrapViolation, createTrapGame, createTrapMemory };
