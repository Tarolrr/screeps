const Resource = require('./resources.Resource');
const resourceManager = require('./resourceManager');

class SpawnProcess extends Resource {
    constructor(data) {
        super(data);
        this.orderId = data.orderId;  // ID of the CreepOrder this process is for
        this.spawnId = data.spawnId;  // ID of the spawn being used
        this.startTime = data.startTime || Game.time;
        this.status = data.status || 'spawning';  // spawning, completed, failed
        this.creepId = data.creepId;  // ID of the resulting creep (if successful)
    }

    generateSignature(data) {
        // Spawn processes are uniquely identified by their orderId and spawnId
        return JSON.stringify({
            orderId: data.orderId,
            spawnId: data.spawnId
        });
    }

    get spawn() {
        return this.spawnId ? Game.getObjectById(this.spawnId) : null;
    }

    get order() {
        return resourceManager.getResourceByTypeAndId("creepOrder", this.orderId);
    }

    get creep() {
        return this.creepId ? Game.getObjectById(this.creepId) : null;
    }

    isComplete() {
        const spawn = this.spawn;
        if (!spawn || !spawn.spawning) {
            const creep = Game.creeps[this.orderId];  // Creep ID is same as order ID
            if (creep) {
                this.status = 'completed';
                this.creepId = creep.id;
            } else {
                this.status = 'failed';
            }
            return true;
        }
        return false;
    }

    toJSON() {
        return {
            orderId: this.orderId,
            spawnId: this.spawnId,
            startTime: this.startTime,
            status: this.status,
            creepId: this.creepId
        };
    }
}

module.exports = SpawnProcess;
