const logger = require("./logger")

const STATE = {
    IDLE: 'idle',
    COLLECTING: 'collecting',
    DELIVERING: 'delivering'
};

const roleMule = {
    /** @param {Creep} creep **/
    run: function(creep) {
        if (creep.spawning) {
            logger.debug(`Mule ${creep.name} is spawning`);
            return;
        }

        // Initialize state if needed
        if (!creep.memory.state) {
            logger.debug(`Mule ${creep.name} initializing state to IDLE`);
            creep.memory.state = STATE.IDLE;
        }

        // Switch tasks if needed
        if (creep.memory.state === STATE.COLLECTING && creep.store.getFreeCapacity() === 0) {
            // logger.debug(`Mule ${creep.name} inventory full, switching to DELIVERING`);
            creep.memory.state = STATE.DELIVERING;
            creep.memory.currentTaskIndex = 0;
        } else if (creep.memory.state === STATE.DELIVERING && creep.store.getUsedCapacity() === 0) {
            // logger.debug(`Mule ${creep.name} inventory empty, switching to COLLECTING`);
            creep.memory.state = STATE.COLLECTING;
            creep.memory.currentTaskIndex = 0;
        }

        // Initialize tasks from templates if not set
        if (!creep.memory.collectTasks && creep.memory.collectTemplates) {
            const templates = creep.memory.collectTemplates;
            logger.debug(`Mule ${creep.name} initializing collect tasks: ${JSON.stringify(templates)}`);
            creep.memory.collectTasks = [...templates];
        }
        if (!creep.memory.deliverTasks && creep.memory.deliverTemplates) {
            const templates = creep.memory.deliverTemplates;
            logger.debug(`Mule ${creep.name} initializing deliver tasks: ${JSON.stringify(templates)}`);
            creep.memory.deliverTasks = [...templates];
        }

        // State machine logic
        switch (creep.memory.state) {
            case STATE.IDLE:
                this.handleIdleState(creep);
                break;
            case STATE.COLLECTING:
                this.handleCollectingState(creep);
                break;
            case STATE.DELIVERING:
                this.handleDeliveringState(creep);
                break;
        }
    },

    handleIdleState: function(creep) {
        if (creep.store.getFreeCapacity() > 0 && creep.memory.collectTasks.length > 0) {
            creep.memory.state = STATE.COLLECTING;
        } else if (creep.store.getUsedCapacity() > 0 && creep.memory.deliverTasks.length > 0) {
            creep.memory.state = STATE.DELIVERING;
        }
    },

    handleCollectingState: function(creep) {
        const tasks = creep.memory.collectTasks;
        if (!tasks || tasks.length === 0) {
            logger.warn(`Mule ${creep.name} has no collect tasks, returning to IDLE`);
            creep.memory.state = STATE.IDLE;
            return;
        }

        const taskIndex = creep.memory.currentTaskIndex || 0;
        const task = tasks[taskIndex];
        
        let success = false;
        if (task.type === 'entity') {
            success = this.collectFromEntity(creep, task);
        } else if (task.type === 'area') {
            success = this.collectFromArea(creep, task);
        }

        if (success) {
            // Move to next task
            creep.memory.currentTaskIndex = (taskIndex + 1) % tasks.length;
        }
    },

    handleDeliveringState: function(creep) {
        const tasks = creep.memory.deliverTasks;
        if (!tasks || tasks.length === 0) {
            logger.warn(`Mule ${creep.name} has no deliver tasks, returning to IDLE`);
            creep.memory.state = STATE.IDLE;
            return;
        }

        const taskIndex = creep.memory.currentTaskIndex || 0;
        const task = tasks[taskIndex];

        let success = false;
        if (task.type === 'entity') {
            success = this.deliverToEntity(creep, task);
        } else if (task.type === 'area') {
            success = this.deliverToArea(creep, task);
        }

        if (success) {
            // Move to next task
            creep.memory.currentTaskIndex = (taskIndex + 1) % tasks.length;
        }
    },

    collectFromEntity: function(creep, task) {
        const structure = Game.getObjectById(task.id);
        if (!structure) {
            logger.warn(`Mule ${creep.name} target structure ${task.id} not found`);
            return false;
        }

        if (creep.pos.getRangeTo(structure) > 1) {
            creep.moveTo(structure);
            return false;
        }

        const result = creep.withdraw(structure, task.resourceType || RESOURCE_ENERGY);
        if (result !== OK) {
            logger.debug(`Mule ${creep.name} withdraw result: ${result}`);
        }
        return result === OK;
    },

    collectFromArea: function(creep, task) {
        const pos = new RoomPosition(task.pos.x, task.pos.y, creep.room.name);
        let targets = [];

        if (task.entityType === 'ground') {
            targets = pos.findInRange(FIND_DROPPED_RESOURCES, task.range);
            targets.sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));

            // logger.debug(`Mule ${creep.name} found ${targets.length} dropped resources in range ${task.range}`);
        } else if (task.entityType === 'structure') {
            targets = pos.findInRange(FIND_STRUCTURES, task.range, {
                filter: (structure) => {
                    return task.structureTypes.includes(structure.structureType) &&
                           structure.store.getUsedCapacity(task.resourceType || RESOURCE_ENERGY) > 0;
                }
            });
            // Sort by distance to creep
            targets.sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
            logger.debug(`Mule ${creep.name} found ${targets.length} structures with resources`);
        }

        if (targets.length === 0) return false;

        const target = targets[0];
        if (creep.pos.getRangeTo(target) > 1) {
            creep.moveTo(target);
            return false;
        }

        let result;
        if (task.entityType === 'ground') {
            result = creep.pickup(target);
        } else {
            result = creep.withdraw(target, task.resourceType || RESOURCE_ENERGY);
        }
        if (result !== OK) {
            logger.debug(`Mule ${creep.name} collect result: ${result}`);
        }
        return result === OK;
    },

    deliverToEntity: function(creep, task) {
        const target = Game.getObjectById(task.id);
        if (!target) {
            logger.warn(`Mule ${creep.name} target entity ${task.id} not found`);
            return false;
        }

        if (creep.pos.getRangeTo(target) > 1) {
            creep.moveTo(target);
            return false;
        }

        const result = creep.transfer(target, task.resourceType || RESOURCE_ENERGY);
        if (result !== OK) {
            // logger.debug(`Mule ${creep.name} transfer result: ${result}`);
        }
        return result === OK;
    },

    deliverToArea: function(creep, task) {
        const pos = new RoomPosition(task.pos.x, task.pos.y, creep.room.name);
        let targets = [];

        if (task.entityType === 'ground') {
            if (creep.pos.getRangeTo(pos) > task.range) {
                creep.moveTo(pos);
                return false;
            }
            const result = creep.drop(task.resourceType || RESOURCE_ENERGY);
            if (result !== OK) {
                logger.debug(`Mule ${creep.name} drop result: ${result}`);
            }
            return result === OK;
        } else if (task.entityType === 'structure') {
            targets = pos.findInRange(FIND_STRUCTURES, task.range, {
                filter: (structure) => {
                    return task.structureTypes.includes(structure.structureType) &&
                           structure.store.getFreeCapacity(task.resourceType || RESOURCE_ENERGY) > 0;
                }
            });
            // Sort by distance to creep
            targets.sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
            // logger.debug(`Mule ${creep.name} found ${targets.length} structures for delivery`);
        } else if (task.entityType === 'creep') {
            targets = pos.findInRange(FIND_MY_CREEPS, task.range, {
                filter: (creep) => {
                    return (!task.roles || task.roles.includes(creep.memory.role)) &&
                           creep.store.getFreeCapacity(task.resourceType || RESOURCE_ENERGY) > 0;
                }
            });
            logger.debug(`Mule ${creep.name} found ${targets.length} creeps for delivery`);
        }

        if (targets.length === 0) return false;

        const target = targets[0];
        if (creep.pos.getRangeTo(target) > 1) {
            creep.moveTo(target);
            return false;
        }

        const result = creep.transfer(target, task.resourceType || RESOURCE_ENERGY);
        if (result !== OK) {
            logger.debug(`Mule ${creep.name} transfer result: ${result}`);
        }
        return result === OK;
    }
};

module.exports = roleMule;