const Producer = (superClass) => class extends superClass {
    constructor() {
        super()

        this.energyAvailable = 0
    }

    get availableEnergy() {
        throw new Error("Implementation needed")
    }

    get energyRate() {
        throw new Error("Implementation needed")
    }

    rulesTemplate() {
        throw new Error("Implementation needed")
    }

    creepNeeded() {
        throw new Error("Implementation needed")
    }
}

module.exports = {
    Producer: Producer(Object),
    ProducerMixin: Producer
}
