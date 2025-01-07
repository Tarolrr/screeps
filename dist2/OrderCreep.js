const Resource = require('./Resource');

class OrderCreep extends Resource {
    constructor(id, type, spec) {
        super(id, type, spec);
        this.type = 'OrderCreep';
    }
}

module.exports = OrderCreep