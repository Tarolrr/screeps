require("./mapPatch")
const roles = require('./roles');
const logger = require('./logger');
const resourceManager = require('./resourceManager');
const sourceResource = require('./resources.sourceResource');
const sourceController = require('./SourceController');
const spawnController = require('./SpawnController');
const spawnProcess = require('./resources.spawnProcess');
const creepOrder = require('./resources.creepOrder');
const roomController = require('./RoomController');
/** @type {import('js-yaml')} */
var yaml = require('js-yaml');
// test_yaml = `
// spawnProcess:
//     - type: source
//       id: 1
//       amount: 500
// `
// console.log(JSON.stringify(yaml.load(test_yaml), null, 2));

logger.debug("Initializing game state...");

resourceManager.registerResourceType("source", sourceResource);
resourceManager.registerResourceType("spawnProcess", spawnProcess);
resourceManager.registerResourceType("creepOrder", creepOrder);
resourceManager.load();

logger.debug("Initialization complete");

module.exports.loop = function () {
    try {
        logger.load();
        
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            roles.run(creep);
        }

        // Regular game loop
        sourceController.reconcile()
        spawnController.reconcile();
        roomController.reconcile();
        // Save state
        resourceManager.save();
        
    } catch (error) {
        logger.error("Error in main loop: " + error.stack);
        initialized = false;  // Force re-initialization on error
    }
}
