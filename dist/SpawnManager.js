const CreepPlanner = require("./CreepPlanner")
const Consumer = require("./Consumer")
const QueuedCreep = require("./creepUtils").QueuedCreep
const SourceManager = require("./SourceManager")
const DeliveryManager = require("./DeliveryManager")
const Manager = require("./Manager");
const logger = require("./logger")

module.exports = class SpawnManager extends Manager {
    /** @param {Room} room */
    constructor(room, parent) {
        super(room, parent)

        if(this.name in Memory.managers) {
            this.load()
            return
        }

        this.priority = 5
        this.queue = []
        this.spawn = room.find(FIND_MY_SPAWNS)[0]
    }

    get name() {
        return this.room.name + "_SpnM"
    }

    get energyNeeded() {
        const deliveryManager = DeliveryManager.cache[DeliveryManager.name(this.room)]

        let queueCost = 0
        this.queue.forEach(creep => queueCost += creep.cost)

        return queueCost - this.room.energyAvailable - deliveryManager.pendingEnergy(this.name)
    }

    load() {
        this.priority = Memory.managers[this.name].priority
        this.queue = Memory.managers[this.name].queue
        this.spawn = Game.getObjectById(Memory.managers[this.name].spawn)
    }

    save() {
        Memory.managers[this.name] = {
            priority: this.priority,
            queue: this.queue,
            spawn: this.spawn.id,
            energyNeeded: this.energyNeeded
        }
    }

    rulesTemplate() {
        return {
            priority: 6,
            producers: [SourceManager]
        }
    }

    get pos() {
        return this.spawn.pos
    }

    destination() {

        /** @type Array.<StructureSpawn> */
        const spawnList = this.room.find(FIND_MY_SPAWNS);

        if(spawnList.length == 0) {
            return
        }

        for(const spawn of spawnList) {
            if(spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                return {
                    "type": "structure",
                    "id": spawn.id
                }
            }
        }

        const extList = this.room.find(FIND_MY_STRUCTURES,
            {filter: (s) => s.structureType == STRUCTURE_EXTENSION});

        for(const extension of extList) {
            if(extension.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                return {
                    "type": "structure",
                    "id": extension.id
                }
            }
        }


        return {
            "type": "wait",
            "pos": spawnList[0].pos,
            "range": 2,
            "time": 10
        }

    }

    creepNeeded() {
        return null
    }

    /** @return {QueuedCreep} */
    queueCreep(role, memory = {}) {
        //check stall condition
        let stalled = false

        for(const mng of this.parent.sourceManagers) {
            if(mng.creepOwner.creeps.length == 0) {
                stalled = true
            }
        }

        let capacity = this.room.energyCapacityAvailable

        // if(stalled) {
        //     this.queue = [] /// !!! wont work!
        //     capacity = 300
        // }


        const creepTemplate = CreepPlanner.calculateCreep(role, this.room.energyCapacityAvailable)
        const queuedCreep = new QueuedCreep(creepTemplate.memory.role + Memory.creepId,
            Object.assign(creepTemplate.memory, memory), creepTemplate.parts, creepTemplate.cost)
        if(queuedCreep.name == "harvester0") {
            queuedCreep.parts = [WORK, MOVE]
            queuedCreep.cost = 150
            queuedCreep.memory.efficiency = 1
        }
        else if(queuedCreep.name == "mule1") {
            queuedCreep.parts = [CARRY, CARRY, MOVE]
            queuedCreep.cost = 150
            queuedCreep.memory.efficiency = 2
        }
        Memory.creepId++
        this.queue.push(queuedCreep)
        return queuedCreep
    }

    run() {
        logger.trace("SpawnManager.run()")
        for(const [name, mng] of this.parent.managers) {
            if(mng.features.has("CreepOwner")) {
                // logger.debug(mng.name)
                mng.creepOwner.creepsQueued = mng.creepOwner.creepsQueued.filter(creep => {
                    for(const creep2 of this.queue) {
                        if(creep.name == creep2.name) {
                            return true
                        }
                    }
                    return false
                }, this)
            }
        }

        if((this.queue.length > 0) && (this.spawn.spawnCreep(this.queue[0].parts, "dry_run" + Memory.creepId, {dryRun: true}) == OK)) {
            const creepTemplate = this.queue.shift();
            this.spawn.spawnCreep(creepTemplate.parts, creepTemplate.name, {memory: creepTemplate.memory});
        }

        // else {
        //     console.log(this.queue[0].parts instanceof Array)
        //     const test = Array.from(this.queue[0].parts)
        //     console.log(test[1] instanceof Array)
        //     console.log([MOVE, WORK, WORK][2] === test[2])
        //     console.log(this.spawn.spawnCreep(new Array(MOVE, WORK, WORK), "123456", {dryRun: true}))
        // }
        logger.trace("SpawnManager.run() end")
    }
}
