const logger = require('./logger');

class ResourceManager {
    constructor() {
        this.resources = {};
        this.resourceTypes = new Map();
        this.lastId = 0;
        this.load();
    }

    registerResourceType(type, constructor) {
        this.resourceTypes.set(type, constructor);
    }

    createResourceInstance(type, id, data) {
        const ResourceConstructor = this.resourceTypes.get(type);
        if (ResourceConstructor) {
            return new ResourceConstructor({ id, ...data });
        }
        return { id, ...data };
    }

    load() {
        if (Memory.resourceManager) {
            const rawResources = Memory.resourceManager.resources || {};
            
            this.resources = {};
            for (const [type, resources] of Object.entries(rawResources)) {
                if (!this.resources[type]) {
                    this.resources[type] = {};
                }
                
                for (const [id, data] of Object.entries(resources)) {
                    this.resources[type][id] = this.createResourceInstance(type, id, data);
                }
            }
        } else {
            this.resources = {};
        }
    }

    save() {
        if (!Memory.resourceManager) {
            Memory.resourceManager = {};
        }
        Memory.resourceManager.resources = this.resources;
    }

    generateResourceId(type) {
        return `${type}_${Game.time}_${++this.lastId}`;
    }

    createResource(type, spec) {
        const id = this.generateResourceId(type);
        if (!this.resources[type]) {
            this.resources[type] = {};
        }
        
        this.resources[type][id] = this.createResourceInstance(type, id, spec);
        logger.debug(`Created ${type} with id ${id} and spec ${JSON.stringify(spec)}`);
        return id;
    }

    getResourceByTypeAndId(type, id) {
        return this.resources[type] ? this.resources[type][id] : undefined;
    }

    getResourceByField(type, field, value) {
        if (!this.resources[type]) return [];
        return Object.values(this.resources[type]).filter(resource => resource[field] === value);
    }

    updateResource(type, id, changes) {
        if (this.resources[type] && this.resources[type][id]) {
            this.resources[type][id] = this.createResourceInstance(type, id, changes);
        }
    }

    getResourcesOfType(type) {
        return this.resources[type] ? Object.values(this.resources[type]) : [];
    }
}

const instance = new ResourceManager();
module.exports = instance;