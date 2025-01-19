const logger = require('./logger');

const MAP_SIZE = 50;

// Helper function to check if a pattern's bounding box touches walls
function isValidPosition(positions, terrain) {
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

function calculateCenter(positions) {
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

function offsetPositions(positions, targetPos) {
    const center = calculateCenter(positions);
    const offset = {
        x: targetPos.x - center.x,
        y: targetPos.y - center.y
    };
    
    return positions.map(pos => ({
        x: pos.x + offset.x,
        y: pos.y + offset.y
    }));
}

const patterns = {
    single: ({ startPos }, index) => {
        if (index > 0) {
            return { positions: [], outOfBounds: true };
        }
        return {
            positions: [startPos],
            outOfBounds: false
        };
    },

    checkboard: ({ startPos, size = 3, centered = false }, index) => {
        const positions = [];
        let count = 0;
        const radius = Math.floor(size / 2);
        
        // Generate positions around (0,0)
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
        
        // Offset to target position
        const finalPositions = offsetPositions(positions, startPos);
        
        return {
            positions: finalPositions,
            outOfBounds: count <= index
        };
    },

    line: ({ startPos, size, direction = RIGHT }, index) => {
        const positions = [];
        
        // Generate positions around (0,0)
        for (let i = 0; i < size; i++) {
            if (index === undefined || i === index) {
                positions.push({ x: i - Math.floor(size/2), y: 0 });
            }
        }
        
        // Offset to target position
        const finalPositions = offsetPositions(positions, startPos);
        
        return {
            positions: finalPositions,
            outOfBounds: size <= index
        };
    },

    ring: ({ startPos, radius }, index) => {
        const positions = [];
        let count = 0;
        radius = Math.floor(radius / 2);
        
        // Generate positions around (0,0)
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
        
        // Offset to target position
        const finalPositions = offsetPositions(positions, startPos);
        
        return {
            positions: finalPositions,
            outOfBounds: count <= index
        };
    },

    rectangle: ({ startPos, width, height, filled = false }, index) => {
        const positions = [];
        
        // Generate positions around (0,0)
        for (let i = 0; i < width * height; i++) {
            if (index === undefined || i === index) {
                const row = Math.floor(i / width) - Math.floor(height/2);
                const col = (i % width) - Math.floor(width/2);
                positions.push({ x: col, y: row });
            }
        }
        
        // Offset to target position
        const finalPositions = offsetPositions(positions, startPos);
        
        return {
            positions: finalPositions,
            outOfBounds: width * height <= index
        };
    },

    parallelLines: ({ startPos, size }, index) => {
        const positions = [];
        const totalPositions = size * 4;  // 2 lines * 2 thickness * size length
        
        // Generate positions around (0,0)
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
        
        // Offset to target position
        const finalPositions = offsetPositions(positions, startPos);
        
        return {
            positions: finalPositions,
            outOfBounds: totalPositions <= index
        };
    },

    path: ({ roomName, fromPos, toPos, width, ...pathOpts }, index) => {

        // logger.debug(`Path: Generating for room ${roomName}, index ${index}, from: (${fromPos.x}, ${fromPos.y}), to: (${toPos.x}, ${toPos.y})`);
        const room = Game.rooms[roomName];
        const terrain = room.getTerrain();
        if (!room) {
            // logger.debug(`Path: Room ${roomName} not found`);
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
        // logger.debug(`Path: Found path with ${path.length} steps in ${roomName}`);
        if (path.length === 0) {
            return { positions: [], outOfBounds: true };
        }

        // Calculate path position and perpendicular offset
        const pathIndex = index % path.length;
        const offsetIndex = Math.floor(index / path.length);

        if (offsetIndex >= width) {
            return { positions: [], outOfBounds: true };
        }

        const pathPos = path[pathIndex];
        
        // For first position in width, return the original path position
        if (offsetIndex === 0) {
            return {
                positions: [{ x: pathPos.x, y: pathPos.y }],
                outOfBounds: false
            };
        }

        // Calculate direction vectors for offset
        let dx = 0, dy = 0;
        if (pathIndex < path.length - 1) {
            // Get direction to next point
            dx = path[pathIndex + 1].x - pathPos.x;
            dy = path[pathIndex + 1].y - pathPos.y;
        } else if (pathIndex > 0) {
            // Get direction from previous point
            dx = pathPos.x - path[pathIndex - 1].x;
            dy = pathPos.y - path[pathIndex - 1].y;
        }

        // Calculate offset vectors
        let offsetVectors = [];
        if (dx && dy) {
            // Diagonal movement, try shifting by one direction
            offsetVectors = [
                { x: dx, y: 0 },  // Shift horizontally
                { x: 0, y: dy }   // Shift vertically
            ];
        } else if (dx) {
            // Horizontal movement
            offsetVectors = [
                { x: 0, y: 1 },     // Up
                { x: 0, y: -1 }     // Down
            ];
        } else if (dy) {
            // Vertical movement
            offsetVectors = [
                { x: 1, y: 0 },     // Right
                { x: -1, y: 0 }     // Left
            ];
        }

        // Try to find valid position with current offset
        // Alternate between positive and negative offsets
        const currentOffset = Math.ceil(offsetIndex / 2);
        const isPositiveOffset = offsetIndex % 2 === 1;

        for (const vector of offsetVectors) {
            const testX = pathPos.x + (isPositiveOffset ? vector.x : -vector.x) * currentOffset;
            const testY = pathPos.y + (isPositiveOffset ? vector.y : -vector.y) * currentOffset;

            // Check bounds
            if (testX < 0 || testX >= MAP_SIZE || testY < 0 || testY >= MAP_SIZE) {
                continue;
            }

            // Check terrain
            if (terrain.get(testX, testY) !== TERRAIN_MASK_WALL) {
                return {
                    positions: [{ x: testX, y: testY }],
                    outOfBounds: false
                };
        }
        }

        // If no valid offset position found, return the original path position
        return {
            positions: [{ x: pathPos.x, y: pathPos.y }],
            outOfBounds: false
        };
    },

    patternPlacer: ({ pattern, patternArgs, terrain, targetPos }, index) => {
        // Calculate distances from target to all positions
        const positions = [];
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const dx = x - targetPos.x;
                const dy = y - targetPos.y;
                positions.push({
                    x, y,
                    distance: Math.abs(dx) + Math.abs(dy)  // Manhattan distance
                });
            }
        }
        positions.sort((a, b) => a.distance - b.distance);
        
        // Find all valid positions
        const validPositions = [];
        let currIndex = 0;
        
        for (const pos of positions) {
            // Get all positions for this pattern instance
            const result = pattern({ 
                ...patternArgs, 
                startPos: pos,
                steps: -1
            });
            
            if (isValidPosition(result.positions, terrain)) {
                if (index === undefined || currIndex === index) {
                    // Don't try to center the pattern, use the positions as they are
                    validPositions.push(...result.positions);
                    break;
                }
                currIndex++;
            }
        }

        return {
            positions: validPositions,
            outOfBounds: false
        };
    },
    // WIP - allow to define relative positions and other connections between patterns
    // example usecase: parallel rows of extensions with roads between and outside
    complexPattern: (patterns_, index) => {
        for (let i = 0; i < patterns_.length; i++) {
            const pattern = patterns[patterns_[i].name];
            const result = pattern(patterns_[i].params, undefined);
        }
    }
};

module.exports = patterns;
