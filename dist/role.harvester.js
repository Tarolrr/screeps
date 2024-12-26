var roleHarvester = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(creep.spawning == true) {
            return;
        }
        var source = Game.getObjectById(creep.memory.assignedSource);
        if(source == undefined){
            return;
        }
        if(creep.harvest(source) == ERR_NOT_IN_RANGE) {
            creep.moveTo(source);
        }
	}
};

module.exports = roleHarvester;