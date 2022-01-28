const CreepPlanner = require("./CreepPlanner")
const QueuedCreep = require("./creepUtils").QueuedCreep
const SourceManager = require("./SourceManager")
const DeliveryManager = require("./DeliveryManager")

module.exports = class SpawnManager {
    /** @param {Room} room */
    constructor(room, parent) {
        this.parent = parent
        this.room = room
        if(this.name in Memory.managers) {
            this.load()
            return
        }

        this.priority = 3
        /** @type Array.<Creep> */
        this.creeps = []
    }

    get name() {
        return this.room.name + "_CnstrM"
    }

    get energyNeeded() {
        const deliveryManager = DeliveryManager.cache[DeliveryManager.name(this.room)]

        let queueCost = 0
        this.queue.forEach(creep => queueCost += creep.cost)

        return queueCost - this.room.energyAvailable - deliveryManager.pendingEnergy(this.name)
    }

    load() {
        this.priority = Memory.managers[this.name].priority
        this.creeps = Memory.managers[this.name].creeps.map(creep => Game.creeps[creep]).filter(creep => creep != undefined)
    }

    save() {
        Memory.managers[this.name] = {
            priority: this.priority,
            room: this.room.name,
            creeps: this.creeps.map(creep => creep.name),
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
        if((this.parent.storageManager.availableEnergy / 500) > this.creeps.keys().length) {
            return {
                role: "builder",
                memory: {},
                priority: 4
            }
        }
        return null
    }



    run() {
    }
}
