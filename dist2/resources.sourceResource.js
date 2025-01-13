const Resource = require('./resources.Resource');

class SourceResource extends Resource {
    static get STATE_SCHEMA() {
        return Resource.STATE_SCHEMA;
    }

    static get SPEC_SCHEMA() {
        return Resource.combineSchemas(Resource.SPEC_SCHEMA, {
            roomName: 'string',
            sourceId: 'string'
        });
    }

    constructor(data) {
        super(data);
        
        // Set spec fields
        this.roomName = data.roomName;
        this.sourceId = data.sourceId;
    }

    get source() {
        return Game.getObjectById(this.sourceId);
    }

    toSpec() {
        return {
            ...super.toSpec(),
            roomName: this.roomName,
            sourceId: this.sourceId
        };
    }
}

module.exports = SourceResource;
