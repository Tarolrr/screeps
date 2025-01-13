const ConstructionOrder = require('./resources.constructionOrder');
const CreepOrder = require('./resources.creepOrder');
const resourceManager = require('./resourceManager');
const logger = require('./logger');

class BuildController {
    constructor() {
        // Room agnostic controller
    }

    createBuilderOrder(room, priority, collectTemplates) {
        return resourceManager.applyResource('creepOrder', {
            role: 'builder',
            schema: CreepOrder.SCHEMAS.BUILDER,
            priority: priority,
            roomName: room.name,
            metadata: {
                annotation: `builder_${room.name}`
            },
            memory: {
                role: 'builder',
                collectTemplates: collectTemplates,
            }
        });
    }

    queueStructurePattern(roomName, structureType, pattern, priority = 0, annotation, count=0) {
        // logger.debug(`Queuing construction order for ${structureType} in room ${roomName}, priority: ${priority}, count: ${count}, annotation: ${annotation}`);
        return resourceManager.applyResource('constructionOrder', {
            structureType,
            pattern,
            roomName,
            priority,
            metadata: {
                annotation
            },
            count: count
        });
    }

    ensureBasicStructures(room) {
        const spawn = room.find(FIND_MY_SPAWNS)[0];
        if (!spawn) return;

        // Queue extensions in a centered checkboard pattern
        const maxExtensions = CONTROLLER_STRUCTURES['extension'][room.controller.level];
        this.queueStructurePattern(
            room.name,
            STRUCTURE_EXTENSION,
            {
                type: 'checkboard',
                params: {
                    startPos: spawn.pos,
                    size: 7,
                    centered: true
                }
            },
            90, // high priority
            `extensions_${room.name}`,
            maxExtensions
        );

        // Queue roads from sources to spawn
        const sources = room.find(FIND_SOURCES);
        for (const source of sources) {
            this.queueStructurePattern(
                room.name,
                STRUCTURE_ROAD,
                {
                    type: 'path',
                    params: {
                        roomName: room.name,
                        fromPos: source.pos,
                        toPos: spawn.pos,
                        width: 2,
                        opts: {
                            ignoreCreeps: true,
                            swampCost: 1,
                            range: 1,
                            ignoreRoads: true
                        }
                    }
                },
                70, // medium-high priority
                `road_source_${source.id}_spawn`
            );
        }

        // Road from spawn to controller
        this.queueStructurePattern(
            room.name,
            STRUCTURE_ROAD,
            {
                type: 'path',
                params: {
                    roomName: room.name,
                    fromPos: spawn.pos,
                    toPos: room.controller.pos,
                    width: 2,
                    opts: {
                        ignoreCreeps: true,
                        swampCost: 1,
                        range: 1,
                        ignoreRoads: true
                    }
                }
            },
            80, // high priority for controller road
            `road_spawn_controller_${room.name}`
        );
    }

    reconcile() {
        // Only process rooms with spawns
        for (const room of Object.values(Game.rooms)) {
            const spawn = room.find(FIND_MY_SPAWNS)[0];
            if (!spawn) continue;

            // Ensure basic structures are queued
            this.ensureBasicStructures(room);

            // Handle construction orders
            const constructionOrders = resourceManager.getResourcesOfType('constructionOrder')
            .filter(order => order.roomName === room.name)
            .sort((a, b) => (b.priority || 0) - (a.priority || 0));

            const MAX_CONSTRUCTION_SITES = 5; // We can adjust this value
            let currentSites = room.find(FIND_MY_CONSTRUCTION_SITES).length;
            // logger.debug('Current construction sites: ' + currentSites + ', max: ' + MAX_CONSTRUCTION_SITES);
            for (const order of constructionOrders) {
                if (currentSites >= MAX_CONSTRUCTION_SITES) {
                    break;
                }

                let newPositions = order.generateConstructionSitePositions(MAX_CONSTRUCTION_SITES - currentSites);
                // logger.debug(`Processing construction order: ${order.id}, positions: ${JSON.stringify(newPositions)}`);
                // Try to create construction sites for missing structures
                for (let i = 0; i < newPositions.length; i++) {
                    const pos = newPositions[i];
                    const result = room.createConstructionSite(pos.x, pos.y, order.structureType);
                    
                    if (result === OK) {                            
                        currentSites++;
                    }
                    if (currentSites >= MAX_CONSTRUCTION_SITES) {
                        break;
                    }
                }

                // If we've reached the maximum, stop processing orders
                if (currentSites >= MAX_CONSTRUCTION_SITES) {
                    break;
                }
            }


            // Resources part

            // Ensure basic structures are queued
            this.ensureBasicStructures(room);

            // Handle builder creep order
            const collectTemplates = [{
                type: 'area',
                entityType: 'ground',
                pos: {
                    x: spawn.pos.x,
                    y: spawn.pos.y
                },
                range: 5
            }];
            
            this.createBuilderOrder(room, 40, collectTemplates);

            // Handle mule for construction
            const sourceResources = resourceManager.getResourcesOfType('source')
                .filter(source => source.roomName === room.name);
            
            for (const sourceResource of sourceResources) {
                const source = Game.getObjectById(sourceResource.sourceId);
                resourceManager.applyResource('creepOrder', {
                    role: 'mule',
                    priority: 49,
                    schema: CreepOrder.SCHEMAS.MULE,
                    roomName: room.name,
                    metadata: {
                        annotation: `mule_build_${source.id}`
                    },
                    memory: {
                        role: 'mule',
                        collectTemplates: [{
                            type: 'area',
                            entityType: 'ground',
                            pos: {
                                x: source.pos.x,
                                y: source.pos.y
                            },
                            range: 3
                        }],
                        deliverTemplates: [{
                            type: 'area',
                            entityType: 'ground',
                            pos: {
                                x: spawn.pos.x,
                                y: spawn.pos.y
                            },
                            range: 3
                        }]
                    }
                }); 
            }
        }
    }
}

module.exports = new BuildController();
