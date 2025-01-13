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
    generateResourceId(type, spec) {
        if (spec.metadata && spec.metadata.annotation) {
            return spec.metadata.annotation;
        }
        return `${type}_${Game.time}_${++this.lastId}`;
    }

    findMatchingResource(type, spec) {
        if (this.resources[type]) {
            for (const resource of Object.values(this.resources[type])) {
                if (resource.matchesAnnotation(spec)) {
                    return resource;
                }
            }
        }
        return null;
    }

    applyResource(type, spec) {
        const existingResource = this.findMatchingResource(type, spec);
        
        if (existingResource) {
            const newSpec = {
                ...spec,
            };
            this.updateResource(type, existingResource.id, newSpec);
            return existingResource.id;
        }

        const id = this.generateResourceId(type, spec);
        if (!this.resources[type]) {
            this.resources[type] = {};
        }
        
        this.resources[type][id] = this.createResourceInstance(type, id, spec);
        logger.debug(`Created new ${type} with id ${id}`);
        return id;
    }

    createJsonDiff(oldJson, newJson) {
        const maxLength = 100; // Prevent huge diffs
        let diff = '';
        for (let i = 0; i < Math.min(oldJson.length, newJson.length, maxLength); i++) {
            if (oldJson[i] !== newJson[i]) {
                const context = 10; // Show this many chars before and after difference
                const start = Math.max(0, i - context);
                const end = Math.min(Math.min(oldJson.length, newJson.length), i + context);
                
                diff += `Difference at position ${i}:\n`;
                diff += `Old: ...${oldJson.slice(start, end)}...\n`;
                diff += `New: ...${newJson.slice(start, end)}...\n`;
                diff += `     ${' '.repeat(i - start)}^\n`;
                break;
            }
        }
        if (!diff && oldJson.length !== newJson.length) {
            diff = `Length difference: old=${oldJson.length}, new=${newJson.length}\n`;
            diff += `Old ends with: ...${oldJson.slice(-50)}\n`;
            diff += `New ends with: ...${newJson.slice(-50)}\n`;
        }
        return diff;
    }

    updateResource(type, id, changes) {
        if (this.resources[type] && this.resources[type][id]) {
            const oldResource = this.resources[type][id];
            
            // Compare spec representations to check for actual changes
            if (!oldResource.matchesSpec(changes)) {
                // Preserve status fields from old resource
                oldResource.updateSpec(changes);

                logger.debug(`Updated ${type} with id ${id}`);
                // logger.debug(this.createJsonDiff(JSON.stringify(oldResource.toSpec()), JSON.stringify(changes)));

                // logger.debug(JSON.stringify(oldResource.toSpec()));
                // logger.debug(JSON.stringify(changes));
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