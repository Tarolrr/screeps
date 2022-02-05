"use strict";

const Consumer = require("./Consumer")
const Manager = require("./Manager");
const CreepOwner = require("./CreepOwner");
const Producer = require("./Producer").Producer

module.exports = class DeliveryManager extends Manager{

    /** @type Object.<string, DeliveryManager> */

    // static cache
    //
    // static {
    //     DeliveryManager.cache = {}
    // }

    static name(room) {
        return room.name + "_DlvM"
    }

    /** @param {Room} room*/
    constructor(room, parent) {
        super(room, parent)
        this.creepOwner = new CreepOwner(this)

        DeliveryManager.cache[DeliveryManager.name(room)] = this
        if(this.name in Memory.managers) {
            this.load()
            return
        }
        /** @type Array.<DeliveryRoute> */
        this.routes = []
        /** @type Array.<Producer> */
        this.producers = []
        // memorable
        this.plannedDeliveries = new Map()

        const structureList = room.find(FIND_STRUCTURES,
            {filter: (s) => new Set([STRUCTURE_CONTROLLER, STRUCTURE_STORAGE,
                    STRUCTURE_EXTENSION, STRUCTURE_SPAWN, STRUCTURE_WALL, STRUCTURE_TOWER]).has(s.structureType)});

        this.costMatrix = new PathFinder.CostMatrix;

        const roads = room.find(FIND_STRUCTURES,
            {filter: (s) => s.structureType == STRUCTURE_ROAD});

        for(const road of roads) {
            this.costMatrix.set(road.pos.x, road.pos.y, 1);
        }

        for(const structure of structureList) {
            this.costMatrix.set(structure.pos.x, structure.pos.y, 255);
        }
    }

    load() {
        this.routes =       Memory.managers[this.name].routes.map(route => {
            return {
                src: this.parent.managers.get(route.src),
                dst: this.parent.managers.get(route.dst),
                priority: route.priority,
                distance: route.distance
            }
        })
        this.producers =    Memory.managers[this.name].producers.map(producer => this.parent.managers.get(producer))
        this.plannedDeliveries = Map.fromObject(Memory.managers[this.name].plannedDeliveries)
        this.costMatrix = PathFinder.CostMatrix.deserialize(Memory.managers[this.name].costMatrix)
    }

    save() {
        Memory.managers[this.name] = {
            routes:      this.routes.map(route => {return {
                src: route.src.name,
                dst: route.dst.name,
                priority: route.priority,
                distance: route.distance
            }}),
            producers:  this.producers.map(producer => producer.name),
            plannedDeliveries: this.plannedDeliveries.toObject(),
            costMatrix: this.costMatrix.serialize()
        }
    }

    get name() {
        return this.room.name + "_DlvM"
    }

    get features() {
        return new Set(["CreepOwner"])
    }

    /** @param {Consumer} cns */
    addConsumer(cns) {
        const rulesTemplate = cns.rulesTemplate()
        for(const producerClassName of rulesTemplate.producers) {
            this.parent.managers.forEach((mng, name) => {
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
        this.creepOwner.creepsQueued = []
        this.parent.managers.filter(([name, producer]) => producer.name == creep.memory.src).values().next().value.creepOwner.addCreep(creep)
    }

    creepNeeded() {
        for(const [name, manager] of this.parent.managers) {
            let maxDist = 0
            this.routes.forEach(route => {
                if(route.src.name == name) {
                    maxDist = route.distance > maxDist ? route.distance : maxDist
                }
            })

            if(manager.energyRate == undefined) {
                continue
            }

            const targetEnergyRate = manager.energyRate
            let currEnergyRate = 0
            manager.creepOwner.creeps.concat(manager.creepOwner.creepsQueued).forEach(creep => {
                currEnergyRate += (creep.memory.efficiency * CARRY_CAPACITY) / maxDist * (creep.memory.role == "mule")
            })

            if(currEnergyRate < manager.energyRate) {
                return {
                    role: "mule",
                    memory: {
                        src: name
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
                this.plannedDeliveries.set(creep.name, {
                    amount: creep.store.getUsedCapacity(),
                    dst: route.dst.name
                })
                return
            }
        }
    }

    deliveries(managerName) {
        return new Map(Array.from(this.plannedDeliveries).filter(([name, dlv]) => dlv.dst == managerName))
    }

    pendingEnergy(managerName) {
        let pendingEnergy = 0
        this.deliveries(managerName).forEach(delivery => pendingEnergy += delivery.amount)
        return pendingEnergy
    }

    deliveryCompleted(creep) {
        this.plannedDeliveries.delete(creep.name)
    }

    run() {
        this.plannedDeliveries = this.plannedDeliveries.filter(([name, dlv]) => name in Game.creeps)
    }

}

module.exports.cache = {}

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