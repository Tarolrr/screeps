const SourceDesc = require('./SourceDesc');
const ProducerMixin = require("./Producer").ProducerMixin
const Producer = require("./Producer").Producer
const QueuedCreep = require("./creepUtils").QueuedCreep

module.exports = class SourceManager extends ProducerMixin(Object) {

    static cache = {}

    static name(room, source) {
        return room.name + "_SrcM" + source.pos.x + "." + source.pos.y
    }

    /** @param {Room} room
     *  @param {Source} source*/
    constructor(room, source, parent) {
        super()

        this.parent = parent
        this.room = room
        this.source = source
        SourceManager.cache[SourceManager.name(room, source)]
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
        this.creeps = []
        /** @type Array.<Creep> */
        // this.mules = []
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
        this.creeps =       Memory.managers[this.name].creeps.map(creep => Game.creeps[creep]).filter(creep => creep != undefined)
        // this.mules =        Memory.managers[this.name].mules.map(creep => Game.creeps[creep])
        this.source =       Game.getObjectById(Memory.managers[this.name].source)
        this.creepsQueued = Memory.managers[this.name].creepsQueued
    }

    save() {
        Memory.managers[this.name] = {
            workPlaces:     this.workPlaces,
            freePlaces:     this.freePlaces,
            needWork:       this.needWork,
            hasWork:        this.hasWork,
            creeps:         this.creeps.map(creep => creep.name),
            // mules:          this.mules.map(creep => creep.name),
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

        const containers = this.source.pos.findInRange(FIND_STRUCTURES, 1, {filter: str => str.structureType == STRUCTURE_CONTAINER})
        if(containers.length > 0) {
            this.energyAvailable += containers[0].store.getUsedCapacity(RESOURCE_ENERGY)
        }

        const resources = this.source.pos.findInRange(FIND_DROPPED_RESOURCES, 1)

        for(const res of resources) {
            this.energyAvailable += res.amount
        }
    }

    get pos() {
        return this.source.pos
    }

    destination() {

        this.energyAvailable = 0

        const containers = this.source.pos.findInRange(FIND_STRUCTURES, 1, {filter: str => str.structureType == STRUCTURE_CONTAINER})
        if(containers.length > 0) {
            // TODO take energy from container
        }

        const resources = this.source.pos.findInRange(FIND_DROPPED_RESOURCES, 1)
        resources.sort((a, b) => b.amount - a.amount)
        if(resources.length > 0) {
            return {
                "type": "resource",
                "pos": resources[0].pos
            }
        }
        else {
            return {
                "type": "wait",
                "pos": this.source.pos,
                "range": 2,
                "time": 10
            }
        }
    }

    // will be called by RoomManager
    creepNeeded() {
        if((this.freePlaces > 0) && (this.hasWork < this.needWork)) {
            // request harvester of maximum practical size
            return {
                role: "harvester",
                memory: {
                    assignedSource: this.source.id
                },
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

    /** @param {QueuedCreep} queuedCreep*/
    addCreep(queuedCreep) {
        this.creepsQueued.push(queuedCreep)
        if(queuedCreep.memory.role == "harvester") {
            this.freePlaces--
            this.hasWork += queuedCreep.memory.efficiency
        }
    }

    run() {
        this.creepsQueued.forEach(creep => {
            if(creep.name in Game.creeps) {this.creeps.push(Game.creeps[creep.name])}
        })
        // check if all creeps are alive
        // this.creeps = this.creeps.filter(creep => creep in Game.creeps)
        this.creepsQueued = this.creepsQueued.filter(creep => !(creep.name in Game.creeps))

        this.hasWork = 0
        const harvesters = this.creeps.concat(this.creepsQueued).filter(creep => creep.memory.role == "harvester")
        harvesters.forEach(creep => this.hasWork += creep.memory.efficiency)
        this.freePlaces = this.workPlaces.length - harvesters.length

        // while((this.freePlaces > 0) && (this.hasWork < this.needWork)) {
        //     const roomManager = this.parent
        //     //TODO change to `assignedManager`
        //     // const queuedCreep = roomManager.spawnManager.queueCreep("harvester", {assignedSource: this.source.id})
        //     // if(queuedCreep != null) {
        //     //     this.creepsQueued.push(queuedCreep)
        //     //     this.freePlaces--
        //     //     this.hasWork += queuedCreep.memory.efficiency
        //     // }
        //
        // }
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
