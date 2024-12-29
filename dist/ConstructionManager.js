const CreepOwner = require("./CreepOwner")
const Manager = require("./Manager");
const Logger = require("./logger");

module.exports = class ConstructionManager extends Manager {
    /** @param {Room} room */
    constructor(room, parent) {
        super(room, parent)
        this.creepOwner = new CreepOwner(this)

        if(this.name in Memory.managers) {
            this.load()
            return
        }

        this.priority = 3
        this.queue = []
        this.pos = this.controller.pos
        this.deliveries = new Map()
    }

    get features() {
        return new Set(["CreepOwner"])
    }

    get name() {
        return this.room.name + "_ConstructionManager"
    }

    load() {
        const managerMemory = Memory.managers[this.name]
        this.creepOwner.load(managerMemory)

        this.priority = Memory.managers[this.name].priority
        this.priority = Memory.managers[this.name].queue
        this.pos = new RoomPosition(Memory.managers[this.name].pos.x, Memory.managers[this.name].pos.y, this.room.name)
    }

    save() {
        Memory.managers[this.name] = {
            priority: this.priority,
            energyNeeded: this.energyNeeded,
            pos: this.pos,
            queue: this.queue
        }
        this.creepOwner.save(Memory.managers[this.name])
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


        for(let x = 4; x <= 46; x+=7) {

        }
    }

    creepNeeded() {
        logger.debug("ConstructionManager.creepNeeded: started")
        if((this.availableEnergy / 500) > this.creepOwner.creeps.concat(this.creepOwner.creepsQueued).length) {
            logger.debug("ConstructionManager.creepNeeded: ordering a builder")
            return {
                role: "builder",
                memory: {},
                priority: 4
            }
        }
        return null
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

    queueConstructionSite() {
        // process extensions
        this.queueExtension()
    }

    queueExtension() {
        const builtExtensions = this.room.find(FIND_MY_STRUCTURES, {filter: {structureType: STRUCTURE_EXTENSION}})
        const queuedExtensions = this.room.find(FIND_MY_CONSTRUCTION_SITES, {filter: {structureType: STRUCTURE_EXTENSION}})
        let skip = 0
        if(CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][this.room.controller.level] > builtExtensions.length + queuedExtensions.length) {
            let pos = true
            while(pos) {
                const pos = this.findExtensionPos(skip)
                if(this.room.createConstructionSite(pos, STRUCTURE_EXTENSION) != OK) {
                    skip++
                }
            }
        }
    }

    findExtensionPos(skip = 0) {
        let spawnPosition = this.room.find(FIND_MY_SPAWNS)[0].pos
        for(let range = 1; range <= 6; range++) {
            for(let idx = 0; idx < range * 4; idx++) {
                const pos = {x: 0, y: 0}
                if(idx < range) {
                    pos.x = (idx % range) * 2 - range
                    pos.y = -range
                }
                else if(idx < range * 2) {
                    pos.x = range
                    pos.y = (idx % range) * 2 - range
                }
                else if(idx < range * 3) {
                    pos.x = range - (idx % range) * 2
                    pos.y = range
                }
                else {
                    pos.x = -range
                    pos.y = range - (idx % range) * 2
                }
            }
            const roomPos = this.room.getPositionAt(spawnPosition.x + pos.x, spawnPosition.y + pos.t)
            if((roomPos.lookFor(LOOK_TERRAIN)[0] != 'wall') && !roomPos.lookFor(LOOK_STRUCTURES) && !roomPos.lookFor(LOOK_CONSTRUCTION_SITES)) {
                if(skip-- > 0) {
                    continue
                }
                return roomPos
            }
        }
        return null
    }

    run() {
        this.queue = this.queue.filter(obj => new RoomPosition(obj.pos.x, obj.pos.y, this.room.name).lookFor(LOOK_CONSTRUCTION_SITES))
        this.creepOwner.run()
        this.queueConstructionSite()
    }

}
