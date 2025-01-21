const ConstructionOrder = require('./resources.constructionOrder');
const CreepOrder = require('./resources.creepOrder');
const resourceManager = require('./resourceManager');
const logger = require('./logger');

class BuildController {
    initialize() {
        this.applyResources();
    }

    placeExtensionPatterns(roomName, pattern) {
            // single order supplies 20 extensions
            for (let i = 0; i < this.NUM_EXTENSION_ORDERS; i++) {
                this.queueStructurePattern(roomName, STRUCTURE_EXTENSION, pattern, this.EXTENSION_PRIORITY - i * this.EXTENSION_OFFSET, `extensions_${roomName}_${i}`);
            }
    }

    applyResources() {
        // Only process rooms with spawns
        for (const room of Object.values(Game.rooms)) {
            const spawn = room.find(FIND_MY_SPAWNS)[0];
            if (!spawn) continue;

            // Ensure basic structures are queued
            this.ensureBasicStructures(room);

            resourceManager.applyResource('creepOrder', {
                role: 'builder',
                schema: CreepOrder.SCHEMAS.BUILDER,
                priority: 40,
                roomName: room.name,
                metadata: {
                    annotation: `builder_${room.name}`
                },
                memory: {
                    role: 'builder',
                    collectTemplates: [{
                        type: 'area',
                        entityType: 'ground',
                        pos: {
                            x: spawn.pos.x,
                            y: spawn.pos.y
                        },
                        range: 5
                    }],
                }
            });

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

        this.placeExtensionPatterns(
            room.name,
            {
                type: 'patternPlacer',
                params: {
                    pattern: 'parallelLines',
                    patternArgs: {
                        size: 7,
                    },
                    terrain: room.getTerrain(),
                    targetPos: {
                        x: spawn.pos.x,
                        y: spawn.pos.y
                    },
                }
            }
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

        if (Game.time % 100 !== 0) return;

        // Only process rooms with spawns
        for (const room of Object.values(Game.rooms)) {
            const spawn = room.find(FIND_MY_SPAWNS)[0];

            if (!spawn) continue;

            // Handle construction orders
            const constructionOrders = resourceManager.getResourcesOfType('constructionOrder')
            .filter(order => order.roomName === room.name)
            .sort((a, b) => (b.priority || 0) - (a.priority || 0));
            
            for (const order of constructionOrders) {
                // manage structures
                order.validateOwnedStructures();
                order.claimStructures(order.positions);
                order.removeExcessStructures();
            }

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

            this.applyResources();
        }
    }
}

BuildController.prototype.NUM_EXTENSION_ORDERS = 3;
BuildController.prototype.EXTENSION_PRIORITY = 1000;
BuildController.prototype.EXTENSION_OFFSET = 10;

module.exports = new BuildController();
