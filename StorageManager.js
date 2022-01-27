const SourceDesc = require('./SourceDesc');
const Consumer = require("./Consumer")
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
    }

    load() {
        this.pos = Memory.managers[this.name].pos
        Object.setPrototypeOf(this.pos, RoomPosition)
    }

    save() {
        Memory.managers[this.name] = {
            pos: this.pos,
            room: this.room.name
        }
    }

    get name() {
        return this.room.name + "_StrM"
    }

    rulesTemplate() {
        return {
            priority: 0,
            producers: ["SrcM"]
        }

    }

    get energyRate() {
        return 10
    }

    creepNeeded() {
        return null
    }

    get availableEnergy() {
        this.energyAvailable = 0

        Object.setPrototypeOf(this.pos, RoomPosition)
        const containers = this.pos.findInRange(FIND_STRUCTURES, 2, {filter: str => str.structureType == STRUCTURE_CONTAINER})

        for(const container of containers) {
            this.energyAvailable +=  container.store.getUsedCapacity(RESOURCE_ENERGY)
        }

        const resources = this.source.pos.findInRange(FIND_DROPPED_RESOURCES, 2)

        for(const res of resources) {
            this.energyAvailable += res.amount
        }

        //TODO account for StructureStorage
    }

    run() {

        const [_, storageFlag] = Object.entries(Game.flags).find(([name, flag]) => (flag.room.name == this.room.name) && (name.indexOf("storage") != -1))
        if(storageFlag) {
            this.pos = storageFlag.pos
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
};
