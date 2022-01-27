const CreepPlanner = require("./CreepPlanner")
const Consumer = require("./Consumer")
const QueuedCreep = require("./creepUtils").QueuedCreep

module.exports = class SpawnManager extends Consumer {
    /** @param {Room} room */
    constructor(room, parent) {
        super()
        this.parent = parent
        this.room = room
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
            room: this.room.name
        }
    }

    rulesTemplate() {
        return {
            priority: 6,
            producers: ["SourceManager"],
            addCreepCondition: function() {
                this.parent
            }
        }
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
                    "structure": spawn
                }
            }
        }

        const extList = room.find(FIND_MY_STRUCTURES,
            {filter: (s) => s.structureType == STRUCTURE_EXTENSION});

        for(const extension of extList) {
            if(extension.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                return {
                    "type": "structure",
                    "structure": extension
                }
            }
        }


        return {
            "type": "wait",
            "pos": spawnList[0].pos,
            "range": 2
        }

    }

    creepNeeded() {
        return null
    }

    /** @return {QueuedCreep} */
    queueCreep(role, memory = {}) {
        const creepTemplate = CreepPlanner.calculateCreep(role, this.room.energyCapacityAvailable)
        const queuedCreep = new QueuedCreep(creepTemplate.memory.role + Memory.creepId,
            Object.assign(creepTemplate.memory, memory), creepTemplate.parts)
        Memory.creepId++
        this.queue.push(queuedCreep)
        return queuedCreep
    }

    run() {
        if((this.queue.length > 0) && (this.spawn.spawnCreep(this.queue[0].parts, "dry_run" + Memory.creepId, {dryRun: true}) == OK)) {
            const creepTemplate = this.queue.shift();
            const creepMemory = Object.assign({}, creepTemplate.memory);

            // if(creepMemory.role == "mule") {
            //     harvestPlanner.assignMule(creepMemory, room)
            //     consumptionPlanner.assignMule(creepMemory, room)
            // }
            this.spawn.spawnCreep(creepTemplate.parts, creepTemplate.name, {memory: creepMemory});

        }
    }
}
