module.exports = (Producer) => class extends Producer {
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

    name() {
        throw new Error("Implementation needed")
    }

    rulesTemplate() {
        throw new Error("Implementation needed")
    }
}