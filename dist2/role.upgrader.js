const logger = require("./logger")

const STATE = {
    IDLE: 'idle',
    COLLECTING: 'collecting',
    UPGRADING: 'upgrading'
};

const roleUpgrader = {
    /** @param {Creep} creep **/
    run: function(creep) {
        if (creep.spawning) {
            logger.debug(`Upgrader ${creep.name} is spawning`);
            return;
        }

        // Initialize state if needed
        if (!creep.memory.state) {
            logger.debug(`Upgrader ${creep.name} initializing state to IDLE`);
            creep.memory.state = STATE.IDLE;
        }

        // Switch states based on energy
        if (creep.memory.state === STATE.COLLECTING && creep.store.getFreeCapacity() === 0) {
            logger.debug(`Upgrader ${creep.name} inventory full, switching to UPGRADING`);
            creep.memory.state = STATE.UPGRADING;
        } else if (creep.memory.state === STATE.UPGRADING && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            logger.debug(`Upgrader ${creep.name} out of energy, switching to COLLECTING`);
            creep.memory.state = STATE.COLLECTING;
        }

        // State machine logic
        switch (creep.memory.state) {
            case STATE.IDLE:
                this.handleIdleState(creep);
                break;
            case STATE.COLLECTING:
                this.handleCollectingState(creep);
                break;
            case STATE.UPGRADING:
                this.handleUpgradingState(creep);
                break;
        }
    },

    handleIdleState: function(creep) {
        if (creep.store.getFreeCapacity() > 0) {
            creep.memory.state = STATE.COLLECTING;
        } else {
            creep.memory.state = STATE.UPGRADING;
        }
    },

    handleCollectingState: function(creep) {
        const ctrl = creep.room.controller;
        const droppedEnergy = ctrl.pos.findInRange(FIND_DROPPED_RESOURCES, 5, {
            filter: resource => resource.resourceType === RESOURCE_ENERGY
        });

        if (droppedEnergy.length > 0) {
            logger.debug(`Upgrader ${creep.name} found ${droppedEnergy.length} dropped energy sources`);
            const target = droppedEnergy[0];
            if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
                creep.moveTo(target);
            }
            return;
        }

        // If no dropped energy, look for containers
        const containers = creep.pos.findInRange(FIND_STRUCTURES, 5, {
            filter: s => s.structureType === STRUCTURE_CONTAINER && 
                        s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
        });

        if (containers.length > 0) {
            logger.debug(`Upgrader ${creep.name} found ${containers.length} containers with energy`);
            const container = containers[0];
            if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(container);
            }
        }
    },

    handleUpgradingState: function(creep) {
        if (!creep.room.controller) {
            logger.warn(`Upgrader ${creep.name} can't find room controller`);
            return;
        }

        const result = creep.upgradeController(creep.room.controller);
        if (result === ERR_NOT_IN_RANGE) {
            creep.moveTo(creep.room.controller);
        } else if (result !== OK) {
            logger.debug(`Upgrader ${creep.name} upgrade result: ${result}`);
        }
    }
};

module.exports = roleUpgrader;