module.exports = class Consumer {
    constructor() {
        this.energyNeeded = 0
    }

    planDelivery(amount) {
        this.energyNeeded = this.energyNeeded < amount ? 0 : this.energyNeeded - amount
    }

    get name() {
        throw new Error("Implementation needed")
    }

    recalculateNeededEnergy() {
        throw new Error("Implementation needed")
    }


    // destination types are:
    // - structure: try to transfer resource to structure
    // - ground: place resource on the ground
    // - wait: wait for N ticks at designated point (e.g. for spawn to process the queue)

    destination() {
        throw new Error("Implementation needed")
    }

    rulesTemplate() {
        throw new Error("Implementation needed")
    }
}