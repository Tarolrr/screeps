const SourceDesc = require('./SourceDesc');
const Consumer = require("./Consumer")
const SourceManager = require("./SourceManager");
const DeliveryManager = require("./DeliveryManager");
const ProducerMixin = require("./Producer").ProducerMixin

module.exports = class StorageManager extends ProducerMixin(Consumer) {
    /** @param {Room} room
     *  @param {RoomPosition} pos */
    constructor(room, pos, parent) {
        super()

        this.parent = parent
        this.room = room
        if(this.name in Memory.managers) {
            this.load()
            return
        }

        this.pos = pos
        /** @type Array.<Creep> */
        this.creeps = []
        /** @type Array.<QueuedCreep> */
        this.creepsQueued = []
    }

    load() {
        this.pos = new RoomPosition(Memory.managers[this.name].pos.x, Memory.managers[this.name].pos.y, this.room.name)
        // Object.setPrototypeOf(this.pos, RoomPosition)
        this.creeps =       Memory.managers[this.name].creeps.map(creep => Game.creeps[creep]).filter(creep => creep != undefined)
        this.creepsQueued = Memory.managers[this.name].creepsQueued
    }

    save() {
        Memory.managers[this.name] = {
            pos: this.pos,
            room: this.room.name,
            energyNeeded: this.energyNeeded,
            creeps:         this.creeps.map(creep => creep.name),
            creepsQueued:   this.creepsQueued,
        }
    }

    get name() {
        return this.room.name + "_StrM"
    }

    rulesTemplate() {
        return {
            priority: 4,
            producers: [SourceManager]
        }
    }

    get energyRate() {
        return 10
    }

    creepNeeded() {
        return null
    }

    destination() {

        //TODO account for StructureContainer

        //TODO account for StructureStorage

        return {
            type: "ground",
            pos: this.pos,
            range: 2
        }
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

        //TODO account for StructureStorage
        const deliveryManager = DeliveryManager.cache[DeliveryManager.name(this.room)]
        return energyAvailable + deliveryManager.pendingEnergy(this.name)
    }

    get energyNeeded() {
        const deliveryManager = DeliveryManager.cache[DeliveryManager.name(this.room)]

        return 1000 - this.availableEnergy - deliveryManager.pendingEnergy(this.name)
    }

    run() {
        if(!(Object.entries(Game.flags) == false )) {
            const [_, storageFlag] = Object.entries(Game.flags).find(([name, flag]) => (flag.room.name == this.room.name) && (name.indexOf("storage") != -1))
            if(storageFlag) {
                this.pos = storageFlag.pos
            }
        }
        return

        /** @type Array.<Source> */
        const sourcesList = room.find(FIND_SOURCES);

        /** @type Object.<string, SourceDesc> */
        room.memory.srcDescs = {};
        for(const src_i in sourcesList){
            const source = sourcesList[src_i];
            room.memory.srcDescs[source.id] = new SourceDesc(source);
        }

        const creepList = room.find(FIND_MY_CREEPS);

        const costMatrix = new PathFinder.CostMatrix;

        const roads = room.find(FIND_STRUCTURES,
            {filter: (s) => s.structureType == STRUCTURE_ROAD});

        for(const iR in roads) {
            const road = roads[iR];
            costMatrix.set(road.pos.x, road.pos.y, 1);
        }

        const strs = room.find(FIND_STRUCTURES,
            {filter: (s) => new Set([STRUCTURE_CONTROLLER, STRUCTURE_STORAGE,
                    STRUCTURE_EXTENSION, STRUCTURE_SPAWN, STRUCTURE_WALL, STRUCTURE_TOWER]).has(s.structureType)});

        for(const iS in strs) {
            const str = strs[iS];
            costMatrix.set(str.pos.x, str.pos.y, 255);
        }

        room.memory.costMatrix = costMatrix.serialize()

        for(const cr_i in creepList){
            const creep = creepList[cr_i];

            // remembering creeps
            if (creep.memory.assigned_source != undefined) {
                if(creep.memory.role == "harvester") {
                    room.memory.srcDescs[creep.memory.assigned_source].freePlaces--;
                    room.memory.srcDescs[creep.memory.assigned_source].hasWork += creep.memory.efficiency;
                }
                else if(creep.memory.role == "mule") {
                    room.memory.srcDescs[creep.memory.assigned_source].hasCarry += creep.memory.efficiency;
                }
            }
        }
        for(const cr_i in creepList){
            const creep = creepList[cr_i];
            if((creep.memory.role == "harvester") && (creep.memory.assigned_source == undefined)){
                for(const srcId in room.memory.srcDescs){
                    const srcDesc = room.memory.srcDescs[srcId];
                    if((srcDesc.freePlaces > 0) && (srcDesc.needWork > 0)){
                        srcDesc.freePlaces--;
                        srcDesc.hasWork += creep.memory.efficiency;
                        creep.memory.assigned_source = srcId;
                        break;
                    }
                }
            }
        }
        for(const cr_i in creepList){
            const creep = creepList[cr_i];
            if((creep.memory.role == "mule") && (creep.memory.assigned_source == undefined)) {
                for(const srcId in room.memory.srcDescs) {
                    const srcDesc = room.memory.srcDescs[srcId];
                    if(srcDesc.availableCarry() > 0) {
                        creep.memory.assigned_source = srcId;
                        srcDesc.hasCarry += creep.memory.efficiency;
                        break;
                    }
                }
            }
        }
    }
}
