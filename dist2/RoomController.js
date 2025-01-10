const resourceManager = require('./resourceManager');
const logger = require('./logger');

class RoomController {
    constructor() {
        
    }

    reconcile() {
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];

            const sources = room.find(FIND_SOURCES);
            const spawn = room.find(FIND_MY_SPAWNS)[0];
            const controller = room.controller;
            if (!spawn) return;

            // Get all active mule orders for this room
            const muleOrders = resourceManager.getResourceByField('creepOrder', 'role', 'mule')
                .filter(order => 
                    order.roomName === room.name &&
                    order.status !== 'expired'
                );

            // Check each source
            for (const source of sources) {
                // Check if we have a mule for this source
                const hasMule = muleOrders.some(order => 
                    order.metadata && order.metadata.sourceId === source.id
                );

                if (!hasMule) {
                    logger.info(`Creating mule order for source ${source.id} in room ${room.name}`);
                    
                    resourceManager.createResource('creepOrder', {
                        role: 'mule',
                        priority: 90,
                        schema: {
                            constant: [MOVE, CARRY, CARRY],
                            ratio: {
                                [MOVE]: 1,
                                [CARRY]: 2
                            }
                        },
                        spawnId: spawn.id,
                        roomName: room.name,
                        metadata: {
                            sourceId: source.id
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
                                type: 'entity',
                                id: spawn.id
                            }]
                        }
                    });                    
                    resourceManager.createResource('creepOrder', {
                        role: 'mule',
                        priority: 50,
                        schema: {
                            constant: [MOVE, CARRY, CARRY],
                            ratio: {
                                [MOVE]: 1,
                                [CARRY]: 2
                            }
                        },
                        spawnId: spawn.id,
                        roomName: room.name,
                        metadata: {
                            sourceId: source.id
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
                                range: 5
                            }]
                        }
                    });                    
                    resourceManager.createResource('creepOrder', {
                        role: 'upgrader',
                        priority: 50,
                        schema: {
                            constant: [MOVE, CARRY],
                            ratio: {
                                [WORK]: 1,
                            }
                        },
                        spawnId: spawn.id,
                        roomName: room.name,
                        metadata: {
                            sourceId: source.id
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
