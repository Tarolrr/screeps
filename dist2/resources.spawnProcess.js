const Resource = require('./resources.Resource');
const resourceManager = require('./resourceManager');

class SpawnProcess extends Resource {
    static get STATE_SCHEMA() {
        return Resource.combineSchemas(Resource.STATE_SCHEMA, {
            spawnId: 'string',
            status: 'string',  // spawning, completed, failed
            progress: 'number',
            creepName: 'string'
        });
    }

    static get SPEC_SCHEMA() {
        return Resource.combineSchemas(Resource.SPEC_SCHEMA, {
            roomName: 'string',
            orderId: 'string'
        });
    }

    constructor(data) {
        super(data);

        // Set spec fields
        this.roomName = data.roomName;
        this.orderId = data.orderId;

        // Set state fields
        this.spawnId = data.spawnId;
        this.status = data.status || 'spawning';
        this.progress = data.progress || 0;
        this.creepName = data.creepName;
    }

    get spawn() {
        return Game.getObjectById(this.spawnId);
    }

    get order() {
        return resourceManager.getResourceByTypeAndId("creepOrder", this.orderId);
    }

    get creep() {
        return this.creepName ? Game.creeps[this.creepName] : null;
    }

    isComplete() {
        const spawn = this.spawn;
        if (!spawn || !spawn.spawning) {
            const creep = Game.creeps[this.creepName];  // Creep ID is same as order ID
            if (creep) {
                this.status = 'completed';
            } else {
                this.status = 'failed';
            }
            return true;
        }
        return false;
    }

    toSpec() {
        return {
            ...super.toSpec(),
            roomName: this.roomName,
            orderId: this.orderId
        };
    }

    toJSON() {
        return {
            ...super.toJSON(),
            spawnId: this.spawnId,
            status: this.status,
            progress: this.progress,
            creepName: this.creepName
        };
    }
}

module.exports = SpawnProcess;
