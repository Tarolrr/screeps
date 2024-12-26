require("./mapPatch")
const roleHarvester = require('./role.harvester');
const roleUpgrader = require('./role.upgrader');
const roleBuilder = require('./role.builder');
const roleRepairer = require('./role.repairer');
const roleMule = require('./role.mule');
const harvestPlanner = require('./room.harvestPlanner');
const spawnPlanner = require('./SpawnPlanner');
const consumptionPlanner = require('./room.consumptionPlanner');

const RoomManager = require("./RoomManager")

module.exports.loop = function () {
    // harvestPlanner.run();
    // // CreepPlanner.run();
    // spawnPlanner.run();
    // consumptionPlanner.run();
    try {
        if (Memory.creepId == undefined) {
            Memory.creepId = 0;
            Memory.managers = {}
        }
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName]
            const roomManager = new RoomManager(room)

            roomManager.run()
        }

        for (const creepName in Game.creeps) {
            const creep = Game.creeps[creepName];
            if (creep.memory.role == 'harvester') {
                roleHarvester.run(creep);
            }
            if (creep.memory.role == 'upgrader') {
                roleUpgrader.run(creep);
            }
            if (creep.memory.role == 'mule') {
                roleMule.run(creep);
            }
            if (creep.memory.role == 'builder') {
                roleBuilder.run(creep);
            }
            if (creep.memory.role == 'repairer') {
                roleRepairer.run(creep);
            }
        }
        console.log("CPU " + Game.cpu.getUsed())
    }
    catch (e) {
        // console.log(e)
        console.log(e.stack)
    }
}
