const resourceManager = require("./resourceManager")
const logger = require('./logger');
const CreepOrder = require("./resources.creepOrder");
const PriorityCalculator = require('./utils.priority');

class SourceController {

    initialize() {
        this.applyResources();
    }

    applyResources() {
        for (const room of Object.values(Game.rooms).filter(r => r.find(FIND_MY_SPAWNS).length > 0)) {
            const sources = room.find(FIND_SOURCES);
            
            sources.forEach(source => {
                resourceManager.applyResource("source", {
                    sourceId: source.id,
                    roomName: room.name,
                    metadata: {
                        annotation: `source_${source.id}`
                    }
                });
            });

            const sourceResources = resourceManager.getResourcesOfType('source').filter(sr => sr.roomName === room.name);
            
            for (const sourceResource of sourceResources) {
                const priority = PriorityCalculator.calculatePriorityFromId(sourceResource.sourceId, 0);
                
                resourceManager.applyResource('creepOrder', {
                    role: 'harvester',
                    priority: priority,
                    schema: CreepOrder.SCHEMAS.HARVESTER,
                    roomName: room.name,
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

    reconcile() {
        if (Game.time % 100 !== 0) return;
        this.applyResources();
    }
}           

module.exports = new SourceController();
