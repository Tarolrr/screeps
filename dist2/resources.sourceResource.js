const Resource = require('./resources.Resource');

class SourceResource extends Resource {
    constructor(data) {
        super(data);
        this.sourceId = data.sourceId;
        this.roomName = data.roomName;
        this.workPlaces = data.workPlaces || [];
        this._source = null;
    }

    get source() {
        if (!this._source) {
            this._source = Game.getObjectById(this.sourceId);
        }
        return this._source;
    }

    generateSignature(data) {
        // Source resources are uniquely identified by their sourceId
        return JSON.stringify({
            sourceId: data.sourceId
        });
    }

    // Serialize only the necessary data
    toJSON() {
        return {
            id: this.id,
            sourceId: this.sourceId,
            roomName: this.roomName,
            workPlaces: this.workPlaces,
            metadata: this.metadata
        };
    }
}

module.exports = SourceResource;
