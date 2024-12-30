require("./mapPatch")
const roleHarvester = require('./role.harvester');
const logger = require('./logger');

module.exports.loop = function () {
    // harvestPlanner.run();
    // // CreepPlanner.run();
    // spawnPlanner.run();
    // consumptionPlanner.run();
    try {
        logger.load();

        // if (Memory.creepId == undefined) {
        //     Memory.creepId = 0;
        //     Memory.managers = {}
        // }
        // for (const roomName in Game.rooms) {
        //     const room = Game.rooms[roomName]
        //     const roomManager = new RoomManager(room)

        //     roomManager.run()
        // }

        // for (const creepName in Game.creeps) {
        //     const creep = Game.creeps[creepName];
        //     if (creep.memory.role == 'harvester') {
        //         roleHarvester.run(creep);
        //     }
        //     if (creep.memory.role == 'upgrader') {
        //         roleUpgrader.run(creep);
        //     }
        //     if (creep.memory.role == 'mule') {
        //         roleMule.run(creep);
        //     }
        //     if (creep.memory.role == 'builder') {
        //         roleBuilder.run(creep);
        //     }
        //     if (creep.memory.role == 'repairer') {
        //         roleRepairer.run(creep);
        //     }
        // }
        logger.debug("CPU " + Game.cpu.getUsed())
    }
    catch (e) {
        logger.error(e.stack)
    }
}
