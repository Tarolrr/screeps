// Canonical JSON: deterministic serialization of plain data.
//
// Accepted values: null, boolean, finite number, string, Array (dense) and
// plain objects (prototype Object.prototype or null). Object keys are emitted in
// sorted (UTF-16 code unit) order, arrays keep their order. Everything else is
// rejected with a CanonicalError: undefined (also as an object property value or
// array hole, extra non-index property on an array), NaN, +/-Infinity,
// functions, symbols, bigint, cycles and objects
// with any other prototype (Map, Set, Date, class instances, Game objects,
// RoomPosition...). -0 is emitted as 0, like JSON.stringify.
//
// Pure module: no Game/Memory/global access. Does not use Array.prototype.flat
// or Map patches (dist2/mapPatch.js replaces them globally).

class CanonicalError extends Error {
    /**
     * @param {string} code machine readable code
     * @param {string} path JSON-pointer-like path of the offending value
     */
    constructor(code, path) {
        super(code + ' at ' + (path || '$'));
        this.name = 'CanonicalError';
        this.code = code;
        this.path = path || '$';
    }
}

const OBJECT_PROTO = Object.prototype;

/**
 * True for objects whose prototype is Object.prototype or null.
 * Arrays, Maps, class instances, Game objects are not plain.
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === OBJECT_PROTO || proto === null;
}

/**
 * Classify a value for canonical serialization; returns an error code or null.
 * @param {*} value
 * @returns {string|null}
 */
function scalarProblem(value) {
    switch (typeof value) {
        case 'undefined': return 'UNDEFINED';
        case 'function': return 'FUNCTION';
        case 'symbol': return 'SYMBOL';
        case 'bigint': return 'BIGINT';
        case 'number':
            if (value !== value) return 'NAN';
            if (value === Infinity || value === -Infinity) return 'INFINITY';
            return null;
        default: return null;
    }
}

function childPath(path, key) {
    return path + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * @param {*} value
 * @param {string} path
 * @param {Array<object>} stack objects currently being serialized (cycle detection)
 * @returns {string}
 */
function encode(value, path, stack) {
    if (value === null) return 'null';
    const problem = scalarProblem(value);
    if (problem !== null) throw new CanonicalError(problem, path);
    const type = typeof value;
    if (type === 'boolean') return value ? 'true' : 'false';
    if (type === 'number') return value === 0 ? '0' : JSON.stringify(value);
    if (type === 'string') return JSON.stringify(value);
    // object
    if (stack.indexOf(value) !== -1) throw new CanonicalError('CYCLE', path);
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) throw new CanonicalError('NON_PLAIN_PROTOTYPE', path);
        if (Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length > 0) {
            // holes or extra (non-index) properties would be silently lost by JSON
            for (let i = 0; i < value.length; i++) if (!(i in value)) throw new CanonicalError('ARRAY_HOLE', childPath(path, i));
            throw new CanonicalError('ARRAY_EXTRA_PROPERTY', path);
        }
        stack.push(value);
        const parts = new Array(value.length);
        for (let i = 0; i < value.length; i++) {
            if (!(i in value)) throw new CanonicalError('ARRAY_HOLE', childPath(path, i));
            parts[i] = encode(value[i], childPath(path, i), stack);
        }
        stack.pop();
        return '[' + parts.join(',') + ']';
    }
    if (!isPlainObject(value)) throw new CanonicalError('NON_PLAIN_PROTOTYPE', path);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new CanonicalError('SYMBOL_KEY', path);
    stack.push(value);
    const keys = Object.keys(value).sort();
    const parts = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        parts[i] = JSON.stringify(key) + ':' + encode(value[key], childPath(path, key), stack);
    }
    stack.pop();
    return '{' + parts.join(',') + '}';
}

/**
 * Deterministic JSON text of a plain JSON-safe value.
 * @param {*} value
 * @returns {string}
 * @throws {CanonicalError}
 */
function canonicalJson(value) {
    return encode(value, '', []);
}

/**
 * Non-throwing JSON-safety check.
 * @param {*} value
 * @returns {{ok: true} | {ok: false, code: string, path: string}}
 */
function checkJsonSafe(value) {
    try {
        encode(value, '', []);
        return { ok: true };
    } catch (error) {
        if (error instanceof CanonicalError) return { ok: false, code: error.code, path: error.path };
        throw error;
    }
}

/**
 * @param {*} value
 * @returns {boolean}
 */
function isJsonSafe(value) {
    return checkJsonSafe(value).ok;
}

/**
 * Deep copy through canonical form (sorted keys). Rejects what canonicalJson rejects.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function canonicalClone(value) {
    return JSON.parse(canonicalJson(value));
}

module.exports = {
    CanonicalError,
    isPlainObject,
    canonicalJson,
    checkJsonSafe,
    isJsonSafe,
    canonicalClone,
};
