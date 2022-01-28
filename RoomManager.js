const DeliveryManager = require("./DeliveryManager")
const SourceManager = require("./SourceManager")
const SpawnManager = require("./SpawnManager")
const StorageManager = require("./StorageManager")

module.exports = class RoomManager {
    /** @param {Room} room */
    constructor(room) {
        this.managers = {}
        this.spawnManager = new SpawnManager(room, this)
        this.managers[this.spawnManager.name] = this.spawnManager
        this.storageManager = new StorageManager(room, this.spawnManager.spawn.pos, this)
        this.managers[this.storageManager.name] = this.storageManager

        /** @type Array.<SourceManager> */
        this.sourceManagers = []

        /** @type Array.<Source> */
        const sourcesList = room.find(FIND_SOURCES)
        sourcesList.forEach(source => {
            const sourceManager = new SourceManager(room, source, this)
            this.sourceManagers.push(sourceManager)
            this.managers[sourceManager.name] = sourceManager
        })
        this.deliveryManager = new DeliveryManager(room, this)
        this.managers[this.deliveryManager.name] = this.deliveryManager

        this.room = room
        if(this.name in Memory.managers) {
            this.load()
            return
        }

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
        this.spawnManager.run()
        this.sourceManagers.forEach(srcMng => srcMng.run())
        this.storageManager.run()
        this.deliveryManager.run()
        this.queueCreeps()
        this.save()
    }

    load() {
    }

    queueCreeps() {
        let creepNeeded
        do {
            creepNeeded = null
            let selectedManager
            for(const [name, manager] of Object.entries(this.managers)) {
                const tmpCreep = manager.creepNeeded()
                if((tmpCreep) && (!creepNeeded || (tmpCreep.priority > creepNeeded.priority))) {
                    creepNeeded = tmpCreep
                    selectedManager = manager
                }
            }
            if(creepNeeded) {
                const queuedCreep = this.spawnManager.queueCreep(creepNeeded.role, creepNeeded.memory)
                selectedManager.addCreep(queuedCreep)
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

        for(const sourceManager of this.sourceManagers) {
            sourceManager.save()
        }
    }
}