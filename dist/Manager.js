module.exports = class Manager {
    /** @param {Room} room*/
    constructor(room, parent) {
        this.room = room
        this.parent = parent
    }

    load() {
        throw new Error("Implementation needed")
    }

    save() {
        throw new Error("Implementation needed")
    }

    get name() {
        throw new Error("Implementation needed")
    }

    get features() {
        return new Set([])
    }

    planDelivery(amount) {
        // this.energyNeeded = this.energyNeeded < amount ? 0 : this.energyNeeded - amount
    }

}