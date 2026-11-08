// Load dist2/mapPatch.js into the current Node process (tests of pure modules
// must also pass with the legacy prototype patch active, because the bundle
// runs next to it). Returns a restore() that puts the native functions back.
//
// Node --test runs every test file in its own process, so installing the patch
// in one file does not leak into others.

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const MAP_PATCH_FILE = path.resolve(__dirname, '../../../dist2/mapPatch.js');

/**
 * Evaluate dist2/mapPatch.js in sloppy mode against this realm's globals.
 * @returns {function(): void} restore
 */
function installMapPatch() {
    const saved = {
        flat: Array.prototype.flat,
        fromObject: Object.getOwnPropertyDescriptor(Map, 'fromObject'),
        toObject: Object.getOwnPropertyDescriptor(Map.prototype, 'toObject'),
        filter: Object.getOwnPropertyDescriptor(Map.prototype, 'filter'),
        hadResult: Object.prototype.hasOwnProperty.call(globalThis, 'result'),
    };
    // runInThisContext keeps sloppy mode and this realm's prototypes.
    vm.runInThisContext(fs.readFileSync(MAP_PATCH_FILE, 'utf8'), { filename: MAP_PATCH_FILE });
    return function restore() {
        Array.prototype.flat = saved.flat; // eslint-disable-line no-extend-native
        for (const [owner, key, desc] of [[Map, 'fromObject', saved.fromObject], [Map.prototype, 'toObject', saved.toObject], [Map.prototype, 'filter', saved.filter]]) {
            if (desc) Object.defineProperty(owner, key, desc); else delete owner[key];
        }
        if (!saved.hadResult) delete globalThis.result;
    };
}

/** @returns {boolean} true when the dist2 patch is active in this realm */
function isMapPatchActive() {
    return typeof Map.prototype.toObject === 'function' && typeof Map.fromObject === 'function';
}

module.exports = { MAP_PATCH_FILE, installMapPatch, isMapPatchActive };
