const SourceDesc = require('./SourceDesc');

module.exports = {
    run: function() {
        if(Game.time % 100 == 1) {
            for(const room_name in Game.rooms) {
                const room = Game.rooms[room_name];


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
    },
    assignHarvester: function(creepMemory, room) {
        for(const srcId in room.memory.srcDescs){
            const srcDesc = room.memory.srcDescs[srcId];
            if((srcDesc.freePlaces > 0) && (srcDesc.needWork > srcDesc.hasWork)){
                srcDesc.freePlaces--;
                srcDesc.hasWork += creepMemory.efficiency;
                creepMemory.assigned_source = srcId;
                break;
            }
        }
    },
    assignMule: function(creepMemory, room) {
        for(const srcId in room.memory.srcDescs){
            const srcDesc = room.memory.srcDescs[srcId];
            Object.setPrototypeOf( srcDesc, SourceDesc.prototype );
            if(srcDesc.availableCarry() > 0){
                srcDesc.hasCarry += creepMemory.efficiency;
                creepMemory.assigned_source = srcId;
                creepMemory.src = Game.getObjectById(srcId).pos
                break;
            }
        }
    }
};
