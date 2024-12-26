const SourceDesc = require('./SourceDesc');
const Consumer = require("./Consumer")
const SourceManager = require("./SourceManager");
const DeliveryManager = require("./DeliveryManager");
const CreepOwner = require("./CreepOwner");
const Manager = require("./Manager");
const ProducerMixin = require("./Producer").ProducerMixin

module.exports = class StorageManager extends Manager {
    /** @param {Room} room
     *  @param {RoomPosition} pos */
    constructor(room, pos, parent) {
        super(room, parent)
        this.creepOwner = new CreepOwner(this)
        this.pos = pos

        if(this.name in Memory.managers) {
            this.load()
            return
        }

    }

    load() {
        const managerMemory = Memory.managers[this.name]
        this.creepOwner.load(managerMemory)

        this.pos = new RoomPosition(managerMemory.pos.x, managerMemory.pos.y, this.room.name)
    }

    save() {
        Memory.managers[this.name] = {
            pos: this.pos,
            energyRate: this.energyRate,
            energyNeeded: this.energyNeeded,
            availableEnergy: this.availableEnergy
        }
        this.creepOwner.save(Memory.managers[this.name])
    }

    get name() {
        return this.room.name + "_StrM"
    }

    get features() {
        return new Set(["CreepOwner"])
    }

    rulesTemplate() {
        return {
            priority: 4,
            producers: [SourceManager]
        }
    }

    get energyRate() {
        return Math.floor(this.availableEnergy/100)
    }

    creepNeeded() {
        return null
    }

    destination() {

        //TODO account for StructureContainer

        //TODO account for StructureStorage
        console.log("test")
        return {
            type: "ground",
            pos: this.pos,
            range: 2
        }
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

        return 3000 - this.availableEnergy - deliveryManager.pendingEnergy(this.name)
    }

    run() {
        this.creepOwner.run()

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
