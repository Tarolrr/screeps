const Resource = require('./resources.Resource');
const { patterns, isValidPosition } = require('./constructionPatterns');

class ConstructionOrder extends Resource {
    constructor(data) {
        super(data);
        this.structureType = data.structureType;
        this.pattern = data.pattern;
        this.roomName = data.roomName;
        this.priority = data.priority || 0;
        
        // Generate positions immediately since we have all needed data
        const room = Game.rooms[this.roomName];
        if (room) {
            this.positions = this.generatePositions(room);
        } else {
            this.positions = [];
        }
        
        // Track all structures, not just current ones
        this.structures = data.structures || {};
        this.constructionSites = data.constructionSites || {};
    }

    generatePositions(room) {
        const positions = [];
        switch (this.pattern.type) {
            case 'single':
                positions.push(this.pattern.params.pos);
                break;
            case 'checkboard':
                positions.push(...patterns.checkboard(
                    this.pattern.params.startPos,
                    this.pattern.params.size
                ));
                break;
            case 'line':
                positions.push(...patterns.line(
                    this.pattern.params.startPos,
                    this.pattern.params.length,
                    this.pattern.params.direction
                ));
                break;
            case 'path':
                positions.push(...patterns.path(
                    room,
                    this.pattern.params.fromPos,
                    this.pattern.params.toPos
                ));
                break;
            case 'ring':
                positions.push(...patterns.ring(
                    this.pattern.params.centerPos,
                    this.pattern.params.radius
                ));
                break;
            case 'rectangle':
                positions.push(...patterns.rectangle(
                    this.pattern.params.startPos,
                    this.pattern.params.width,
                    this.pattern.params.height
                ));
                break;
        }
        return positions.filter(pos => isValidPosition(room, pos));
    }

    generateSignature(data) {
        return JSON.stringify({
            pattern: data.pattern,
            structureType: data.structureType,
            roomName: data.roomName
        });
    }

    checkStructures(room) {
        // Check all positions for missing structures
        for (let i = 0; i < this.positions.length; i++) {
            const pos = this.positions[i];
            const structureId = this.structures[i];
            
            if (structureId) {
                const structure = Game.getObjectById(structureId);
                if (!structure) {
                    // Structure was destroyed/decayed
                    delete this.structures[i];
                    delete this.constructionSites[i];
                }
            }

            const siteId = this.constructionSites[i];
            if (siteId) {
                const site = Game.getObjectById(siteId);
                if (!site) {
                    // Check if structure exists (might have been completed)
                    const roomPos = new RoomPosition(pos.x, pos.y, this.roomName);
                    const structures = roomPos.lookFor(LOOK_STRUCTURES);
                    const matchingStructure = structures.find(s => s.structureType === this.structureType);
                    
                    if (matchingStructure) {
                        this.structures[i] = matchingStructure.id;
                    }
                    delete this.constructionSites[i];
                }
            }
        }
    }

    needsConstruction(posIndex) {
        return !this.structures[posIndex] && !this.constructionSites[posIndex];
    }

    toJSON() {
        return {
            ...super.toJSON(),
            structureType: this.structureType,
            pattern: this.pattern,
            roomName: this.roomName,
            priority: this.priority,
            positions: this.positions,
            constructionSites: this.constructionSites,
            structures: this.structures
        };
    }
}

module.exports = ConstructionOrder;
