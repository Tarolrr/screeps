const resourceManager = require('./resourceManager');
const logger = require('./logger');
const CreepOrder = require('./resources.creepOrder');
const PriorityCalculator = require('./utils.priority');

class RoomController {
    constructor() {
        
    }

    reconcile() {
        for (const room of Object.values(Game.rooms)) {
            const sources = room.find(FIND_SOURCES);
            const spawns = room.find(FIND_MY_SPAWNS);
            const controller = room.controller;

            if (!spawns.length) continue;

            for (const source of sources) {
                const spawn = spawns[0];  // Using first spawn for now
                if (spawn && source) {
                    const priority = PriorityCalculator.calculatePriorityFromId(source.id, 10);
                    resourceManager.applyResource('creepOrder', {
                        role: 'mule',
                        priority: priority,
                        schema: CreepOrder.SCHEMAS.MULE,
                        roomName: room.name,
                        metadata: {
                            annotation: `mule_spawn_${source.id}`
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
                                entityType: 'structure',
                                structureTypes: STRUCTURE_SPAWN + " " + STRUCTURE_EXTENSION, 
                                range: 50,
                                pos: {
                                    x: spawn.pos.x,
                                    y: spawn.pos.y
                                }
                            }]
                        }
                    });    
                    resourceManager.applyResource('creepOrder', {
                        role: 'mule',
                        priority: 51,
                        schema: CreepOrder.SCHEMAS.MULE,
                        roomName: room.name,
                        metadata: {
                            annotation: `mule_controller_${source.id}`
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
                                    x: controller.pos.x,
                                    y: controller.pos.y
                                },
                                range: 4
                            }]
                        }
                    });                    
                    resourceManager.applyResource('creepOrder', {
                        role: 'upgrader',
                        priority: 50,
                        schema: CreepOrder.SCHEMAS.UPGRADER,
                        roomName: room.name,
                        metadata: {
                            annotation: `upgrader_${source.id}`
                        },
                        memory: {
                            role: 'upgrader',
                        }
                    });
                }
            }
        }
    }
}

module.exports = new RoomController();
