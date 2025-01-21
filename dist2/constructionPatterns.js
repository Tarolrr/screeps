const logger = require('./logger');

const MAP_SIZE = 50;

// Pattern Registry - Singleton
class PatternRegistry {
    constructor() {
        this._patterns = new Map();
    }

    register(pattern) {
        this._patterns.set(pattern.name, pattern);
    }

    get(patternName) {
        return this._patterns.get(patternName);
    }

    getPatterns() {
        return Array.from(this._patterns).reduce((obj, [key, value]) => {
            obj[key] = value;
            return obj;
        }, {});
    }
}

const registry = new PatternRegistry();

class ConstructionPattern {
    constructor(name) {
        this.name = name;
    }

    isValidPosition(positions, terrain) {
        if (!positions.length) return false;
        
        let minX = MAP_SIZE, minY = MAP_SIZE, maxX = 0, maxY = 0;
        positions.forEach(pos => {
            minX = Math.min(minX, pos.x);
            minY = Math.min(minY, pos.y);
            maxX = Math.max(maxX, pos.x);
            maxY = Math.max(maxY, pos.y);
        });

        // Check map bounds
        if (minX < 0 || minY < 0 || maxX >= MAP_SIZE || maxY >= MAP_SIZE) {
            return false;
        }

        // Check walls
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const terrainType = terrain[y * MAP_SIZE + x];
                if (terrainType === '1' || terrainType === '3') {  // Wall
                    return false;
                }
            }
        }

        return true;
    }

    calculateCenter(positions) {
        if (positions.length === 0) return { x: 0, y: 0 };
        
        const sum = positions.reduce((acc, pos) => {
            acc.x += pos.x;
            acc.y += pos.y;
            return acc;
        }, { x: 0, y: 0 });
        
        return {
            x: Math.round(sum.x / positions.length),
            y: Math.round(sum.y / positions.length)
        };
    }

    offsetPositions(positions, targetPos) {
        const center = this.calculateCenter(positions);
        const offset = {
            x: targetPos.x - center.x,
            y: targetPos.y - center.y
        };
        
        return positions.map(pos => ({
            x: pos.x + offset.x,
            y: pos.y + offset.y
        }));
    }

    // Abstract method to be implemented by child classes
    getPositions(args, index) {
        throw new Error('getPositions must be implemented by child class');
    }
}

class SinglePattern extends ConstructionPattern {
    constructor() {
        super('single');
    }

    getPositions({ startPos }, index) {
        if (index > 0) {
            return { positions: [], outOfBounds: true };
        }
        return {
            positions: [startPos],
            outOfBounds: false
        };
    }
}

class CheckboardPattern extends ConstructionPattern {
    constructor() {
        super('checkboard');
    }

    getPositions({ startPos, size = 3 }, index) {
        const positions = [];
        let count = 0;
        const radius = Math.floor(size / 2);
        
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                if ((dx + dy) % 2 === 0) {
                    if (index === undefined || count === index) {
                        positions.push({ x: dx, y: dy });
                    }
                    count++;
                }
            }
        }
        
        const finalPositions = this.offsetPositions(positions, startPos);
        
        return {
            positions: finalPositions,
            outOfBounds: count <= index
        };
    }
}

class LinePattern extends ConstructionPattern {
    constructor() {
        super('line');
    }

    getPositions({ startPos, size, direction = RIGHT }, index) {
        const positions = [];
        
        for (let i = 0; i < size; i++) {
            if (index === undefined || i === index) {
                positions.push({ x: i - Math.floor(size/2), y: 0 });
            }
        }
        
        const finalPositions = this.offsetPositions(positions, startPos);
        
        return {
            positions: finalPositions,
            outOfBounds: size <= index
        };
    }
}

class RingPattern extends ConstructionPattern {
    constructor() {
        super('ring');
    }

    getPositions({ startPos, radius }, index) {
        const positions = [];
        let count = 0;
        radius = Math.floor(radius / 2);
        
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                if (Math.abs(dx) === radius || Math.abs(dy) === radius) {
                    if (index === undefined || count === index) {
                        positions.push({ x: dx, y: dy });
                    }
                    count++;
                }
            }
        }
        
        const finalPositions = this.offsetPositions(positions, startPos);
        
        return {
            positions: finalPositions,
            outOfBounds: count <= index
        };
    }
}

class RectanglePattern extends ConstructionPattern {
    constructor() {
        super('rectangle');
    }

    getPositions({ startPos, width, height, filled = false }, index) {
        const positions = [];
        
        for (let i = 0; i < width * height; i++) {
            if (index === undefined || i === index) {
                const row = Math.floor(i / width) - Math.floor(height/2);
                const col = (i % width) - Math.floor(width/2);
                positions.push({ x: col, y: row });
            }
        }
        
        const finalPositions = this.offsetPositions(positions, startPos);
        
        return {
            positions: finalPositions,
            outOfBounds: width * height <= index
        };
    }
}

class ParallelLinesPattern extends ConstructionPattern {
    constructor() {
        super('parallelLines');
    }

