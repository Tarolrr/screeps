const SourceDesc = require('./SourceDesc');
const Producer = require("./Producer")

module.exports = class SourceManager extends Producer(Object) {
    /** @param {Room} room
     *  @param {Source} source*/
    constructor(room, source, parent) {
        super()

        this.parent = parent
        this.room = room
        this.source = source
        if(this.name in Memory.managers) {
            this.load()
            return
        }

        this.workPlaces = []
        const terrain = room.getTerrain();
        for(let x = source.pos.x - 1; x <= source.pos.x + 1; x++){
            for(let y = source.pos.y - 1; y <= source.pos.y + 1; y++){
                if((x == source.pos.x) && (y == source.pos.y)){
                    continue;
                }
                if(terrain.get(x, y) != TERRAIN_MASK_WALL){
                    this.workPlaces.push({x: x, y: y})
                }
            }
        }

        this.freePlaces = this.workPlaces.length;
        this.needWork = Math.ceil(source.energyCapacity / 300 / 2);
        this.hasWork = 0;
        /** @type Array.<Creep> */
        this.harvesters = []
        /** @type Array.<Creep> */
        this.mules = []
        /** @type Array.<QueuedCreep> */
        this.creepsQueued = []
        // const spawn = source.room.find(FIND_MY_SPAWNS)[0];
        // this.timeTo = PathFinder.search(spawn.pos, {pos: source.pos, range: 1}).cost;
        //
        // this.needCarry = this.timeTo * 2 /                 // round-trip time
        //     50 *                                        // one CARRY part capacity
        //     (source.energyCapacity / ENERGY_REGEN_TIME) * 3;// source energy per second capacity
        // this.hasCarry = 0;
        // this.srcId = source.id;
    }

    load() {
        this.workPlaces =   Memory.managers[this.name].workPlaces
        this.freePlaces =   Memory.managers[this.name].freePlaces
        this.needWork =     Memory.managers[this.name].needWork
        this.hasWork =      Memory.managers[this.name].hasWork
        this.harvesters =   Memory.managers[this.name].harvesters.map(creep => Game.creeps[creep])
        this.mules =        Memory.managers[this.name].mules.map(creep => Game.creeps[creep])
        this.creepsQueued = Memory.managers[this.name].creepsQueued
    }

    save() {
        Memory.managers[this.name] = {
            workPlaces:     this.workPlaces,
            freePlaces:     this.freePlaces,
            needWork:       this.needWork,
            hasWork:        this.hasWork,
            harvesters:     this.harvesters.map(creep => creep.name),
            mules:          this.mules.map(creep => creep.name),
            creepsQueued:   this.creepsQueued,
            source:         this.source.id,
            room:           this.room.name
        }
    }

    get name() {
        return this.room.name + "_SrcM" + this.source.pos.x + "." + this.source.pos.y
    }

    get energyRate() {
        const maxCapacity =  this.source.energyCapacity / ENERGY_REGEN_TIME
        let workRatio = this.hasWork / this.needWork
        workRatio = workRatio > 1 ? 1 : workRatio
        return maxCapacity * workRatio
    }

    get availableEnergy() {
        this.energyAvailable = 0

        Object.setPrototypeOf(this.source.pos, RoomPosition)
        const containers = this.source.pos.findInRange(FIND_STRUCTURES, 1, {filter: str => str.structureType == STRUCTURE_CONTAINER})
        if(containers.length > 0) {
            this.energyAvailable += containers[0].store.getUsedCapacity(RESOURCE_ENERGY)
        }

        const resources = this.source.pos.findInRange(FIND_DROPPED_RESOURCES, 1)

        for(const res of resources) {
            this.energyAvailable += res.amount
        }
    }

    // will be called by RoomManager
    queueCreep() {
        if((this.freePlaces > 0) && (this.hasWork < this.needWork)) {
            // request harvester of maximum practical size
            return {
                role: "harvester",
                priority: 5
            }
            // TODO add has work
        }
        return null
        // const roomManager = this.parent
        // TODO change to `assignedManager`
        // const queuedCreep = roomManager.spawnManager.queueCreep("harvester", {assignedSource: this.source.id})
        // if(queuedCreep != null) {
        //     this.creepsQueued.push(queuedCreep)
        //     this.freePlaces--
        //     this.hasWork += queuedCreep.memory.efficiency
        // }
    }

    run() {

        this.creepsQueued.forEach(val => {
            if(val.name in Game.creeps) {this.creeps[val.name] = Game.creeps[val.name]}
        })
        // check if all creeps are alive
        this.creeps = this.creeps.filter(value => Game.creeps.keys().indexOf(value.name) != -1, this)
        this.creepsQueued = this.creepsQueued.filter(value => !(value.name in Game.creeps))

        this.hasWork = 0
        this.creeps.forEach(creep => this.hasWork += creep.memory.effectiveness)
        this.creepsQueued.forEach(creep => this.hasWork += creep.memory.efficiency)
        this.freePlaces = this.workPlaces.length - this.creeps.length - this.creepsQueued.length

        while((this.freePlaces > 0) && (this.hasWork < this.needWork)) {
            const roomManager = this.parent
            //TODO change to `assignedManager`
            // const queuedCreep = roomManager.spawnManager.queueCreep("harvester", {assignedSource: this.source.id})
            // if(queuedCreep != null) {
            //     this.creepsQueued.push(queuedCreep)
            //     this.freePlaces--
            //     this.hasWork += queuedCreep.memory.efficiency
            // }

        }
    }
    assignHarvester(creepMemory, room) {
        for(const srcId in room.memory.srcDescs){
            const srcDesc = room.memory.srcDescs[srcId];
            if((srcDesc.freePlaces > 0) && (srcDesc.needWork > srcDesc.hasWork)){
                srcDesc.freePlaces--;
                srcDesc.hasWork += creepMemory.efficiency;
                creepMemory.assigned_source = srcId;
                break;
            }
        }
    }
}

class QueuedCreep {
    constructor(name, effectiveness) {
        this.name = name
        this.effectiveness = effectiveness
    }
}