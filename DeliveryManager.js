const Consumer = require("./Consumer")
const Producer = require("./Producer")

module.exports = class DeliveryManager {
    /** @param {Room} room*/
    constructor(room, parent) {
        this.room = room
        this.parent = parent
        if(this.name in Memory.managers) {
            this.load()
            return
        }

        /** @type Array.<DeliveryRoute> */
        this.routes = []
        this.producers = {}
        /** @type Array.<Creep> */
        this.creeps = []
    }

    load() {
        this.creeps =       Memory.managers[this.name].creeps.map(creep => Game.creeps[creep])
        this.routes =       Memory.managers[this.name].routes.max(route => {
            return {
                src: Memory.managers[route.src],
                dst: Memory.managers[route.dst],
                priority: route.priority,
                distance: route.distance
            }
        })
        this.producers =    Memory.managers[this.name].producers.map(producer => Memory.managers[producer])
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
            producers:  this.producers.map(producer => producer.name)
        }
    }

    get name() {
        return this.room.name + "_DlvP"
    }

    /** @param {Consumer} cns */
    addConsumer(cns) {
        const managers = this.parent.managers //Object.fromEntries(Object.entries(Memory.managers).filter(([name, mng]) => mng.room == this.room, this))
        const rulesTemplate = cns.rulesTemplate()
        for(const producerClassName of rulesTemplate.producers) {
            Object.entries(managers).forEach(([name, mng]) => {
                if(mng.getClassName() == producerClassName) {
                    this.routes.push(new DeliveryRoute(mng, cns, rulesTemplate.priority))
                }
            })
        }
        this.routes.sort((a, b) => b.priority - a.priority)
    }

    /** @param {Producer} producer */
    registerProducer(producer) {
        this.producers[producer.name] = producer
    }

    removeConsumer() {

    }

    queueCreep() {
        for(const [name, producer] in Object.entries(this.producers)) {
            let maxDist = 0
            this.routes.forEach(route => {
                if(route.src.name == name) {
                    maxDist = route.distance > maxDist ? route.distance : maxDist
                }
            })
            const targetEnergyRate = producer.energyRate
            let currEnergyRate = 0
            producer.mules.forEach(creep => {
                currEnergyRate += (creep.memory.efficiency * CARRY_CAPACITY) / maxDist
            })
            if(currEnergyRate < targetEnergyRate) {
                return {
                    role: "mule",
                    priority: 6
                }
            }
        }
        if((this.freePlaces > 0) && (this.hasWork < this.needWork)) {
            // request harvester of maximum practical size
            return {
                role: "harvester",
                priority: 5
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
        /** @type {DeliveryRoute} rule */
        for(const rule of this.routes) {
            if(rule.dst.energyNeeded > 0) {
                Object.setPrototypeOf(rule.dst, Consumer)
                rule.dst.planDelivery(creep.store.getUsedCapacity())
                creep.memory.destination = rule.dst.destination()
                // creep.memory.state = "store"
            }
        }
    }

    run() {

    }

}

class DeliveryRoute {

    /** @param {Producer} src
     *  @param {Consumer} dst
     *  @param {number} priority*/
    constructor(src, dst, priority) {
        this.src = src
        this.dst = dst
        this.priority = priority
        this.distance = 10
    }

    condition() {

    }
}