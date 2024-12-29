const logger = require("./logger");

/** @param {RoomPosition} pos **/
function checkSourceAvailability(pos){
    let res = 0;
    const terrain = Game.rooms[pos.roomName].getTerrain();
    for(let x = pos.x - 1; x <= pos.x + 1; x++){
        for(let y = pos.y - 1; y <= pos.y + 1; y++){
            if((x == pos.x) && (y == pos.y)){
                continue;
            }
            if(terrain.get(x, y) != TERRAIN_MASK_WALL){
                res++;
            }
        }
    }
    return res;
}

/**
 * A dropped piece of resource.
 * It will decay after a while if not picked up.
 * Dropped resource pile decays for ceil(amount/1000) units per tick.
 *
 * @class
 * @param {Source} source
 */
module.exports = class SourceDesc{
    constructor(source) {
        /**
         * The amount of resource units containing.
         *
         * @type {number}
         */
        this.totalPlaces = checkSourceAvailability(source.pos);

        /**
         * The amount of resource units containing.
         *
         * @type {number}
         */
        this.freePlaces = this.totalPlaces;
        this.needWork = Math.ceil(source.energyCapacity / 300 / 2);
        this.hasWork = 0;
        const spawn = source.room.find(FIND_MY_SPAWNS)[0];
        this.timeTo = PathFinder.search(spawn.pos, {pos: source.pos, range: 1}).cost;

        this.needCarry = this.timeTo * 2 /                 // round-trip time
            50 *                                        // one CARRY part capacity
            (source.energyCapacity / ENERGY_REGEN_TIME) * 3;// source energy per second capacity
        this.hasCarry = 0;
        this.srcId = source.id;
    }

    update() {
        logger.debug("src update")
        const source = Game.getObjectById(this.srcId)
        this.needWork = Math.ceil(source.energyCapacity / 300 / 2);

        const costMatrix = PathFinder.CostMatrix.deserialize(source.room.memory.costMatrix)

        const spawn = source.room.find(FIND_MY_SPAWNS)[0];
        this.timeTo = PathFinder.search(spawn.pos, {pos: source.pos, range: 1}, {roomCallback: (_) => costMatrix, plainCost:2, swampCost:10}).cost/2;

        logger.debug("time to " + this.timeTo)
        this.needCarry = this.timeTo * 2 /                 // round-trip time
            50 *                                        // one CARRY part capacity
            (source.energyCapacity / ENERGY_REGEN_TIME) * 3;// source energy per second capacity
    }

    availableCarry() {
        // console.log(this.hasWork + " " + this.needWork + " " + this.hasCarry + " " + this.needCarry)
        let workedPart = (this.hasWork / this.needWork);
        workedPart = workedPart < 1 ? workedPart : 1;
        const result = workedPart * this.needCarry - this.hasCarry;
        return result > 0 ? result : 0;
        // return result
    }
};
