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
        this.deliveryManager = new DeliveryManager(room, this)
        this.managers[this.deliveryManager.name] = this.deliveryManager

        /** @type Array.<SourceManager> */
        this.sourceManagers = []

        /** @type Array.<Source> */
        const sourcesList = room.find(FIND_SOURCES)
        sourcesList.forEach(source => {
            const sourceManager = new SourceManager(room, source, this)
            this.sourceManagers.push(sourceManager)
            this.managers[sourceManager.name] = sourceManager
        })

        this.room = room
        if(this.name in Memory.managers) {
            this.load()
            return
        }

        this.deliveryManager.addConsumer(this.spawnManager)
    }

    get name() {
        return this.room.name + "_RM"
    }

    run() {
        console.log(this.spawnManager.room)
        this.spawnManager.run()
        this.sourceManagers.forEach(srcMng => srcMng.run())
        this.storageManager.run()
        this.deliveryManager.run()
        this.save()
    }

    load() {
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