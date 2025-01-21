const Resource = require('./resources.Resource');
const patterns = require('./constructionPatterns');
const resourceManager = require('./resourceManager');
const logger = require('./logger');

class ConstructionOrder extends Resource {
    static get STATE_SCHEMA() {
        return Resource.combineSchemas(Resource.STATE_SCHEMA, {
            positions: 'object',  // array of positions
            ownedStructureIds: 'object',  // array of structure IDs we own
            hasWrongTypeStructures: 'boolean',
            hasWrongPositionStructures: 'boolean',
            enabled: 'boolean'
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
        if (Array.isArray(data.positions) && data.positions.length > 0) {
            this.positions = data.positions;
        } else {
            this.positions = this.generatePositions();
        }
        
        this.ownedStructureIds = data.ownedStructureIds || [];
        this._previousType = this.structureType;
        this.hasWrongTypeStructures = false;
        this.hasWrongPositionStructures = false;
    }

    onSpecUpdate() {
        this.hasWrongPositionStructures = true;
        const oldPositions = this.positions;
        this.positions = this.generatePositions();
        
        if (this.structureType === this._previousType) {
            this.claimStructures(oldPositions);
        } else {
            this.hasWrongTypeStructures = true;
        }
        this.claimStructures(this.positions);
        this.validateOwnedStructures();
        this.removeExcessStructures();
        
        this._previousType = this.structureType;
    }

    generatePositions() {
        const room = Game.rooms[this.roomName];

        // const constructionOrders = resourceManager.getResourcesOfType('constructionOrder')
        //     .filter(order => order.roomName === this.roomName && order.structureType

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
        
        // Only generate sites for positions that don't have our owned structures and don't have construction sites
        const availablePositions = this.positions.filter(pos => {
            return !this.ownedStructureIds.some(id => {
                const structure = Game.getObjectById(id);
                return structure && 
                       structure.pos.x === pos.x && 
                       structure.pos.y === pos.y;
            })&& !Game.rooms[this.roomName].lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).some(s => {
                return s.structureType === this.structureType || ![STRUCTURE_ROAD, STRUCTURE_RAMPART].includes(s.structureType);
            });
        });
        
        return availablePositions
            .slice(0, count)
            .map(pos => new RoomPosition(pos.x, pos.y, this.roomName));
    }

    validateOwnedStructures() {
        this.ownedStructureIds = this.ownedStructureIds.filter(id => {
            return Game.getObjectById(id);
        });
    }

    claimStructures(positions) {
        const room = Game.rooms[this.roomName];
        for (const pos of positions) {
            const structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y)
                .filter(s => s.structureType === this.structureType);
            
            for (const structure of structures) {
                if (!this.ownedStructureIds.includes(structure.id)) {
                    this.ownedStructureIds.push(structure.id);
                }
            }
        }
    }

    removeExcessStructures() {
        // clean structures of wrong type from previous specs. 
        // (can't remove them in onSpecUpdate() because of possible hostile creeps)
        let count = this.ownedStructureIds.length;
        
        if (this.hasWrongTypeStructures) {
            this.hasWrongTypeStructures = false;
            for (const id of this.ownedStructureIds) {
                const structure = Game.getObjectById(id);
                if (structure.structureType !== this.structureType) {
                    if (structure.destroy() === OK) {
                        count--;
                    }
                    else {
                        this.hasWrongTypeStructures = true;
                    }
                }
            }
        }
        // in case we don't have limit, remove all structures in wrong positions
        if (!this.count) {
            this.hasWrongPositionStructures = false;
            for (const id of this.ownedStructureIds) {
                const structure = Game.getObjectById(id);
                const pos = structure.pos;
                if (!this.positions.some(p => p.x === pos.x && p.y === pos.y)) {
                    if (structure.destroy() !== OK) {
                        this.hasWrongPositionStructures = true;
                    }
                }
            }
        }
        // remove excess structures if we're over count
        else {
            if (this.hasWrongPositionStructures) {
                while (count >= this.count) {
                    let tmpWrongPositionStructures = false;
                    for (const id of this.ownedStructureIds) {
                        const structure = Game.getObjectById(id);
                        const pos = structure.pos;
                        if (!this.positions.some(p => p.x === pos.x && p.y === pos.y)) {
                            if (structure.destroy() === OK) {
                                count--;
                                tmpWrongPositionStructures = true;
                                break;
                            } else {
                                // If we can't destroy it, there's probably 
                                // a hostile creep in the room - doesn't make sense to continue
                                return;
                            }
                        }
                    }
                    if (!tmpWrongPositionStructures) {
                        this.hasWrongPositionStructures = false;
                        break;
                    }
                }
                // restriction is less strict for right position structures
                // so we don't delete and recreate the last one
                while (count > this.count) {
                    for (let i = this.positions.length - 1; i >= 0; i--) {
                        const pos = this.positions[i];
                        const structuresAtPos = Game.rooms[this.roomName].lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
                        const structure = structuresAtPos.find(s => s.structureType === this.structureType);
                        if (structure) {
                            if (structure.destroy() === OK) {
                                count--;
                                if (count <= this.count) {
                                    return;
                                }
                            } else {
                                return;
                            }
                        }
                    }
                }
            }
        }
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
            positions: this.positions,
            ownedStructureIds: this.ownedStructureIds,
            hasWrongTypeStructures: this.hasWrongTypeStructures,
            hasWrongPositionStructures: this.hasWrongPositionStructures,
        };
    }
}

module.exports = ConstructionOrder;
