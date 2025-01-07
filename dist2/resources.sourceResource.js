class SourceResource {
    constructor(data) {
        this.id = data.id;
        this.sourceId = data.sourceId;
        this._source = null;
    }

    get source() {
        if (!this._source) {
            this._source = Game.getObjectById(this.sourceId);
        }
        return this._source;
    }

    // Serialize only the necessary data
    toJSON() {
        return {
            id: this.id,
            sourceId: this.sourceId
        };
    }
}

module.exports = SourceResource;
