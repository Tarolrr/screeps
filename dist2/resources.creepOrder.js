const Resource = require('./resources.Resource');

class CreepOrder extends Resource {
    static get STATE_SCHEMA() {
        return Resource.combineSchemas(Resource.STATE_SCHEMA, {
            status: 'string',     // pending, spawning, active, expired
            creepName: 'string',
            expiryTime: 'number'
        });
    }

    static get SPEC_SCHEMA() {
        return Resource.combineSchemas(Resource.SPEC_SCHEMA, {
            role: 'string',
            schema: 'object',
            roomName: 'string',
            priority: 'number',
            memory: 'object'
        });
    }

    constructor(data) {
        super(data);
        this.status = data.status || 'pending';
        this.creepName = data.creepName;
        this.expiryTime = data.expiryTime;
        
        this.role = data.role;
        this.schema = data.schema;
        this.roomName = data.roomName;
        this.memory = data.memory || {};
        this.priority = data.priority || 0;
    }

    calculateBodyParts(maxEnergy) {
        const parts = [];
        let remainingEnergy = maxEnergy;
        let spentEnergy = 0;
        
        // Add constant parts first
        if (this.schema.constant) {
            const constCost = this.schema.constant.reduce((sum, part) => sum + BODYPART_COST[part], 0);
            if (maxEnergy < constCost) {
                return null;
            }
            parts.push(...this.schema.constant);
            remainingEnergy -= constCost;
            spentEnergy += constCost;
        }

        // Add ratio-based parts
        if (this.schema.ratio) {
            const ratioSetCost = Object.entries(this.schema.ratio)
                .reduce((sum, [part, count]) => sum + (BODYPART_COST[part] * count), 0);
            
            if (remainingEnergy < ratioSetCost) {
                return parts;
            }
            
            let maxSets = Math.floor(remainingEnergy / ratioSetCost);
            if (this.schema.maxCost) {
                const remainingCost = this.schema.maxCost - spentEnergy;
                const setsByMaxCost = Math.floor(remainingCost / ratioSetCost);
                maxSets = Math.min(maxSets, setsByMaxCost);
            }

            remainingEnergy -= ratioSetCost * maxSets;
            spentEnergy += ratioSetCost * maxSets;
            
            // Add the parts in sets
            for (let i = 0; i < maxSets; i++) {
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
        return this.creepName ? Game.creeps[this.creepName] : null;
    }

    toSpec() {
        return {
            ...super.toSpec(),
            role: this.role,
            schema: this.schema,
            roomName: this.roomName,
            priority: this.priority,
            memory: this.memory
        };
    }

    toJSON() {
        return {
            ...super.toJSON(),
            status: this.status,
            creepName: this.creepName,
            expiryTime: this.expiryTime
        };
    }

    static createSchema(constant = [], ratio = {}, maxCost = 0) {
        return {
            constant,
            ratio,
            maxCost
        };
    }
}

CreepOrder.SCHEMAS = {
    HARVESTER: CreepOrder.createSchema(
        [MOVE, CARRY, WORK], // constant parts
        { [WORK]: 1 }, // ratio parts ( 1 WORK )
        700
    ),
    BUILDER: CreepOrder.createSchema(
        [MOVE, CARRY, WORK],
        { [WORK]: 1, [CARRY]: 1, [MOVE]: 1 },
        1000
    ),
    MULE: CreepOrder.createSchema(
        [CARRY, CARRY, MOVE],
        { [CARRY]: 2, [MOVE]: 1 },
        600
    ),
    UPGRADER: CreepOrder.createSchema(
        [MOVE, CARRY, WORK],
        { [WORK]: 1 },
        1000
    )
};

module.exports = CreepOrder;
