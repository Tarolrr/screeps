const CreepPlanner = require("./CreepPlanner")
const Consumer = require("./Consumer")
const QueuedCreep = require("./creepUtils").QueuedCreep
const StorageManager = require("./StorageManager")
const DeliveryManager = require("./DeliveryManager")

module.exports = class ControllerManager extends Consumer {
    /** @param {Room} room */
    constructor(room, parent) {
        super()
        this.parent = parent
        this.room = room
        this.controller = room.controller
        if(this.name in Memory.managers) {
            this.load()
            return
        }

        this.priority = 3
        /** @type Array.<Creep> */
        this.creeps = []
        /** @type Array.<QueuedCreep> */
        this.creepsQueued = []
        this.pos = this.controller.pos
    }

    get name() {
        return this.room.name + "_CtrlM"
    }

    load() {
        this.priority = Memory.managers[this.name].priority
        this.pos = new RoomPosition(Memory.managers[this.name].pos.x, Memory.managers[this.name].pos.y, this.room.name)
        this.creeps =       Memory.managers[this.name].creeps.map(creep => Game.creeps[creep]).filter(creep => creep != undefined)
        this.creepsQueued = Memory.managers[this.name].creepsQueued
    }

    save() {
        Memory.managers[this.name] = {
            priority: this.priority,
            energyNeeded: this.energyNeeded,
            pos: this.pos,
            creeps:         this.creeps.map(creep => creep.name),
            creepsQueued:   this.creepsQueued,
        }
    }

    rulesTemplate() {
        return {
            priority: 4,
            producers: [StorageManager]
        }
    }

    destination() {

        return {
            type: "ground",
            pos: this.pos,
            range: 2
        }

    }

    creepNeeded() {
        console.log("test123")
        if((this.availableEnergy / 500) > this.creeps.concat(this.creepsQueued).length) {
            console.log("test123")
            return {
                role: "upgrader",
                memory: {},
                priority: 4
            }
        }
        return null
    }

    /** @param {QueuedCreep} queuedCreep*/
    addCreep(queuedCreep) {
        this.creepsQueued.push(queuedCreep)
    }


    get availableEnergy() {
        let energyAvailable = 0

        const containers = this.pos.findInRange(FIND_STRUCTURES, 2, {filter: str => str.structureType == STRUCTURE_CONTAINER})

        for(const container of containers) {
            energyAvailable +=  container.store.getUsedCapacity(RESOURCE_ENERGY)
        }

        const resources = this.pos.findInRange(FIND_DROPPED_RESOURCES, 2)

        for(const res of resources) {
            energyAvailable += res.amount
        }

        const deliveryManager = DeliveryManager.cache[DeliveryManager.name(this.room)]
        return energyAvailable + deliveryManager.pendingEnergy(this.name)
    }

    get energyNeeded() {
        const deliveryManager = DeliveryManager.cache[DeliveryManager.name(this.room)]

        return 3000 - this.availableEnergy - deliveryManager.pendingEnergy(this.name)
    }

    run() {

        this.creepsQueued.forEach(creep => {
            if(creep.name in Game.creeps) {this.creeps.push(Game.creeps[creep.name])}
        })
        this.creepsQueued = this.creepsQueued.filter(creep => !(creep.name in Game.creeps))
    }
}
