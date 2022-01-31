const harvestPlanner = require('./room.harvestPlanner');
const CreepTemplate = require("./creepUtils").CreepTemplate
module.exports = class CreepPlanner {

    /** @return {CreepTemplate} */

    static calculateCreep(role, maxCost) {
        let costLeft = maxCost

        const roleTemplate = CreepPlanner.roles[role]
        const parts = []
        if(roleTemplate.parts.const) {
            let constCost = 0
            roleTemplate.parts.const.forEach((part, idx, arr) => {
                constCost += BODYPART_COST[part]
            })
            if(maxCost < constCost) {
                return null
            }

            parts.push(...roleTemplate.parts.const)
            costLeft -= constCost
        }



        if(roleTemplate.parts.ratio) {
            let scaleRequiredCost = 0

            Object.entries(roleTemplate.parts.ratio).filter(([_, num]) => num >= 1).forEach(([part, num]) => {
                scaleRequiredCost += BODYPART_COST[part] * num
            })
            if(costLeft < scaleRequiredCost) {
                return null
            }

            const scaleRequired = Math.floor(costLeft / scaleRequiredCost)

            costLeft -= scaleRequiredCost * scaleRequired

            const scaleRequiredParts = []

            Object.entries(roleTemplate.parts.ratio).forEach(([p,n]) =>
                scaleRequiredParts.push(...new Array(n).fill(p)))

            const parts1 = []

            for(let i = 0; i < scaleRequired; i++) {
                parts1.push(...scaleRequiredParts)
            }

            parts.push(...parts1)
        }

        const memory = roleTemplate.memoryFun(parts)
        memory.role = role

        return new CreepTemplate(maxCost - costLeft, memory, parts)

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

module.exports.roles = {
    harvester: {
        parts: {
            const: [MOVE],
            ratio: {
                [WORK]: 1
            }
        },
        memoryFun: function(parts) {
            return {
                efficiency: parts.filter(part => part == WORK).length
            }
        }
    },
    mule: {
        parts: {
            ratio: {
                [CARRY]: 2,
                [MOVE]: 1
            }
        },
        memoryFun: function(parts) {
            return {
                state: "collect",
                efficiency: parts.filter(part => part == CARRY).length
            }
        }
    },
    upgrader: {
        parts: {
            const: [MOVE, CARRY],
            ratio: {
                [WORK]: 1
            }
        },
        memoryFun: (parts) => {return {state: "collect"}}
    },
    builder: {
        parts: {
            const: [MOVE],
            ratio: {
                [WORK]: 1,
                [CARRY]: 1,
                [MOVE]: 0.5
            }
        },
        memoryFun: (parts) => {return {state: "collect"}}
    },
    repairer: {
        parts: {
            const: [MOVE],
            ratio: {
                [WORK]: 1,
                [CARRY]: 1,
                // [MOVE]: 0.5
            }
        },
        memoryFun: (parts) => {return {state: "collect"}}
    },
}