    getPositions({ startPos, size }, index) {
        const positions = [];
        const totalPositions = size * 4;  // 2 lines * 2 thickness * size length
        
        for (let i = 0; i < totalPositions; i++) {
            if (index === undefined || i === index) {
                const lineIndex = Math.floor(i / size);  // 0-3 for the four parallel rows
                const positionInLine = i % size - Math.floor(size/2);
                positions.push({
                    x: positionInLine,
                    y: (lineIndex < 2 ? lineIndex : lineIndex + 1) - 2  // Add 1 space gap between lines, center vertically
                });
            }
        }
        
        const finalPositions = this.offsetPositions(positions, startPos);
        
        return {
            positions: finalPositions,
            outOfBounds: totalPositions <= index
        };
    }
}

class PathPattern extends ConstructionPattern {
    constructor() {
        super('path');
    }

    getPositions({ roomName, fromPos, toPos, width, ...pathOpts }, index) {
        const room = Game.rooms[roomName];
        const terrain = room.getTerrain();
        if (!room) {
            return { positions: [], outOfBounds: true };
        }
        const fromRoomPos = new RoomPosition(fromPos.x, fromPos.y, roomName);
        const toRoomPos = new RoomPosition(toPos.x, toPos.y, roomName);
        const path = room.findPath(fromRoomPos, toRoomPos, {
            ...pathOpts,
            costCallback: (roomName, costMatrix) => {
                const room = Game.rooms[roomName];
                const terrain = room.getTerrain();
                for (let x = 0; x < MAP_SIZE; x++) {
                    for (let y = 0; y < MAP_SIZE; y++) {
                        if (terrain.get(x, y) === TERRAIN_MASK_SWAMP) {
                            costMatrix.set(x, y, 1);
                        }
                    }
                }
                room.find(FIND_CREEPS).forEach(creep => {
                    costMatrix.set(creep.pos.x, creep.pos.y, 1);
                });

                return costMatrix;
            }
        });
        if (path.length === 0) {
            return { positions: [], outOfBounds: true };
        }

        const pathIndex = index % path.length;
        const offsetIndex = Math.floor(index / path.length);

        if (offsetIndex >= width) {
            return { positions: [], outOfBounds: true };
        }

        const pathPos = path[pathIndex];
        
        if (offsetIndex === 0) {
            return {
                positions: [{ x: pathPos.x, y: pathPos.y }],
                outOfBounds: false
            };
        }

        let dx = 0, dy = 0;
        if (pathIndex < path.length - 1) {
            dx = path[pathIndex + 1].x - pathPos.x;
            dy = path[pathIndex + 1].y - pathPos.y;
        } else if (pathIndex > 0) {
            dx = pathPos.x - path[pathIndex - 1].x;
            dy = pathPos.y - path[pathIndex - 1].y;
        }

        let offsetVectors = [];
        if (dx && dy) {
            offsetVectors = [
                { x: dx, y: 0 },  
                { x: 0, y: dy }   
            ];
        } else if (dx) {
            offsetVectors = [
                { x: 0, y: 1 },     
                { x: 0, y: -1 }     
            ];
        } else if (dy) {
            offsetVectors = [
                { x: 1, y: 0 },     
                { x: -1, y: 0 }     
            ];
        }

        const currentOffset = Math.ceil(offsetIndex / 2);
        const isPositiveOffset = offsetIndex % 2 === 1;

        for (const vector of offsetVectors) {
            const testX = pathPos.x + (isPositiveOffset ? vector.x : -vector.x) * currentOffset;
            const testY = pathPos.y + (isPositiveOffset ? vector.y : -vector.y) * currentOffset;

            if (testX < 0 || testX >= MAP_SIZE || testY < 0 || testY >= MAP_SIZE) {
                continue;
            }

            if (terrain.get(testX, testY) !== TERRAIN_MASK_WALL) {
                return {
                    positions: [{ x: testX, y: testY }],
                    outOfBounds: false
                };
            }
        }

        return {
            positions: [{ x: pathPos.x, y: pathPos.y }],
            outOfBounds: false
        };
    }
}

class PatternPlacerPattern extends ConstructionPattern {
    constructor() {
        super('patternPlacer');
    }

    getPositions({ pattern, patternArgs, terrain, targetPos }, index) {
        const patternInstance = registry.get(pattern);
        if (!patternInstance) {
            throw new Error(`Unknown pattern: ${pattern}`);
        }

        const positions = [];
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const dx = x - targetPos.x;
                const dy = y - targetPos.y;
                positions.push({
                    x, y,
                    distance: Math.abs(dx) + Math.abs(dy)  
                });
            }
        }
        positions.sort((a, b) => a.distance - b.distance);
        
        // Try each position until we find a valid one for the current index
        for (const pos of positions) {
            const result = patternInstance.getPositions({ 
                ...patternArgs, 
                startPos: pos
            }, index);

            if (result.outOfBounds) {
                continue;
            }

            if (this.isValidPosition(result.positions, terrain)) {
                return {
                    positions: result.positions,
                    outOfBounds: false
                };
            }
        }

        return {
            positions: [],
            outOfBounds: true
        };
    }
}

// Register all patterns
registry.register(new SinglePattern());
registry.register(new CheckboardPattern());
registry.register(new LinePattern());
registry.register(new RingPattern());
registry.register(new RectanglePattern());
registry.register(new ParallelLinesPattern());
registry.register(new PathPattern());
registry.register(new PatternPlacerPattern());

module.exports = { patterns: registry.getPatterns() };
