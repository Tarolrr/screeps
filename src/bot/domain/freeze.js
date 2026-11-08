// deepFreeze for plain data (snapshots, DTOs handed to pure layers).
// Only plain objects and arrays are traversed; the function refuses to freeze
// Game-like objects (non-plain prototypes) because freezing a runtime object
// would change engine-owned state.

const { isPlainObject } = require('./canonical');

function collect(value, seen, out) {
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    if (!Array.isArray(value) && !isPlainObject(value)) {
        throw new TypeError('deepFreeze accepts only plain objects and arrays');
    }
    seen.add(value);
    out.push(value);
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) collect(value[keys[i]], seen, out);
}

/**
 * Recursively freezes plain objects/arrays in place and returns the same value.
 * Two passes: the whole graph is validated first, so a non-plain object
 * anywhere causes a TypeError and NOTHING is frozen (no partial freeze).
 * Cycles are tolerated. Already frozen nodes are traversed (their children may
 * not be frozen).
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
    const nodes = [];
    collect(value, new Set(), nodes);
    for (let i = 0; i < nodes.length; i++) Object.freeze(nodes[i]);
    return value;
}

module.exports = { deepFreeze };
