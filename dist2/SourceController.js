const resourceManager = require("./resourceManager")
const logger = require('./logger');
const CreepOrder = require("./resources.creepOrder");
const PriorityCalculator = require('./utils.priority');

class SourceController {

    reconcile() {
        // Initialize sources if none exist
        const room = Object.values(Game.rooms)[0];
        let sources = room.find(FIND_SOURCES);
            
        sources.forEach(source => {
            resourceManager.applyResource("source", {
                sourceId: source.id,
                roomName: source.room.name,
                metadata: {
                    annotation: `source_${source.id}`
                }
            });
        });

        const sourceResources = resourceManager.getResourcesOfType('source');
        
        for (const sourceResource of sourceResources) {
            const priority = PriorityCalculator.calculatePriorityFromId(sourceResource.sourceId, 0);
            
            resourceManager.applyResource('creepOrder', {
                role: 'harvester',
                priority: priority,
                schema: CreepOrder.SCHEMAS.HARVESTER,
                roomName: sourceResource.source.room.name,
                metadata: {
                    annotation: `harvester_${sourceResource.sourceId}`
                },
                memory: {
                    role: 'harvester',
                    sourceId: sourceResource.sourceId
                }
            });
        }
    }
}           

const instance = new SourceController();
module.exports = instance;