// LegacyAdapter of contract A.2: runs the dist2/main.js sequence without
// importing dist2/main.js (whose require has side effects).
//
// Sequence reproduced from dist2/main.js:
//   once per global (heap) reset, on the first legacy tick:
//     require mapPatch, roles, logger, resourceManager, resources.sourceResource,
//       SourceController, SpawnController, resources.spawnProcess,
//       resources.creepOrder, RoomController, BuildController,
//       resources.constructionOrder, js-yaml  (same order as dist2/main.js)
//     logger.debug("Initializing game state...")
//     resourceManager.registerResourceType(source|spawnProcess|creepOrder|constructionOrder)
//     resourceManager.load()
//     buildController.initialize(); sourceController.initialize();
//     spawnController.initialize(); roomController.initialize()
//     logger.debug("Initialization complete")
//   every tick, under ONE try/catch that logs via the legacy logger:
//     logger.load(); roles.run(creep) for each Game.creeps;
//     sourceController/spawnController/roomController/buildController.reconcile();
//     resourceManager.save()
//
// BEHAVIOURAL DIFFERENCE (documented in docs/strategy/CONTRACTS-A.md §7):
// dist2/main.js initialises at module require time; this adapter initialises
// at the first legacy loop after a global reset (same tick, same Game/Memory,
// but after BOOT/OBSERVE of the new system and inside loop CPU accounting).
// If initialisation throws, the error propagates to the caller (like a failed
// require of dist2 main, where loop does not run that tick) and initialisation
// is retried on the next tick; already evaluated legacy modules stay cached,
// exactly as the engine keeps successfully required modules after a failed
// require of main.
//
// All requires are inside functions: requiring the bundle has no side effects
// (dist2/logger.js writes Memory.loggerState in its constructor).

/* global Game */

/**
 * @typedef {Object} LegacyModules
 * @property {object} roles
 * @property {object} logger
 * @property {object} resourceManager
 * @property {Function} sourceResource
 * @property {object} sourceController
 * @property {object} spawnController
 * @property {Function} spawnProcess
 * @property {Function} creepOrder
 * @property {object} roomController
 * @property {object} buildController
 * @property {Function} constructionOrder
 */

/** Applies dist2/mapPatch.js (global prototype patch, idempotent via module cache). */
function applyDist2Environment() {
    require('../../../dist2/mapPatch');
}

/**
 * Lazily evaluate the dist2 modules in the order of dist2/main.js.
 * @returns {LegacyModules}
 */
function loadDist2Modules() {
    applyDist2Environment();
    const roles = require('../../../dist2/roles');
    const logger = require('../../../dist2/logger');
    const resourceManager = require('../../../dist2/resourceManager');
    const sourceResource = require('../../../dist2/resources.sourceResource');
    const sourceController = require('../../../dist2/SourceController');
    const spawnController = require('../../../dist2/SpawnController');
    const spawnProcess = require('../../../dist2/resources.spawnProcess');
    const creepOrder = require('../../../dist2/resources.creepOrder');
    const roomController = require('../../../dist2/RoomController');
    const buildController = require('../../../dist2/BuildController');
    const constructionOrder = require('../../../dist2/resources.constructionOrder');
    require('../../../dist2/js-yaml'); // dist2/main.js requires 'js-yaml' (unused); kept for identical module evaluation
    return {
        roles: roles,
        logger: logger,
        resourceManager: resourceManager,
        sourceResource: sourceResource,
        sourceController: sourceController,
        spawnController: spawnController,
        spawnProcess: spawnProcess,
        creepOrder: creepOrder,
        roomController: roomController,
        buildController: buildController,
        constructionOrder: constructionOrder,
    };
}

/**
 * @param {{loadModules?: function(): LegacyModules, prepareEnvironment?: function(): void, getGame?: function(): *}} [options]
 *   loadModules/prepareEnvironment are injectable for tests; defaults evaluate dist2.
 */
function createLegacyAdapter(options) {
    const o = options || {};
    const loadModules = o.loadModules || loadDist2Modules;
    const prepare = o.prepareEnvironment || applyDist2Environment;
    const getGame = o.getGame || function () { return typeof Game !== 'undefined' ? Game : undefined; };

    let modules = null;
    let initialized = false;
    let lastTickToken = null;
    let initCount = 0;

    function initialize() {
        const m = loadModules();
        modules = m;
        m.logger.debug('Initializing game state...');
        m.resourceManager.registerResourceType('source', m.sourceResource);
        m.resourceManager.registerResourceType('spawnProcess', m.spawnProcess);
        m.resourceManager.registerResourceType('creepOrder', m.creepOrder);
        m.resourceManager.registerResourceType('constructionOrder', m.constructionOrder);
        m.resourceManager.load();
        m.buildController.initialize();
        m.sourceController.initialize();
        m.spawnController.initialize();
        m.roomController.initialize();
        m.logger.debug('Initialization complete');
        initialized = true;
        initCount++;
    }

    function legacyLoop() {
        const m = modules;
        try {
            m.logger.load();
            const creeps = getGame().creeps;
            for (const name in creeps) {
                const creep = creeps[name];
                m.roles.run(creep);
            }
            m.sourceController.reconcile();
            m.spawnController.reconcile();
            m.roomController.reconcile();
            m.buildController.reconcile();
            m.resourceManager.save();
        } catch (error) {
            m.logger.error('Error in main loop: ' + error.stack);
        }
    }

    return Object.freeze({
        /** Apply the global prototype patch of dist2 (BOOT). Idempotent. */
        prepareEnvironment: function () { prepare(); },
        /**
         * Run the legacy tick at most once per tickToken. Initialises on the first
         * call after a reset. Throws only if initialisation throws.
         * @param {number} tickToken per-loop counter supplied by the app
         * @returns {{ran:boolean, initializedNow:boolean}}
         */
        runTick: function (tickToken) {
            if (lastTickToken === tickToken) return { ran: false, initializedNow: false };
            lastTickToken = tickToken;
            let initializedNow = false;
            if (!initialized) {
                initialize();
                initializedNow = true;
            }
            legacyLoop();
            return { ran: true, initializedNow: initializedNow };
        },
        isInitialized: function () { return initialized; },
        initCount: function () { return initCount; },
    });
}

module.exports = { createLegacyAdapter, loadDist2Modules, applyDist2Environment };
