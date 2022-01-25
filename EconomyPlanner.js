module.exports = class EconomyPlanner {
    static inefficiencies = {
        harvest: 0.9,
        carry: 0.5
    }

    static ratio = {
        upgrade: 0.3,
        build: 0.4,
        repair: 0.3
    }

    static run() {
        for(const roomName in Game.rooms) {
            const room = Game.rooms[roomName]
            room.memory.economy = {}

            const capacity = room.energyCapacityAvailable

            //TODO account for reserved rooms
            /** @type Array.<Source> */
            const sourceList = room.find(FIND_SOURCES)

            const totalEnergyPerSecond = sourceList.reduce((v, src) => v + src.energyCapacity, 0) /
                ENERGY_REGEN_TIME * this.inefficiencies.harvest


        }
    }
}