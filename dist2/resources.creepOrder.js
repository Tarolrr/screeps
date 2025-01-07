class CreepOrder {
    constructor(data) {
        this.id = data.id;
        this.schema = data.schema;
        this.role = data.role;
        this.memory = data.memory || {};
        this.status = data.status || 'pending'; // pending, spawning, complete, failed
        this.spawnId = data.spawnId;
        this.roomName = data.roomName;
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
                return null;
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

    toJSON() {
        return {
            id: this.id,
            schema: this.schema,
            role: this.role,
            memory: this.memory,
            status: this.status,
            spawnId: this.spawnId,
            roomName: this.roomName
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
    // HARVESTER: CreepOrder.createSchema(
    //     [MOVE, CARRY], // constant parts
    //     { [WORK]: 2, [MOVE]: 1 } // ratio parts (2 WORK : 1 MOVE)
    // ),
    HARVESTER: CreepOrder.createSchema(
        [MOVE, CARRY], // constant parts
        { [WORK]: 1 } // ratio parts ( 1 WORK )
    ),
    BUILDER: CreepOrder.createSchema(
        [MOVE, CARRY],
        { [WORK]: 1, [CARRY]: 1, [MOVE]: 1 }
    ),
    // Add more schemas as needed
};

module.exports = CreepOrder;
