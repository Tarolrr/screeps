// Prototype-safe helpers for persisted plain data (A2 internal).
//
// Record keys come from Memory (JSON.parse creates an OWN `__proto__` property
// when the text contains that key) and from StatePatch paths. Plain `obj[key]`
// reads/writes would then touch the prototype instead of data, so every read
// of untrusted data uses own-property descriptors and every write uses
// Object.defineProperty. Keys in FORBIDDEN_KEYS are rejected before writing.

/** Same list as domain/stateLayout.js (not exported there). */
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const hasOwn = Object.prototype.hasOwnProperty;

/** @returns {boolean} true when `key` is an own property of `object` */
function has(object, key) {
    return object !== null && typeof object === 'object' && hasOwn.call(object, key);
}

/** Own-property read (never walks the prototype chain). */
function own(object, key) {
    if (!has(object, key)) return undefined;
    const d = Object.getOwnPropertyDescriptor(object, key);
    return d ? d.value : undefined;
}

/** Own data-property define (never invokes a setter, never sets a prototype). */
function put(object, key, value) {
    Object.defineProperty(object, key, { value: value, enumerable: true, writable: true, configurable: true });
    return value;
}

function isForbiddenKey(key) {
    return FORBIDDEN_KEYS.indexOf(key) !== -1;
}

/**
 * First forbidden key found anywhere in a JSON value, as a path, or null.
 * @param {*} value
 * @returns {string|null}
 */
function findForbiddenKey(value) {
    const stack = [{ v: value, p: '$' }];
    while (stack.length > 0) {
        const item = stack.pop();
        const v = item.v;
        if (v === null || typeof v !== 'object') continue;
        const keys = Object.keys(v);
        for (let i = 0; i < keys.length; i++) {
            if (!Array.isArray(v) && isForbiddenKey(keys[i])) return item.p + '/' + keys[i];
            stack.push({ v: own(v, keys[i]), p: item.p + '/' + keys[i] });
        }
    }
    return null;
}

/** Shallow own-property copy of a plain object or array. */
function shallowCopy(value) {
    if (Array.isArray(value)) return value.slice();
    const out = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) put(out, keys[i], own(value, keys[i]));
    return out;
}

/** Deep copy of JSON data (input must be JSON-safe; JSON.parse defines own properties). */
function jsonClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = { FORBIDDEN_KEYS, has, own, put, isForbiddenKey, findForbiddenKey, shallowCopy, jsonClone };
