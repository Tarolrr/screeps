// Memorable
class Resource {
    constructor(data) {
        this.id = data.id;
        this.metadata = {
            ...data.metadata,
            type: data.type,
            signature: data.signature || this.generateSignature(data),
            version: data.version || 1,
        };
    }

    generateSignature(data) {
        // Create a unique signature based on essential properties
        // Override this in specific resource types
        return JSON.stringify(Object.entries(data)
            .filter(([key]) => key !== 'id' && key !== 'metadata')
            .sort()
        );
    }

    matches(other) {
        // Only match if both resources have annotations and they match
        if (!this.metadata.annotation || !other.metadata.annotation) {
            return false;
        }
        return this.metadata.annotation === other.metadata.annotation;
    }

    toJSON() {
        return {
            id: this.id,
            metadata: this.metadata
        };
    }
}

module.exports = Resource;