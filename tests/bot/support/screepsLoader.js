// Screeps-like module loader for tests (no engine needed).
//
// Mimics @screeps/engine src/game/game.js `requireFn` and
// @screeps/driver lib/runtime/runtime-driver.js `evalCode`:
//   - module map { name: sourceText }; require(name) strips a leading './' and
//     looks the name up in the map; no fs, no Node resolution, no nested paths;
//   - require.cache[name] = -1 while evaluating; re-entry -> "Circular reference";
//     a throwing module is removed from the cache (retried on next require);
//   - module code is evaluated in sloppy mode as
//       (function __module(module,exports){ <code>\n})(__module, __module.exports)
//     with `require`, `Game`, `Memory`, `console`, constants as globals of a
//     separate V8 context (own Object/Array/Map prototypes, like the isolate);
//   - the main loop is invoked like the engine: module.exports.loop() of 'main'.
// A new sandbox = a global reset (fresh heap, fresh require cache, same Memory).
//
// Realm caveat: objects created by the test (host realm) have a different
// Object.prototype than objects created inside the sandbox.

const vm = require('vm');
const fs = require('fs');
const path = require('path');

/** Small subset of Screeps constants used by dist2 code paths. */
const SCREEPS_CONSTANTS = Object.freeze({
    OK: 0, ERR_NOT_OWNER: -1, ERR_NO_PATH: -2, ERR_NAME_EXISTS: -3, ERR_BUSY: -4, ERR_NOT_FOUND: -5,
    ERR_NOT_ENOUGH_ENERGY: -6, ERR_NOT_ENOUGH_RESOURCES: -6, ERR_INVALID_TARGET: -7, ERR_FULL: -8,
    ERR_NOT_IN_RANGE: -9, ERR_INVALID_ARGS: -10, ERR_TIRED: -11, ERR_NO_BODYPART: -12, ERR_RCL_NOT_ENOUGH: -14,
    FIND_EXIT_TOP: 1, FIND_EXIT_RIGHT: 3, FIND_EXIT_BOTTOM: 5, FIND_EXIT_LEFT: 7, FIND_EXIT: 10,
    FIND_CREEPS: 101, FIND_MY_CREEPS: 102, FIND_HOSTILE_CREEPS: 103, FIND_SOURCES_ACTIVE: 104, FIND_SOURCES: 105,
    FIND_DROPPED_RESOURCES: 106, FIND_STRUCTURES: 107, FIND_MY_STRUCTURES: 108, FIND_HOSTILE_STRUCTURES: 109,
    FIND_FLAGS: 110, FIND_CONSTRUCTION_SITES: 111, FIND_MY_SPAWNS: 112, FIND_HOSTILE_SPAWNS: 113,
    FIND_MY_CONSTRUCTION_SITES: 114, FIND_HOSTILE_CONSTRUCTION_SITES: 115, FIND_MINERALS: 116, FIND_NUKES: 117,
    FIND_TOMBSTONES: 118, FIND_RUINS: 123,
    TOP: 1, TOP_RIGHT: 2, RIGHT: 3, BOTTOM_RIGHT: 4, BOTTOM: 5, BOTTOM_LEFT: 6, LEFT: 7, TOP_LEFT: 8,
    MOVE: 'move', WORK: 'work', CARRY: 'carry', ATTACK: 'attack', RANGED_ATTACK: 'ranged_attack', TOUGH: 'tough', HEAL: 'heal', CLAIM: 'claim',
    RESOURCE_ENERGY: 'energy',
    STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_ROAD: 'road', STRUCTURE_WALL: 'constructedWall',
    STRUCTURE_RAMPART: 'rampart', STRUCTURE_CONTAINER: 'container', STRUCTURE_STORAGE: 'storage', STRUCTURE_TOWER: 'tower',
    STRUCTURE_CONTROLLER: 'controller', STRUCTURE_LINK: 'link',
    LOOK_CREEPS: 'creep', LOOK_ENERGY: 'energy', LOOK_RESOURCES: 'resource', LOOK_SOURCES: 'source', LOOK_STRUCTURES: 'structure',
    LOOK_CONSTRUCTION_SITES: 'constructionSite', LOOK_TERRAIN: 'terrain',
    TERRAIN_MASK_WALL: 1, TERRAIN_MASK_SWAMP: 2,
    BODYPART_COST: Object.freeze({ move: 50, work: 100, attack: 80, carry: 50, heal: 250, ranged_attack: 150, tough: 10, claim: 600 }),
});

/**
 * @param {Object} options
 * @param {Object<string,string>} options.modules Screeps module map name -> source text
 * @param {*} [options.Game]
 * @param {*} [options.Memory]
 * @param {{log: function(...*): void}} [options.console] defaults to a collecting console
 * @param {Object<string,*>} [options.globals] extra globals
 */
function createScreepsSandbox(options) {
    const modules = Object.assign({}, options.modules);
    const consoleLines = [];
    const fakeConsole = options.console || { log: function () { consoleLines.push(Array.prototype.join.call(arguments, ' ')); } };
    const sandbox = Object.assign({}, SCREEPS_CONSTANTS, options.globals || {});
    sandbox.console = fakeConsole;
    sandbox.Game = options.Game;
    sandbox.Memory = options.Memory;
    const context = vm.createContext(sandbox);

    const cache = {};
    function requireFn(moduleName) {
        const name = String(moduleName).replace(/^\.\//, '');
        if (!(name in cache)) {
            if (modules[name] === undefined) throw new Error("Unknown module '" + name + "'");
            cache[name] = -1;
            const moduleObject = { exports: {} };
            context.__module = moduleObject;
            try {
                vm.runInContext('(function __module(module,exports){ ' + modules[name] + '\n})(__module, __module.exports)', context, { filename: name });
            } catch (error) {
                delete cache[name];
                throw error;
            }
            cache[name] = moduleObject.exports;
        } else if (cache[name] === -1) {
            throw new Error("Circular reference to module '" + name + "'");
        }
        return cache[name];
    }
    requireFn.cache = cache;
    context.require = requireFn;

    return {
        context: context,
        require: requireFn,
        consoleLines: consoleLines,
        /** Replace per-tick globals (the engine builds a new Game each tick). */
        setGlobals: function (globals) {
            if (Object.prototype.hasOwnProperty.call(globals, 'Game')) context.Game = globals.Game;
            if (Object.prototype.hasOwnProperty.call(globals, 'Memory')) context.Memory = globals.Memory;
        },
        /** Run `module.exports.loop()` of module 'main' the way the engine does. */
        runMainLoop: function () {
            const mainExports = requireFn('main');
            if (!mainExports || typeof mainExports.loop !== 'function') throw new Error('main does not export loop');
            context.__module = { exports: mainExports };
            vm.runInContext('(function __module(module,exports){ module.exports.loop();\n})(__module, __module.exports)', context, { filename: '__mainLoop' });
        },
        /** Evaluate an expression inside the sandbox (test helper). */
        evaluate: function (code) { return vm.runInContext(code, context); },
    };
}

/**
 * Module map of a directory of flat *.js files (like e2e/user-strategy-runner.js).
 * @param {string} dir
 * @returns {Object<string,string>}
 */
function modulesFromDirectory(dir) {
    const result = {};
    for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.js')) result[file.slice(0, -3)] = fs.readFileSync(path.join(dir, file), 'utf8');
    }
    return result;
}

module.exports = { SCREEPS_CONSTANTS, createScreepsSandbox, modulesFromDirectory };
