const SourceDesc = require('./SourceDesc');
const CreepPlanner = require("./CreepPlanner")

module.exports = class SpawnPlanner {
    static run() {
        for(const room_name in Game.rooms) {
            const room = Game.rooms[room_name];

            /** @type Array.<StructureSpawn> */
            const spawnList = room.find(FIND_MY_SPAWNS);

            if(spawnList.length == 0) {
                continue
            }

            const extList = room.find(FIND_MY_STRUCTURES,
                {filter: (s) => s.structureType == STRUCTURE_EXTENSION});

            const spawn = spawnList[0];
            spawn.memory.queue = [];

            let capacity = room.energyCapacityAvailable

            /** @type Array.<Creep> */
            const creepList = room.find(FIND_MY_CREEPS);

            const creepCount = {}
            CreepPlanner.roles.keys().forEach(r => {creepCount[r] = 0})

            for(const iC in creepList) {
                const creep = creepList[iC];
                creepCount[creep.memory.role]++
            }

            //process stall condition
            if((creepCount["mule"] == 0) && (creepCount["harvester"] == 0)){
               capacity = room.energyAvailable
            }

            for(const srcId in room.memory.srcDescs) {
                const srcDesc = room.memory.srcDescs[srcId];
                Object.setPrototypeOf( srcDesc, SourceDesc.prototype );
                srcDesc.update()
                let srcDescCopy = Object.assign({}, srcDesc);
                Object.setPrototypeOf( srcDescCopy, SourceDesc.prototype );
                while (((srcDesc.freePlaces > 0) && (srcDescCopy.hasWork < srcDescCopy.needWork)) ||
                      (srcDescCopy.availableCarry() > 0)) {
                    // console.log("avcarry" + srcDescCopy.availableCarry())
                    if(srcDescCopy.availableCarry() > 0) {
                        spawn.memory.queue.push(room.memory.roles.mule)
                        srcDescCopy.hasCarry += room.memory.roles.mule.memory.efficiency;
                    }
                    else {
                        spawn.memory.queue.push(room.memory.roles.harvester);
                        srcDescCopy.hasWork += room.memory.roles.harvester.memory.efficiency;
                        srcDescCopy.freePlaces--;
                    }
                }
            }

        }
            // if(upgCount < 3) {
            //     spawn.memory.queue = spawn.memory.queue.concat(new Array(2 - upgCount).fill(room.memory.roles.upgrader))
            // }
            // if(bldCount < 3) {
            //     spawn.memory.queue = spawn.memory.queue.concat(new Array(2 - bldCount).fill(room.memory.roles.builder))
            // }
            // if(rprCount < 3) {
            //     spawn.memory.queue = spawn.memory.queue.concat(new Array(2 - rprCount).fill(room.memory.roles.repairer))
            // }
    }
}
