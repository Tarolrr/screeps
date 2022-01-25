const roleBuilder = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(creep.spawning == true) {
            return;
        }
        if(creep.memory.state == "collect") {
            const conts = creep.room.find(FIND_STRUCTURES,
                {filter: (s) => s.structureType == STRUCTURE_CONTAINER});
            
            if(conts.length == 0) {
                const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
                const res = spawn.pos.findInRange(FIND_DROPPED_RESOURCES, 5)[0];
                if(res == undefined) {
                    return;
                }
                if(creep.pickup(res) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(res);
                }
            }
            else {
                for(let c_i = 0; c_i < conts.length; c_i++) {
                    const cont = conts[c_i];
                    if(cont.store.getUsedCapacity() > 0) {
                        if(creep.withdraw(cont, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                            creep.moveTo(cont);
                        }
                    }
                }
            }
            if(creep.store.getFreeCapacity() == 0) {
                creep.memory.state = "build";
            }
        }
        if(creep.memory.state == "build") {
            const con_site = creep.pos.findClosestByRange(FIND_MY_CONSTRUCTION_SITES);
            if(con_site != null) {
                if(creep.build(con_site) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(con_site);
                }
            }
            if(creep.store.getUsedCapacity() == 0) {
                creep.memory.state = "collect";
            }
        }
	}
};

module.exports = roleBuilder;