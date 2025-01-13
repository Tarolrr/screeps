const logger = require('./logger');
const resourceManager = require('./resourceManager');

const STATE = {
    IDLE: 'IDLE',
    COLLECTING: 'COLLECTING',
    BUILDING: 'BUILDING'
};

function collectFromTask(creep, task) {
    const muleRole = require('./role.mule');
    return muleRole.collectFromArea(creep, task);
}

/** @param {Creep} creep **/

function run(creep) {
    if (creep.spawning) {
        logger.debug(`Builder ${creep.name} is spawning`);
        return;
    }

    // Initialize state if needed
    if (!creep.memory.state) {
        logger.debug(`Builder ${creep.name} initializing state to IDLE`);
        creep.memory.state = STATE.IDLE;
    }

    // Switch tasks if needed
    if (creep.memory.state === STATE.COLLECTING && creep.store.getFreeCapacity() === 0) {
        // logger.debug(`Builder ${creep.name} inventory full, switching to BUILDING`);
        creep.memory.state = STATE.BUILDING;
    } else if (creep.memory.state === STATE.BUILDING && creep.store.getUsedCapacity() === 0) {
        // logger.debug(`Builder ${creep.name} inventory empty, switching to COLLECTING`);
        creep.memory.state = STATE.COLLECTING;
    }

    // Initialize tasks from templates if not set
    if (!creep.memory.collectTasks && creep.memory.collectTemplates) {
        const templates = creep.memory.collectTemplates;
        logger.debug(`Builder ${creep.name} initializing collect tasks: ${JSON.stringify(templates)}`);
        creep.memory.collectTasks = [...templates];
    }

    // State machine logic
    switch (creep.memory.state) {
        case STATE.IDLE:
            handleIdleState(creep);
            break;
        case STATE.COLLECTING:
            handleCollectingState(creep);
            break;
        case STATE.BUILDING:
            handleBuildingState(creep);
            break;
    }
}

function handleIdleState(creep) {
    const constructionSite = findHighestPrioritySite(creep);
    if (constructionSite) {
        logger.debug(`Builder ${creep.name} found construction site, switching to COLLECTING`);
        creep.memory.targetSiteId = constructionSite.id;
        creep.memory.state = STATE.COLLECTING;
    } else {
        // logger.debug(`Builder ${creep.name} no construction sites found, staying IDLE`);
    }
}

function handleCollectingState(creep) {
    const tasks = creep.memory.collectTasks;
    if (!tasks || tasks.length === 0) {
        logger.warn(`Builder ${creep.name} has no collect tasks, returning to IDLE`);
        creep.memory.state = STATE.IDLE;
        return;
    }

    const taskIndex = creep.memory.currentTaskIndex || 0;
    const task = tasks[taskIndex];

    const success = collectFromTask(creep, task);
    if (success) {
        // Move to next task
        creep.memory.currentTaskIndex = (taskIndex + 1) % tasks.length;
    }
}

function handleBuildingState(creep) {
    // Try to use existing target
    let target = null;
    if (creep.memory.targetSiteId) {
        target = Game.getObjectById(creep.memory.targetSiteId);
        if (!target) {
            // Target no longer exists, clear it and find new one
            delete creep.memory.targetSiteId;
            target = findHighestPrioritySite(creep);
            if (target) {
                creep.memory.targetSiteId = target.id;
            }
        }
    } else {
        target = findHighestPrioritySite(creep);
        if (target) {
            creep.memory.targetSiteId = target.id;
        }
    }

    if (target) {
        if (creep.build(target) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' } });
        }
    } else {
        logger.debug(`Builder ${creep.name} no construction sites found, switching to IDLE`);
        delete creep.memory.targetSiteId;
        creep.memory.state = STATE.IDLE;
    }
}

function findHighestPrioritySite(creep) {
    const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) return null;

    // Get construction orders for this room
    const orders = resourceManager.getResourcesOfType('constructionOrder')
        .filter(order => order.roomName === creep.room.name)
        .sort((a, b) => b.priority - a.priority);

    // Create a map of site IDs to their priorities
    const sitePriorities = {};
    for (const order of orders) {
        if (!order.constructionSites) continue;
        for (const [index, siteId] of Object.entries(order.constructionSites)) {
            sitePriorities[siteId] = {
                priority: order.priority,
                posIndex: parseInt(index)
            };
        }
    }

    // Sort sites by priority and distance
    sites.sort((a, b) => {
        const priorityA = sitePriorities[a.id] ? sitePriorities[a.id].priority : 0;
        const priorityB = sitePriorities[b.id] ? sitePriorities[b.id].priority : 0;
        if (priorityA !== priorityB) return priorityB - priorityA;
        
        // If same priority, prefer closer sites
        const distA = creep.pos.getRangeTo(a);
        const distB = creep.pos.getRangeTo(b);
        return distA - distB;
    });

    return sites[0];
}

const roleBuilder = {
    run: run
};

module.exports = roleBuilder;
