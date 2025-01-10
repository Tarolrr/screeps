const resourceManager = require('./resourceManager');

class SpawnProcess {
    constructor(data) {
        this.id = data.id;
        this.orderId = data.orderId;  // ID of the CreepOrder this process is for
        this.spawnId = data.spawnId;  // ID of the spawn being used
        this.startTime = data.startTime || Game.time;
        this.status = data.status || 'spawning';  // spawning, completed, failed
        this.creepId = data.creepId;  // ID of the resulting creep (if successful)
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
            id: this.id,
            orderId: this.orderId,
            spawnId: this.spawnId,
            startTime: this.startTime,
            status: this.status,
            creepId: this.creepId
        };
    }
}

module.exports = SpawnProcess;
