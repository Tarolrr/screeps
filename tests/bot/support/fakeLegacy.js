// Injectable fake of the dist2 module set used by LegacyAdapter tests. Every
// call is appended to `calls` as 'module.method' so tests can assert the exact
// dist2/main.js sequence.

/**
 * @param {{failOn?: string, initFailOn?: string}} [options]
 *   failOn: 'module.method' that throws during the per-tick loop
 *   initFailOn: 'module.method' that throws during initialisation (once)
 */
function createFakeLegacy(options) {
    const o = options || {};
    const calls = [];
    let initFailArmed = !!o.initFailOn;
    function rec(name, extra) {
        return function () {
            calls.push(extra ? name + ':' + extra(arguments) : name);
            if (name === o.failOn) throw new Error('legacy failure in ' + name);
            if (initFailArmed && name === o.initFailOn) { initFailArmed = false; throw new Error('init failure in ' + name); }
        };
    }
    function SourceResource() {}
    function SpawnProcess() {}
    function CreepOrder() {}
    function ConstructionOrder() {}
    const modules = {
        roles: { run: rec('roles.run', function (a) { return a[0].name; }) },
        logger: { debug: rec('logger.debug', function (a) { return a[0]; }), error: rec('logger.error', function (a) { return String(a[0]).split('\n')[0]; }), load: rec('logger.load') },
        resourceManager: {
            registerResourceType: rec('resourceManager.registerResourceType', function (a) { return a[0] + '=' + a[1].name; }),
            load: rec('resourceManager.load'),
            save: rec('resourceManager.save'),
        },
        sourceResource: SourceResource,
        sourceController: { initialize: rec('sourceController.initialize'), reconcile: rec('sourceController.reconcile') },
        spawnController: { initialize: rec('spawnController.initialize'), reconcile: rec('spawnController.reconcile') },
        spawnProcess: SpawnProcess,
        creepOrder: CreepOrder,
        roomController: { initialize: rec('roomController.initialize'), reconcile: rec('roomController.reconcile') },
        buildController: { initialize: rec('buildController.initialize'), reconcile: rec('buildController.reconcile') },
        constructionOrder: ConstructionOrder,
    };
    return {
        calls: calls,
        modules: modules,
        loadModules: function () { calls.push('load'); return modules; },
        prepareEnvironment: function () { calls.push('mapPatch'); },
    };
}

const EXPECTED_INIT = [
    'load',
    'logger.debug:Initializing game state...',
    'resourceManager.registerResourceType:source=SourceResource',
    'resourceManager.registerResourceType:spawnProcess=SpawnProcess',
    'resourceManager.registerResourceType:creepOrder=CreepOrder',
    'resourceManager.registerResourceType:constructionOrder=ConstructionOrder',
    'resourceManager.load',
    'buildController.initialize',
    'sourceController.initialize',
    'spawnController.initialize',
    'roomController.initialize',
    'logger.debug:Initialization complete',
];

/** @param {string[]} creepNames */
function expectedLoop(creepNames) {
    return ['logger.load'].concat(creepNames.map(function (n) { return 'roles.run:' + n; }), [
        'sourceController.reconcile', 'spawnController.reconcile', 'roomController.reconcile', 'buildController.reconcile', 'resourceManager.save',
    ]);
}

module.exports = { createFakeLegacy, EXPECTED_INIT, expectedLoop };
