class SpawnController {
    constructor() {
        this.lastReconcileTime = 0;
    }

    reconcile() {
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

            // Try to spawn the first order that we can afford
            for (const order of orders) {
                const bodyParts = order.calculateBodyParts(room.energyAvailable);
                if (!bodyParts) continue;

                const result = spawn.spawnCreep(bodyParts, order.id, {
                    memory: order.memory
                });

                if (result === OK) {
                    // Update order status
                    order.status = "spawning";
                    order.spawnId = spawn.id;
                    resourceManager.updateResource("creepOrder", order.id, order);
                    break; // Only spawn one creep at a time
                }
            }
        });

        // Check for completed spawns
        resourceManager.getResourcesOfType("creepOrder")
            .filter(order => order.status === "spawning")
            .forEach(order => {
                const spawn = Game.getObjectById(order.spawnId);
                if (!spawn || !spawn.spawning) {
                    // Spawn is done or something went wrong
                    const creep = Game.creeps[order.id];
                    order.status = creep ? "complete" : "failed";
                    resourceManager.updateResource("creepOrder", order.id, order);
                }
            });
    }
}

module.exports = SpawnController;
