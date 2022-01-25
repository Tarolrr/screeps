const assignMule = function(creepMemory, room) {
    if(creepMemory.role == "mule"){
        const spawn = room.find(FIND_MY_SPAWNS)[0];
        let maxSpawnMules = 0;

        if(spawn.memory.queue.length != undefined) {
            maxSpawnMules += spawn.memory.queue.length;
        }

        if(room.memory.spawnMules < 1 + maxSpawnMules) {
            if(creepMemory.dst != undefined) {
                if(creepMemory.dst == "spawn") {
                    room.memory.spawnMules--;
                }
                else if(creepMemory.dst == "ctrl") {
                    room.memory.upgradeMules--;
                }
                else {
                    room.memory.storeMules--;
                }
            }
            room.memory.spawnMules++;
            creepMemory.dst = "spawn"
        }
        else if(room.memory.storeMules >= room.memory.upgradeMules){
            if(creepMemory.dst != undefined) {
                if(creepMemory.dst == "spawn") {
                    room.memory.spawnMules--;
                }
                else if(creepMemory.dst == "ctrl") {
                    room.memory.upgradeMules--;
                }
                else {
                    room.memory.storeMules--;
                }
            }
            room.memory.upgradeMules++;
            creepMemory.dst = "cont";
        }
        else {
            if(creepMemory.dst != undefined) {
                if(creepMemory.dst == "spawn") {
                    room.memory.spawnMules--;
                }
                else if(creepMemory.dst == "ctrl") {
                    room.memory.upgradeMules--;
                }
                else {
                    room.memory.storeMules--;
                }
            }
            room.memory.storeMules++;
            creepMemory.dst = "ctrl";
        }
    }
}

module.exports = {
    run: function() {
        if(Game.time % 50 == 1) {
            for(const room_name in Game.rooms) {
                const room = Game.rooms[room_name];

                room.memory.spawnMules = 0
                room.memory.storeMules = 0
                room.memory.upgradeMules = 0
                const creepList = room.find(FIND_MY_CREEPS);

                for(const cr_i in creepList){
                    const creep = creepList[cr_i];

                    // assigning mules to tasks
                    if(creep.memory.role == "mule"){
                        if(creep.memory.dst != undefined) {
                            if (creep.memory.dst == "spawn") {
                                room.memory.spawnMules++;
                            }
                            else if (creep.memory.dst == "ctrl") {
                                room.memory.upgradeMules++;
                            }
                            else if (creep.memory.dst == "cont") {
                                room.memory.storeMules++;
                            }
                        }
                    }
                }
                for(const cr_i in creepList){
                    const creep = creepList[cr_i];
                    assignMule(creep.memory, room)
                }
            }
        }
    },
    assignMule: assignMule
};