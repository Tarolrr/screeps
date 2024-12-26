const SourceDesc = require('./SourceDesc');
const CreepOwner = require("./CreepOwner");
const Manager = require("./Manager");
const ProducerMixin = require("./Producer").ProducerMixin
const Producer = require("./Producer").Producer
const QueuedCreep = require("./creepUtils").QueuedCreep

module.exports = class SourceManager extends Manager {

    // static cache = {}

    static name(room, source) {
        return room.name + "_SrcM" + source.pos.x + "." + source.pos.y
    }

    /** @param {Room} room
     *  @param {Source} source*/
    constructor(room, source, parent) {
        super(room, parent)
        this.creepOwner = new CreepOwner(this)

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
        const managerMemory = Memory.managers[this.name]
        this.creepOwner.load(managerMemory)

        this.workPlaces =   managerMemory.workPlaces
        this.freePlaces =   managerMemory.freePlaces
        this.needWork =     managerMemory.needWork
        this.hasWork =      managerMemory.hasWork
        this.source =       Game.getObjectById(managerMemory.source)
    }

    save() {
        Memory.managers[this.name] = {
            workPlaces:     this.workPlaces,
            freePlaces:     this.freePlaces,
            needWork:       this.needWork,
            hasWork:        this.hasWork,
            source:         this.source.id
        }
        this.creepOwner.save(Memory.managers[this.name])
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
    }

    /** @param {QueuedCreep} queuedCreep*/
    addCreep(queuedCreep) {
        if(queuedCreep.memory.role == "harvester") {
            this.freePlaces--
            this.hasWork += queuedCreep.memory.efficiency
        }
    }

    run() {
        this.creepOwner.run()

        this.hasWork = 0
        const harvesters = this.creepOwner.creeps.concat(this.creepOwner.creepsQueued).filter(creep => creep.memory.role == "harvester")
        harvesters.forEach(creep => this.hasWork += creep.memory.efficiency)
        this.freePlaces = this.workPlaces.length - harvesters.length
    }

}

module.exports.cache = {}