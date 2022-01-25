var roleUpgrader = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(creep.spawning == true) {
            return;
        }
        if(creep.memory.state == "collect") {
            if(creep.store.getFreeCapacity() == 0) {
                creep.memory.state = "upgrade";
            }
            var ctrl = creep.room.controller;
            var res = ctrl.pos.findInRange(FIND_DROPPED_RESOURCES, 5)[0];
            if(res == undefined) {
                return;
            }
            if(creep.pickup(res) == ERR_NOT_IN_RANGE) {
                creep.moveTo(res);
            }
        }
        if(creep.memory.state == "upgrade") {
            if(creep.upgradeController(creep.room.controller) == ERR_NOT_IN_RANGE) {
                creep.moveTo(creep.room.controller);
            }
            if(creep.store.getUsedCapacity() == 0) {
                creep.memory.state = "collect";
            }
        }
	}
};

module.exports = roleUpgrader;