const resourceManager = require('./resourceManager');
const logger = require('./logger');

class SpawnController {
    constructor() {
        this.lastReconcileTime = 0;
    }
    reconcile() {
        // Remove memory of missing creeps
        for (const creepName in Memory.creeps) {
            if (!Game.creeps[creepName]) {
                delete Memory.creeps[creepName];
            }
        }
        // Check active orders for missing creeps
        resourceManager.getResourcesOfType("creepOrder")
            .filter(order => order.status === "active")
            .forEach(order => {
                if (order.expiryTime && Game.time > order.expiryTime - 100) {
                    logger.debug(`Order expired: ${order.id}, expiry time: ${order.expiryTime}, game time: ${Game.time}`);
                    order.status = "pending";
                    order.creepName = null;
                    return;
                }
                const creep = Game.creeps[order.creepName];
                if (!creep) {
                    // Creep no longer exists
                    logger.debug(`Order creep not found: ${order.id}, creep name: ${order.creepName}`);
                    order.status = "pending";
                    order.creepName = null;
                }
            });
        
        // As an error handling measure, check if any spawning orders don't have a spawn process
        resourceManager.getResourcesOfType("creepOrder")
            .filter(order => order.status === "spawning")
            .forEach(order => {
                if (!resourceManager.getResourceByField("spawnProcess", "orderId", order.id).length) {
                    order.status = "pending";
                    order.creepName = null;
                }
            });

        // Check existing spawn processes
        resourceManager.getResourcesOfType("spawnProcess")
            .filter(process => process.status === "spawning")
            .forEach(process => {
                if (process.isComplete()) {
                    const order = process.order;
                    if (order && process.status === 'completed') {
                        order.status = "active";
                        order.creepName = process.creepName;
                        order.expiryTime = Game.time + 1500;
                    }
                    else if (order && process.status === 'failed') {
                        order.status = "pending";
                        order.creepName = null;
                    }
                    // Remove the spawn process as it's complete
                    resourceManager.deleteResource("spawnProcess", process.id);
                }
            });

        // Get all pending orders
        const pendingOrders = resourceManager.getResourcesOfType("creepOrder")
            .filter(order => order.status === "pending");

        // Group orders by room
        const ordersByRoom = {};
        pendingOrders.forEach(order => {
            if (!ordersByRoom[order.roomName]) {
                ordersByRoom[order.roomName] = [];
            }
            ordersByRoom[order.roomName].push(order);
        });

        // Process each room's orders
        Object.entries(ordersByRoom).forEach(([roomName, orders]) => {
            const room = Game.rooms[roomName];
            if (!room) return;

            // Get first available spawn in room
            const spawn = room.find(FIND_MY_SPAWNS)[0];
            if (!spawn || spawn.spawning) return;

            // Try to spawn the highest priority order that we can afford
            orders.sort((a, b) => b.priority - a.priority);
            for (const order of orders) {
                const energyToUse = this.calculateEnergyToUse(room);
                const bodyParts = order.calculateBodyParts(energyToUse);
                if (!bodyParts) break;
                const creepName = order.metadata && order.metadata.annotation ? order.metadata.annotation + '_' + (Game.time % 2) : order.id + '_' + (Game.time % 2);
                const result = spawn.spawnCreep(bodyParts, creepName, {
                    memory: order.memory
                });

                if (result === OK) {
                    // Create spawn process to track this spawn
                    logger.debug(`Spawning ${order.role} for order ${order.id} in room ${roomName} with memory: ${JSON.stringify(order.memory)}`);
                    const spawnProcess = {
                        orderId: order.id,
                        spawnId: spawn.id,
                        creepName: creepName
                    };
                    resourceManager.applyResource("spawnProcess", spawnProcess);

                    // Update order status
                    order.status = "spawning";

                    break; // Only spawn one creep at a time
                }
                else {
                    // Try only the highest priority order
                    break;
                }
            }
        });
    }

    calculateEnergyToUse(room) {
        const activeResourceOrders = resourceManager.getResourceByField('creepOrder', 'status', 'active');
        const sources = room.find(FIND_SOURCES);
        const hasSourceWithBothCreeps = sources.some(source => {
            const hasHarvesterForSource = activeResourceOrders.some(order => 
                order.role === 'harvester' && 
                order.metadata && 
                order.metadata.annotation === `harvester_${source.id}`
            );
            const hasMuleForSource = activeResourceOrders.some(order => 
                order.metadata && 
                order.metadata.annotation && 
                order.metadata.annotation === `mule_spawn_${source.id}`
            );
            return hasHarvesterForSource && hasMuleForSource;
        });

        return hasSourceWithBothCreeps ? room.energyCapacityAvailable : SPAWN_ENERGY_CAPACITY;
    }
}

const instance = new SpawnController();
module.exports = instance;
