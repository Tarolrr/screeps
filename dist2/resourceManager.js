const logger = require('./logger');

class ResourceManager {
    constructor() {
        this.resources = {};
        this.resourceTypes = new Map();
        this.lastId = 0;
        this.disabled = false;
    }

    registerResourceType(type, constructor) {
        this.resourceTypes.set(type, constructor);
    }

    createResourceInstance(type, id, data) {
        const ResourceConstructor = this.resourceTypes.get(type);
        if (ResourceConstructor) {
            return new ResourceConstructor({ id, type, ...data });
        }
        return { id, type, ...data };
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
        let memory_disabled = false;
        if (Memory.resourceManager && Memory.resourceManager.disabled !== undefined) {
            memory_disabled = Boolean(Memory.resourceManager.disabled === true || Memory.resourceManager.disabled === 'true');
        }
        if (!memory_disabled) {
            if (this.disabled) {
                this.disabled = false;
                this.load();
                logger.debug("Re-enabled resource manager, loading resources from memory");
            }
            Memory.resourceManager.resources = this.resources;
        }
        else {
            this.disabled = true;
        }
    }

    generateResourceId(type) {
        return `${type}_${Game.time}_${++this.lastId}`;
    }

    findMatchingResource(type, spec) {
        const tempResource = this.createResourceInstance(type, 'temp', spec);
        if (this.resources[type]) {
            for (const resource of Object.values(this.resources[type])) {
                if (resource.matches(tempResource)) {
                    return resource;
                }
            }
        }
        return null;
    }

    applyResource(type, spec) {
        // Check for existing resource with same annotation
        const existingResource = this.findMatchingResource(type, spec);
        
        if (existingResource) {
            // If found, update with version bump
            const newSpec = {
                ...spec,
                // version: (existingResource.metadata.version || 0) + 1
            };
            this.updateResource(type, existingResource.id, newSpec);
            return existingResource.id;
        }

        // Create new resource if none found
        const id = this.generateResourceId(type);
        if (!this.resources[type]) {
            this.resources[type] = {};
        }
        
        this.resources[type][id] = this.createResourceInstance(type, id, spec);
        logger.debug(`Created new ${type} with id ${id}`);
        return id;
    }

    updateResource(type, id, changes) {
        if (this.resources[type] && this.resources[type][id]) {
            const oldResource = this.resources[type][id];
            const newResource = this.createResourceInstance(type, id, changes);
            
            // Compare JSON representations to check for actual changes
            const oldJson = JSON.stringify(oldResource);
            const newJson = JSON.stringify(newResource);
            
            if (oldJson !== newJson) {
                this.resources[type][id] = newResource;
                logger.debug(`Updated ${type} with id ${id}`);
            }
        }
    }

    getResourceByTypeAndId(type, id) {
        return this.resources[type] ? this.resources[type][id] : undefined;
    }

    getResourceByField(type, field, value) {
        if (!this.resources[type]) return [];
        return Object.values(this.resources[type]).filter(resource => resource[field] === value);
    }

    getResourcesOfType(type) {
        return Object.values(this.resources[type] || {});
    }

    deleteResource(type, id) {
        if (this.resources[type] && this.resources[type][id]) {
            delete this.resources[type][id];
            return true;
        }
        return false;
    }
}

module.exports = new ResourceManager();