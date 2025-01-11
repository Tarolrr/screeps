const Resource = require('resources.Resource');

class CreepOrder extends Resource {
    constructor(data) {
        super(data);
        this.schema = data.schema;
        this.role = data.role;
        this.memory = data.memory || {};
        this.status = data.status || 'pending'; // pending, spawning, active, expired
        this.roomName = data.roomName;
        this.creepId = data.creepId;
        // this.jobId = data.jobId;  // ID of the job this creep is meant to do
        // this.expiryTime = data.expiryTime; // When this order should be considered expired
        this.priority = data.priority || 0;
    }

    generateSignature(data) {
        // Creep orders are uniquely identified by their role, jobId, and roomName
        return JSON.stringify({
            role: data.role,
            jobId: data.jobId,
            roomName: data.roomName
        });
    }

    calculateBodyParts(maxEnergy) {
        const parts = [];
        let remainingEnergy = maxEnergy;

        // Add constant parts first
        if (this.schema.constant) {
            const constCost = this.schema.constant.reduce((sum, part) => sum + BODYPART_COST[part], 0);
            if (maxEnergy < constCost) {
                return null;
            }
            parts.push(...this.schema.constant);
            remainingEnergy -= constCost;
        }

        // Add ratio-based parts
        if (this.schema.ratio) {
            const ratioSetCost = Object.entries(this.schema.ratio)
                .reduce((sum, [part, count]) => sum + (BODYPART_COST[part] * count), 0);
            
            if (remainingEnergy < ratioSetCost) {
                return parts;
            }

            const sets = Math.floor(remainingEnergy / ratioSetCost);
            remainingEnergy -= ratioSetCost * sets;

            // Add the parts in sets
            for (let i = 0; i < sets; i++) {
                Object.entries(this.schema.ratio).forEach(([part, count]) => {
                    for (let j = 0; j < count; j++) {
                        parts.push(part);
                    }
                });
            }
        }

        return parts;
    }

    get creep() {
        return this.creepId ? Game.getObjectById(this.creepId) : null;
    }

    isValid() {
        // Check if the order is still valid (creep exists and hasn't expired)
        if (this.status === 'expired') return false;
        // if (this.expiryTime && Game.time > this.expiryTime) {
        //     this.status = 'expired';
        //     return false;
        // }
        
        if (this.status === 'active') {
            const creep = this.creep;
            if (!creep || creep.ticksToLive <= 0) {
                this.status = 'expired';
                return false;
            }
        }
        
        return true;
    }

    toJSON() {
        return {
            ...super.toJSON(),
            schema: this.schema,
            role: this.role,
            memory: this.memory,
            status: this.status,
            roomName: this.roomName,
            creepId: this.creepId,
            // jobId: this.jobId,
            // expiryTime: this.expiryTime,
            priority: this.priority
        };
    }

    static createSchema(constant = [], ratio = {}) {
        return {
            constant,
            ratio
        };
    }
}

// Example schemas
CreepOrder.SCHEMAS = {
    HARVESTER: CreepOrder.createSchema(
        [MOVE, CARRY, WORK], // constant parts
        { [WORK]: 1 } // ratio parts ( 1 WORK )
    ),
    BUILDER: CreepOrder.createSchema(
        [MOVE, CARRY],
        { [WORK]: 1, [CARRY]: 1, [MOVE]: 1 }
    ),
    MULE: CreepOrder.createSchema(
        [CARRY, CARRY, MOVE],
        { [CARRY]: 2, [MOVE]: 1 }
    ),
    UPGRADER: CreepOrder.createSchema(
        [MOVE, CARRY, WORK],
        { [WORK]: 1 }
    ),
    // Add more schemas as needed
};

module.exports = CreepOrder;
