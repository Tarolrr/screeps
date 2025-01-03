const DeliveryManager = require("./DeliveryManager")
const SourceManager = require("./SourceManager")
const SpawnManager = require("./SpawnManager")
const StorageManager = require("./StorageManager")
const ControllerManager = require("./ControllerManager")
const logger = require("./logger")

module.exports = class RoomManager {
    /** @param {Room} room */

    constructor(room) {
        this.managers = new Map()
        if(!("managers" in Memory)){
            Memory.managers = {}
        }
        if("wipe" in Memory) {
            Memory.managers = {}
            delete Memory.wipe
        }
        this.spawnManager = new SpawnManager(room, this)
        this.managers.set(this.spawnManager.name, this.spawnManager)
        this.storageManager = new StorageManager(room, this.spawnManager.spawn.pos, this)
        this.managers.set(this.storageManager.name, this.storageManager)
        this.controllerManager = new ControllerManager(room, this)
        this.managers.set(this.controllerManager.name, this.controllerManager)

        /** @type Array.<SourceManager> */
        this.sourceManagers = []

        /** @type Array.<Source> */
        const sourcesList = room.find(FIND_SOURCES)
        sourcesList.forEach(source => {
            const sourceManager = new SourceManager(room, source, this)
            this.sourceManagers.push(sourceManager)
            this.managers.set(sourceManager.name, sourceManager)
        })
        this.deliveryManager = new DeliveryManager(room, this)
        this.managers.set(this.deliveryManager.name, this.deliveryManager)

        this.room = room
        if(this.name in Memory.managers) {
            this.load()
            return
        }

        this.deliveryManager.addConsumer(this.controllerManager)
        this.deliveryManager.addConsumer(this.spawnManager)
        this.deliveryManager.addConsumer(this.storageManager)
        this.sourceManagers.forEach(sourceManager => {
            this.deliveryManager.registerProducer(sourceManager)
        })
    }

    get name() {
        return this.room.name + "_RM"
    }

    run() {
        logger.trace("RoomManager.run()")
        this.spawnManager.run()
        this.sourceManagers.forEach(srcMng => srcMng.run())
        this.storageManager.run()
        this.deliveryManager.run()
        this.controllerManager.run()
        this.queueCreeps()
        this.save()
        logger.trace("RoomManager.run() end")
    }

    load() {
    }

    queueCreeps() {
        let creepNeeded
        do {
            creepNeeded = null
            let selectedManager
            for(const [name, manager] of this.managers) {
                const tmpCreep = manager.creepNeeded()
                if((tmpCreep) && (!creepNeeded || (tmpCreep.priority > creepNeeded.priority))) {
                    creepNeeded = tmpCreep
                    selectedManager = manager
                }
            }
            if(creepNeeded) {
                const queuedCreep = this.spawnManager.queueCreep(creepNeeded.role, creepNeeded.memory)
                logger.debug(queuedCreep.memory.src + " " + selectedManager.name)
                selectedManager.creepOwner.addCreep(queuedCreep)
            }
        } while(creepNeeded)
    }

    save() {
        Memory.managers[this.name] = {
            room: this.room.name
        }
        this.room.memory.manager = Memory.managers[this.name]
        this.spawnManager.save()
        this.storageManager.save()
        this.deliveryManager.save()
        this.controllerManager.save()

        for(const sourceManager of this.sourceManagers) {
            sourceManager.save()
        }
    }
}