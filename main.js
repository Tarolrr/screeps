const roleHarvester = require('./role.harvester');
const roleUpgrader = require('./role.upgrader');
const roleBuilder = require('./role.builder');
const roleRepairer = require('./role.repairer');
const roleMule = require('./role.mule');
const harvestPlanner = require('./room.harvestPlanner');
const CreepPlanner = require('./CreepPlanner');
const spawnPlanner = require('./SpawnPlanner');
const consumptionPlanner = require('./room.consumptionPlanner');

module.exports.loop = function () {
    harvestPlanner.run();
    // CreepPlanner.run();
    spawnPlanner.run();
    consumptionPlanner.run();

    if(Memory.creepId == undefined) {
        Memory.creepId = 0;
    }
    for(const roomName in Game.rooms) {
        const room = Game.rooms[roomName];

        /** @type StructureSpawn */
        //TODO can be undefined for neutral/enemy rooms
        const spawn = room.find(FIND_MY_SPAWNS)[0];

        const queue = spawn.memory.queue;
        //TODO raises error before the first call of spawnPlanner
        if((queue.length > 0) && (spawn.spawnCreep(queue[0].parts, "dry_run" + Memory.creepId, {dryRun: true}) == OK)) {
            const creepTemplate = queue.shift();
            let creepMemory = Object.assign({}, creepTemplate.memory);
            // creepTemplate.callback(creepMemory, room);
            if(creepMemory.role == "harvester") {
                harvestPlanner.assignHarvester(creepMemory, room)
            }
            else if(creepMemory.role == "mule") {
                harvestPlanner.assignMule(creepMemory, room)
                consumptionPlanner.assignMule(creepMemory, room)
            }
            spawn.spawnCreep(creepTemplate.parts, creepTemplate.name + Memory.creepId, {memory: creepMemory});
            Memory.creepId++;
        }
    }
    
    for(const creepName in Game.creeps) {
        const creep = Game.creeps[creepName];
        if(creep.memory.role == 'harvester') {
            roleHarvester.run(creep);
        }
        if(creep.memory.role == 'upgrader') {
            roleUpgrader.run(creep);
        }
        if(creep.memory.role == 'mule') {
            roleMule.run(creep);
        }
        if(creep.memory.role == 'builder') {
            roleBuilder.run(creep);
        }
        if(creep.memory.role == 'repairer') {
            roleRepairer.run(creep);
        }
    }
    console.log("CPU " + Game.cpu.getUsed())
}
