const resourceManager = require('./resourceManager');

class SpawnController {
    constructor() {
        this.lastReconcileTime = 0;
    }

    reconcile() {
        // Check active orders for missing creeps
        resourceManager.getResourcesOfType("creepOrder")
            .filter(order => order.status === "active")
            .forEach(order => {
                const creep = Game.getObjectById(order.creepId);
                if (!creep) {
                    // Creep no longer exists
                    if (Memory.creeps[order.creepId]) {
                        delete Memory.creeps[order.creepId];
                    }
                    order.status = "pending";
                    order.creepId = null;
                    resourceManager.updateResource("creepOrder", order.id, order);
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
                        order.creepId = process.creepId;
                        resourceManager.updateResource("creepOrder", order.id, order);
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
                const bodyParts = order.calculateBodyParts(room.energyAvailable);
                if (!bodyParts) break;

                const result = spawn.spawnCreep(bodyParts, order.id, {
                    memory: order.memory
                });

                if (result === OK) {
                    // Create spawn process to track this spawn
                    resourceManager.applyResource("spawnProcess", {
                        orderId: order.id,
                        spawnId: spawn.id
                    });
                    
                    // Update order status
                    order.status = "spawning";
                    resourceManager.updateResource("creepOrder", order.id, order);
                    break; // Only spawn one creep at a time
                }
            }
        });
    }
}

const instance = new SpawnController();
module.exports = instance;
