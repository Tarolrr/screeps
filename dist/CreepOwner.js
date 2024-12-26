

module.exports = class CreepOwner {
    constructor(manager) {
        this.manager = manager

        /** @type Array.<Creep> */
        this.creeps = []
        // /** @type Array.<QueuedCreep> */
        this.creepsQueued = []
    }

    load(memory) {
        this.creeps = memory.creeps.map(creep => Game.creeps[creep]).filter(creep => creep != undefined)
        this.creepsQueued = memory.creepsQueued
    }

    save(memory) {
        memory.creeps = this.creeps.map(creep => creep.name)
        memory.creepsQueued = this.creepsQueued
    }

    /** @param {QueuedCreep} queuedCreep*/
    addCreep(queuedCreep) {
        this.creepsQueued.push(queuedCreep)

        if(this.manager.addCreep) {
            this.manager.addCreep(queuedCreep)
        }
    }

    run() {
        this.creepsQueued.forEach(creep => {
            if(creep.name in Game.creeps) {this.creeps.push(Game.creeps[creep.name])}
        })
        this.creepsQueued = this.creepsQueued.filter(creep => !(creep.name in Game.creeps))
    }
}