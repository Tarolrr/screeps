const harvestPlanner = require('./room.harvestPlanner');

module.exports = class CreepPlanner {
    static roles = {
        harvester: {
            parts: {
                const: [MOVE],
                ratio: {
                    WORK: 1
                }
            },
            memoryFun: function(parts) {
                //TODO count all work parts and return efficiency: <WORK_PART_COUNT>
                let efficiency = 0
                parts.forEach((part, idx, arr) => {
                    if(part == WORK) {
                        efficiency++
                    }
                })
                return {"efficiency": efficiency}
            }
        },
        mule: {
            parts: {
                ratio: {
                    CARRY: 2,
                    MOVE: 1
                }
            },
            memoryFun: (parts) => {return {state: "collect"}}
        },
        upgrader: {
            parts: {
                const: [MOVE, CARRY],
                ratio: {
                    WORK: 1
                }
            },
            memoryFun: (parts) => {return {state: "collect"}}
        },
        builder: {
            parts: {
                const: [MOVE],
                ratio: {
                    WORK: 1,
                    CARRY: 1,
                    MOVE: 0.5
                }
            },
            memoryFun: (parts) => {return {state: "collect"}}
        },
        repairer: {
            parts: {
                const: [MOVE],
                ratio: {
                    WORK: 1,
                    CARRY: 1,
                    MOVE: 0.5
                }
            },
            memoryFun: (parts) => {return {state: "collect"}}
        },
    }

    static calculateCreep(role, maxCost) {
        const makeRepeated = (arr, repeats) =>
            Array.from({ length: repeats }, () => arr).flat();

        const roleTemplate = this.roles[role]
        const parts = []
        let constCost = 0
        if(roleTemplate.parts.const) {
            roleTemplate.parts.const.forEach((part, idx, arr) => {
                constCost += BODYPART_COST[part]
            })
        }

        if(maxCost < constCost) {
            return null
        }

        parts.push(...roleTemplate.parts.const)

        let costLeft = maxCost - constCost

        if(roleTemplate.parts.ratio) {
            let scaleRequiredCost = 0
            roleTemplate.parts.ratio.entries().filter(([_, num]) => num >= 1).forEach(([part, num]) => {
                scaleRequiredCost += BODYPART_COST[part] * num
            })

            if(costLeft < scaleRequiredCost) {
                return null
            }

            const scaleRequired = Math.floor(costLeft / scaleRequiredCost)

            costLeft -= scaleRequiredCost * scaleRequired

            const scaleRequiredParts = roleTemplate.parts.ratio.entries().flatMap(
                ([p, n]) => new Array(n).fill(p))

            parts.push(...makeRepeated(scaleRequiredParts, scaleRequired))
        }

        return {
            cost: maxCost - costLeft,
            memory: roleTemplate.memoryFun(parts),
            parts: parts
        }

        // if((roleTemplate.parts.ratio) && (roleTemplate.parts.ratio.values().find((v) => v < 1))){
        //     let scaleFullCost = 0
        //
        //     roleTemplate.parts.ratio.entries().forEach(([part, num]) => {
        //         scaleFullCost += BODYPART_COST[part] * num
        //     })
        //
        //     if(costLeft < scaleFullCost) {
        //         return parts
        //     }
        //
        //     const scaleFull = Math.floor(costLeft / scaleFullCost)
        //
        //     // parts.push(...makeRepeated(roleTemplate.parts.ratio.keys(), scaleFull))
        // }

    }
}
//     {
//     run: function() {
//         if(Game.time % 100 == 1) {
//             for(const room_name in Game.rooms) {
//                 const room = Game.rooms[room_name];
//
//                 if (room.memory.roles == undefined) {
//                     room.memory.roles = {};
//                 }
//
//                 const spawnList = room.find(FIND_MY_SPAWNS);
//                 const extList = room.find(FIND_MY_STRUCTURES,
//                     {filter: (s) => s.structureType == STRUCTURE_EXTENSION});
//
//                 const capacity = spawnList.length * 300 + extList.length * 50;
//                 // console.log(spawnList.length + " " + extList.length + " " + capacity);
//                 //room.memory.roles.capacity = capacity;
//                 let harvesterScale = (capacity - 50) / 100;
//                 harvesterScale = harvesterScale >= 5 ? 5 : Math.floor(harvesterScale);
//                 room.memory.roles.harvester = {
//                     parts: new Array(harvesterScale).fill(WORK).concat([MOVE]),
//                     memory: {role: "harvester", efficiency: harvesterScale},
//                     name: "harvester",
//                     cost: harvesterScale * 100 + 50
//                 }
//
//                 room.memory.roles.upgrader = {
//                     parts: new Array(Math.floor((capacity - 100) / 100)).fill(WORK).concat([MOVE, CARRY]),
//                     memory: {role: "upgrader", state: "collect"},
//                     name: "upgrader",
//                     cost: Math.floor(capacity / 100) * 100
//                 }
//                 const muleScale = Math.floor(capacity / 50 / 3);
//                 room.memory.roles.mule = {
//                     parts: new Array(muleScale * 2).fill(CARRY).concat(new Array(muleScale).fill(MOVE)),
//                     memory: {role: "mule", state: "collect", efficiency: muleScale * 2, stallCtr: 0},
//                     name: "mule",
//                     cost: muleScale * 150
//                 }
//
//                 const builderScale = Math.floor((capacity - 50) / 150);
//                 room.memory.roles.builder = {
//                     parts: new Array(builderScale).fill(CARRY).concat(new Array(builderScale).fill(WORK)).concat([MOVE]),
//                     memory: {role: "builder", state: "collect"},
//                     name: "builder",
//                     cost: builderScale * 150 + 50
//                 }
//                 room.memory.roles.repairer = {
//                     parts: new Array(builderScale).fill(CARRY).concat(new Array(builderScale).fill(WORK)).concat([MOVE]),
//                     memory: {role: "repairer", state: "collect"},
//                     name: "repairer",
//                     cost: builderScale * 150 + 50
//                 }
//             }
//         }
//     }
// };
