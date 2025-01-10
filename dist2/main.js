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

let initialized = false;

module.exports.loop = function () {
    try {
        logger.load();

        // Initialization phase - runs only on the first tick
        if (!initialized) {
            logger.debug("Initializing game state...");
            resourceManager.registerResourceType("source", sourceResource);
            resourceManager.registerResourceType("spawnProcess", spawnProcess);
            resourceManager.registerResourceType("creepOrder", creepOrder);
            resourceManager.load();

            initialized = true;
            logger.debug("Initialization complete");
        }

        
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
