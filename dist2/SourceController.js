const resourceManager = require("./resourceManager")
const logger = require('./logger');
const CreepOrder = require("./resources.creepOrder");
const PriorityCalculator = require('./utils.priority');

class SourceController {

    /**
     * Calculates all the free work places around the source.
     * @param {Source} source
     */
    calculateWorkPlaces(source) {
        let workPlaces = []
        const terrain = source.room.getTerrain();
        for(let x = source.pos.x - 1; x <= source.pos.x + 1; x++){
            for(let y = source.pos.y - 1; y <= source.pos.y + 1; y++){
                if((x == source.pos.x) && (y == source.pos.y)){
                    continue;
                }
                if(terrain.get(x, y) != TERRAIN_MASK_WALL){
                    workPlaces.push({x: x, y: y})
                }
            }
        }

        return workPlaces
    }

    reconcile() {
        // Initialize sources if none exist
        const room = Object.values(Game.rooms)[0];
        let sources = room.find(FIND_SOURCES);
            
        sources.forEach(source => {
            resourceManager.applyResource("source", {
                sourceId: source.id,
                roomName: source.room.name,
                workPlaces: this.calculateWorkPlaces(source),
                metadata: {
                    annotation: `source_${source.id}`
                }
            });
        });

        const sourceResources = resourceManager.getResourcesOfType('source');
        
        for (const sourceResource of sourceResources) {
            for (let i = 0; i < sourceResource.workPlaces.length; i++) {
                const priority = PriorityCalculator.calculatePriorityFromId(sourceResource.sourceId, i * 20);
                
                resourceManager.applyResource('creepOrder', {
                    role: 'harvester',
                    priority: priority,
                    schema: CreepOrder.SCHEMAS.HARVESTER,
                    roomName: sourceResource.source.room.name,
                    metadata: {
                        sourceId: sourceResource.sourceId,
                        annotation: `harvester_${sourceResource.sourceId}_${i}`
                    },
                    memory: {
                        role: 'harvester',
                        sourceId: sourceResource.sourceId,
                        workPlace: sourceResource.workPlaces[i]
                    }
                });
            }
        }
    }
}           

const instance = new SourceController();
module.exports = instance;