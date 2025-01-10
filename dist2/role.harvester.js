var roleHarvester = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if(creep.spawning == true) {
            return;
        }
        var source = Game.getObjectById(creep.memory.sourceId);
        if(source == undefined){
            return;
        }
        if(creep.store.getFreeCapacity() == 0) {
            creep.say('Drop!');
            creep.drop(RESOURCE_ENERGY);
            return;
        }

        if(creep.harvest(source) == ERR_NOT_IN_RANGE) {
            creep.moveTo(source);
            return;
        }
	}
};

module.exports = roleHarvester;