// Memorable
class CreepTemplate {
    constructor(cost, memory, parts) {
        this.cost = cost
        this.memory = memory
        this.parts = parts
    }
}

class QueuedCreep {
    constructor(name, memory, parts) {
        this.name = name
        this.memory = memory
        this.parts = parts
    }
}

module.exports = {
    CreepTemplate: CreepTemplate,
    QueuedCreep: QueuedCreep
}