const Consumer = require("./Consumer")
const Producer = require("./Producer").Producer

module.exports = class DeliveryManager {

    /** @type Object.<string, DeliveryManager> */
    static cache={}

    static name(room) {
        return room.name + "_DlvM"
    }

    /** @param {Room} room*/
    constructor(room, parent) {
        this.room = room
        this.parent = parent
        DeliveryManager.cache[DeliveryManager.name(room)] = this
        if(this.name in Memory.managers) {
            this.load()
            return
        }
        /** @type Array.<DeliveryRoute> */
        this.routes = []
        /** @type Array.<Producer> */
        this.producers = []
        /** @type Array.<Creep> */
        this.creeps = []
        // memorable
        this.plannedDeliveries = {}

        const structureList = room.find(FIND_STRUCTURES,
            {filter: (s) => new Set([STRUCTURE_CONTROLLER, STRUCTURE_STORAGE,
                    STRUCTURE_EXTENSION, STRUCTURE_SPAWN, STRUCTURE_WALL, STRUCTURE_TOWER]).has(s.structureType)});

        this.costMatrix = new PathFinder.CostMatrix;

        const roads = room.find(FIND_STRUCTURES,
            {filter: (s) => s.structureType == STRUCTURE_ROAD});

        for(const iR in roads) {
            const road = roads[iR];
            this.costMatrix.set(road.pos.x, road.pos.y, 1);
        }

        for(const structure of structureList) {
            this.costMatrix.set(structure.pos.x, structure.pos.y, 255);
        }
    }

    load() {
        this.creeps =       Memory.managers[this.name].creeps.map(creep => Game.creeps[creep])
        this.routes =       Memory.managers[this.name].routes.map(route => {
            return {
                src: this.parent.managers[route.src],
                dst: this.parent.managers[route.dst],
                priority: route.priority,
                distance: route.distance
            }
        })
        this.producers =    Memory.managers[this.name].producers.map(producer => this.parent.managers[producer])
        this.plannedDeliveries = Memory.managers[this.name].plannedDeliveries
        this.costMatrix = PathFinder.CostMatrix.deserialize(Memory.managers[this.name].costMatrix)
    }

    save() {
        Memory.managers[this.name] = {
            creeps:     this.creeps.map(creep => creep.name),
            room:       this.room.name,
            routes:      this.routes.map(route => {return {
                src: route.src.name,
                dst: route.dst.name,
                priority: route.priority,
                distance: route.distance
            }}),
            producers:  this.producers.map(producer => producer.name),
            plannedDeliveries: this.plannedDeliveries,
            costMatrix: this.costMatrix.serialize()
        }
    }

    get name() {
        return this.room.name + "_DlvM"
    }

    /** @param {Consumer} cns */
    addConsumer(cns) {
        const managers = this.parent.managers //Object.fromEntries(Object.entries(Memory.managers).filter(([name, mng]) => mng.room == this.room, this))
        const rulesTemplate = cns.rulesTemplate()
        for(const producerClassName of rulesTemplate.producers) {
            Object.entries(managers).forEach(([name, mng]) => {
                if(mng instanceof producerClassName) {
                    const distance = PathFinder.search(mng.pos, {pos: cns.pos, range: 1},
                        {roomCallback: (_) => this.costMatrix, plainCost:2, swampCost:10}).cost;
                    this.routes.push(new DeliveryRoute(mng, cns, rulesTemplate.priority, distance))
                }
            })
        }
        this.routes.sort((a, b) => b.priority - a.priority)
    }

    /** @param {Producer} producer */
    registerProducer(producer) {
        this.producers.push(producer)
    }

    removeConsumer() {

    }

    addCreep(creep) {
        this.producers.filter(producer => producer.name == creep.memory.src)[0].addCreep(creep)
    }

    creepNeeded() {
        for(const producer of this.producers) {
            let maxDist = 0
            this.routes.forEach(route => {
                if(route.src.name == producer.name) {
                    maxDist = route.distance > maxDist ? route.distance : maxDist
                }
            })
            const targetEnergyRate = producer.energyRate
            let currEnergyRate = 0
            producer.creeps.concat(producer.creepsQueued).forEach(creep => {
                currEnergyRate += (creep.memory.efficiency * CARRY_CAPACITY) / maxDist * (creep.memory.role == "mule")
            })

            if(currEnergyRate < producer.energyRate) {
                return {
                    role: "mule",
                    memory: {
                        src: producer.name
                    },
                    priority: 6
                }
            }
        }
        return null
        // const roomManager = this.parent
        // TODO change to `assignedManager`
        // const queuedCreep = roomManager.spawnManager.queueCreep("harvester", {assignedSource: this.source.id})
        // if(queuedCreep != null) {
        //     this.creepsQueued.push(queuedCreep)
        //     this.freePlaces--
        //     this.hasWork += queuedCreep.memory.efficiency
        // }
    }

    /** @param {Creep} creep */
    planDelivery(creep) {
        let selectedRoute = null
        for(const route of this.routes) {
            if((creep.memory.src == route.src.name) && (route.dst.energyNeeded > 0)) {
                route.dst.planDelivery(creep.store.getUsedCapacity())
                creep.memory.destination = route.dst.destination()
                // creep.memory.state = "store"
                this.plannedDeliveries[creep] = {
                    amount: creep.store.getUsedCapacity(),
                    dst: route.dst.name
                }
            }
        }
    }

    deliveries(managerName) {
        return Object.fromEntries(Object.entries(this.plannedDeliveries).filter(([name, dlv]) => dlv.dst == managerName))
    }

    deliveryCompleted(creep) {
        delete this.plannedDeliveries[creep.name]
    }

    run() {
        this.plannedDeliveries = Object.fromEntries(Object.entries(this.plannedDeliveries).filter(([name, dlv]) => name in Game.creeps))
    }

}

class DeliveryRoute {

    /** @param {Producer} src
     *  @param {Consumer} dst
     *  @param {number} priority*/
    constructor(src, dst, priority, distance) {
        this.src = src
        this.dst = dst
        this.priority = priority
        this.distance = distance
    }

    condition() {

    }
}