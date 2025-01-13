const Resource = require('./resources.Resource');
const patterns = require('./constructionPatterns');
const logger = require('./logger');

class ConstructionOrder extends Resource {
    static get STATE_SCHEMA() {
        return Resource.combineSchemas(Resource.STATE_SCHEMA, {
            positions: 'object'  // array of positions
        });
    }

    static get SPEC_SCHEMA() {
        return Resource.combineSchemas(Resource.SPEC_SCHEMA, {
            structureType: 'string',
            pattern: 'object',
            roomName: 'string',
            priority: 'number',
            count: 'number'
        });
    }

    constructor(data) {
        super(data);
        
        // Set spec fields
        this.structureType = data.structureType;
        this.pattern = data.pattern;
        this.roomName = data.roomName;
        this.priority = data.priority || 0;
        this.count = data.count || 0;
        
        // Set state fields
        const room = Game.rooms[this.roomName];
        if (Array.isArray(data.positions) && data.positions.length > 0) {
            this.positions = data.positions;
        } else {
            this.positions = this.generatePositions(room);
        }
    }

    onSpecUpdate() {
        // Regenerate positions when spec changes
        const room = Game.rooms[this.roomName];
        this.positions = this.generatePositions(room);
    }

    generatePositions(room) {
        if (!room) {
            logger.debug('Room not found, returning empty array');
            return [];
        }

        const patternFunc = patterns[this.pattern.type];
        if (!patternFunc) {
            logger.debug(`Unknown pattern type: ${this.pattern.type}`);
            return [];
        }

        const validPositions = [];
        let index = 0;

        while (validPositions.length < this.count || !this.count) {
            const { positions, outOfBounds } = patternFunc(this.pattern.params, index);
            
            if (outOfBounds && positions.length === 0) {
                break;
            }

            for (const pos of positions) {
                if (this.isValidPosition(room, pos)) {
                    validPositions.push(pos);
                    if (validPositions.length >= this.count && this.count) {
                        break;
                    }
                }
            }
            index++;
        }

        return validPositions;
    }

    isValidPosition(room, pos) {
        const roomPos = new RoomPosition(pos.x, pos.y, this.roomName);

        // Check terrain
        const terrain = room.getTerrain();
        if (terrain.get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
            return false;
        }

        // Check existing structures
        const structures = roomPos.lookFor(LOOK_STRUCTURES);
        for (const structure of structures) {
            if (structure.structureType === this.structureType) {
                return true;
            } else if (![STRUCTURE_ROAD, STRUCTURE_RAMPART].includes(structure.structureType)) {
                return false;
            }
        }

        // Check construction sites
        const sites = roomPos.lookFor(LOOK_CONSTRUCTION_SITES);
        for (const site of sites) {
            if (site.structureType === this.structureType) {
                return true;
            } else if (![STRUCTURE_ROAD, STRUCTURE_RAMPART].includes(site.structureType)) {
                return false;
            }
        }

        return true;
    }

    generateConstructionSitePositions(count) {
        const occupiedCount = this.positions.filter(pos => {
            const roomPos = new RoomPosition(pos.x, pos.y, this.roomName);
            const structures = roomPos.lookFor(LOOK_STRUCTURES);
            const sites = roomPos.lookFor(LOOK_CONSTRUCTION_SITES);
            const isOccupied = structures.some(s => s.structureType === this.structureType) ||
                              sites.some(s => s.structureType === this.structureType);
            return isOccupied;
        }).length;

        const availablePositions = this.positions.filter(pos => {
            const roomPos = new RoomPosition(pos.x, pos.y, this.roomName);
            const structures = roomPos.lookFor(LOOK_STRUCTURES);
            const sites = roomPos.lookFor(LOOK_CONSTRUCTION_SITES);
            const isAvailable = structures.every(s => s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_RAMPART) &&
                               sites.every(s => s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_RAMPART);
            return isAvailable;
        });

        const targetCount = this.count === 0 ? count : Math.min(count || this.count, this.count - occupiedCount);
        const result = this.count === 0 ? availablePositions : availablePositions.slice(0, targetCount);
        const finalResult = result.map(pos => new RoomPosition(pos.x, pos.y, this.roomName));
        return finalResult;
    }

    toSpec() {
        return {
            ...super.toSpec(),
            structureType: this.structureType,
            pattern: this.pattern,
            roomName: this.roomName,
            priority: this.priority,
            count: this.count
        };
    }

    toJSON() {
        return {
            ...super.toJSON(),
            positions: this.positions
        };
    }
}

module.exports = ConstructionOrder;
