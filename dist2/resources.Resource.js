const logger = require('logger');

class Resource {
    static get STATE_SCHEMA() {
        return {
            id: 'string'
        };
    }

    static get SPEC_SCHEMA() {
        return {
            metadata: {
                annotation: 'string',
            }
        };
    }

    constructor(data) {
        // For constructor, validate against combined schema
        const constructorSchema = this.constructor.combineSchemas(
            this.constructor.STATE_SCHEMA,
            this.constructor.SPEC_SCHEMA
        );
        this.validateSchema(data, constructorSchema);

        // Set state
        this.id = data.id;

        // Set spec
        this.metadata = {
            annotation: data.metadata && data.metadata.annotation,
        };
    }

    validateSchema(data, schema, path = '') {
        // Check for unexpected properties
        for (const key of Object.keys(data)) {
            if (!schema.hasOwnProperty(key)) {
                throw new Error(`Unexpected property ${path ? path + '.' : ''}${key}`);
            }
        }

        // Check for required properties and types
        for (const [key, type] of Object.entries(schema)) {
            const fullPath = path ? `${path}.${key}` : key;
            
            if (typeof type === 'object') {
                // Nested schema
                if (data[key] === undefined) {
                    // Skip validation if property is missing
                    continue;
                }
                if (typeof data[key] !== 'object') {
                    throw new Error(`Invalid ${fullPath}: expected object`);
                }
                this.validateSchema(data[key], type, fullPath);
            } else {
                // Simple type check
                if (data[key] !== undefined && data[key] !== null && typeof data[key] !== type) {
                    throw new Error(`Invalid ${fullPath}: expected ${type}, got ${typeof data[key]}, value: ${data[key]}`);
                }
            }
        }
    }

    updateSpec(spec) {
        // Validate spec against schema
        this.validateSchema(spec, this.constructor.SPEC_SCHEMA);
        
        // Update all spec fields
        for (const key in spec) {
            this[key] = spec[key];
        }

        this.onSpecUpdate();
    }

    matchesAnnotation(other) {
        return this.metadata.annotation && 
               other.metadata && other.metadata.annotation && 
               this.metadata.annotation === other.metadata.annotation;
    }

    matchesSpec(other) {
        // Strip object to plain data (no methods, no prototype chain)
        const stripToData = (obj) => {
            if (obj === null || typeof obj !== 'object') {
                return obj;
            }
            
            return JSON.parse(JSON.stringify(obj));
        };

        const compareObjects = (a, b, path = '') => {
            // Handle null/undefined
            if (a === b) return true;
            if (!a || !b) {
                logger.debug(`Mismatch at ${path}: ${a} !== ${b}`);
                return false;
            }

            // Compare arrays
            if (Array.isArray(a) && Array.isArray(b)) {
                if (a.length !== b.length) {
                    logger.debug(`Array length mismatch at ${path}: ${a.length} !== ${b.length}`);
                    return false;
                }
                return a.every((item, i) => compareObjects(item, b[i], `${path}[${i}]`));
            }

            // Compare objects
            if (typeof a === 'object' && typeof b === 'object') {
                const keysA = Object.keys(a);
                const keysB = Object.keys(b);
                
                if (keysA.length !== keysB.length) {
                    logger.debug(`Object keys length mismatch at ${path}: ${keysA.length} !== ${keysB.length}`);
                    logger.debug(`A: ${JSON.stringify(a)}`);
                    logger.debug(`B: ${JSON.stringify(b)}`);
                    return false;
                }

                return keysA.every(key => {
                    if (!keysB.includes(key)) {
                        logger.debug(`Missing key "${key}" at ${path}`);
                        return false;
                    }
                    return compareObjects(a[key], b[key], `${path}.${key}`);
                });
            }

            // Compare primitives
            if (a !== b) {
                logger.debug(`Primitive mismatch at ${path}: ${a} !== ${b}`);
                return false;
            }
            return true;
        };

        const thisSpec = stripToData(this.toSpec());
        const otherStripped = stripToData(other);

        const result = compareObjects(thisSpec, otherStripped);
        if (!result) {
            logger.debug('Specs do not match');
            logger.debug(JSON.stringify(thisSpec));
            logger.debug(JSON.stringify(otherStripped));
        }
        
        return result;
    }

    toSpec() {
        return {
            metadata: { ...this.metadata }
        };
    }

    toJSON() {
        return {
            id: this.id,
            ...this.toSpec()
        };
    }

    onSpecUpdate() {
        // Override in specific resource types if needed
    }

    static combineSchemas(parentSchema, childSchema) {
        const result = {};
        for (const [key, value] of Object.entries(parentSchema)) {
            result[key] = typeof value === 'object' 
                ? { ...value } 
                : value;
        }
        for (const [key, value] of Object.entries(childSchema)) {
            if (typeof value === 'object' && typeof result[key] === 'object') {
                result[key] = { ...result[key], ...value };
            } else {
                result[key] = value;
            }
        }
        return result;
    }
}

module.exports = Resource;