const resourceManager = require("./resourceManager")
const logger = require('./logger');

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
        if (resourceManager.getResourcesOfType("source").length === 0) {
            const room = Object.values(Game.rooms)[0];
            let sources = room.find(FIND_SOURCES);
            
            sources.forEach(source => {
                resourceManager.createResource("source", {
                    sourceId: source.id,
                    workPlaces: this.calculateWorkPlaces(source)
                });
            });
        }

        // Check each source
        resourceManager.getResourcesOfType("source").forEach(sourceResource => {
            const source = sourceResource.source; // This gets the actual game object
            if (!source) return; // Skip if source no longer exists
            
            // Get current harvester orders for this source
            const harvesterOrders = resourceManager.getResourcesOfType("creepOrder")
                .filter(order => order.memory.role === "harvester" && 
                               order.memory.sourceId === sourceResource.sourceId &&
                               order.status !== "complete");

            // Calculate desired number of harvesters
            const desiredHarvesters = sourceResource.workPlaces.length;
            const currentOrders = harvesterOrders.length;

            // Create new harvester orders if needed
            if (currentOrders < desiredHarvesters) {
                const newOrderCount = desiredHarvesters - currentOrders;
                for (let i = 0; i < newOrderCount; i++) {
                    resourceManager.createResource("creepOrder", {
                        schema: CreepOrder.SCHEMAS.HARVESTER,
                        role: "harvester",
                        roomName: source.room.name,
                        memory: {
                            role: "harvester",
                            sourceId: sourceResource.sourceId,
                            workPlace: sourceResource.workPlaces[i]
                        },
                        status: "pending"
                    });
                }
            }
        });
    }
}           

module.exports = SourceController