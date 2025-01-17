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

const patterns = {
    single: ({ startPos }, index) => {
        if (index === undefined) {
            return {
                positions: [startPos],
                outOfBounds: false
            };
        }
        
        if (index > 0) {
            return { positions: [], outOfBounds: true };
        }
        
        return {
            positions: [startPos],
            outOfBounds: true
        };
    },

    checkboard: ({ startPos, size = 3, centered = false }, index) => {
        const positions = [];
        
        if (centered) {
            const radius = Math.floor(size / 2);
            
            for (let x = -radius; x <= radius; x++) {
                for (let y = -radius; y <= radius; y++) {
                    if ((x + y) % 2 === 0) {
                        const newX = startPos.x + x;
                        const newY = startPos.y + y;
                        
                        if (newX >= 0 && newX < MAP_SIZE && newY >= 0 && newY < MAP_SIZE) {
                            positions.push({ x: newX, y: newY });
                        }
                    }
                }
            }
        } else {
            for (let x = 0; x < size; x++) {
                for (let y = 0; y < size; y++) {
                    if ((x + y) % 2 === 0) {
                        const newX = startPos.x + x;
                        const newY = startPos.y + y;
                        
                        if (newX >= 0 && newX < MAP_SIZE && newY >= 0 && newY < MAP_SIZE) {
                            positions.push({ x: newX, y: newY });
                        }
                    }
                }
            }
        }

        if (index === undefined) {
            return { positions, outOfBounds: false };
        }

        return {
            positions: index < positions.length ? [positions[index]] : [],
            outOfBounds: index >= positions.length
        };
    },

    line: ({ startPos, size, direction = RIGHT }, index) => {
        const positions = [];
        const dx = direction === RIGHT ? 1 : (direction === LEFT ? -1 : 0);
        const dy = direction === BOTTOM ? 1 : (direction === TOP ? -1 : 0);
        
        for (let i = 0; i < size; i++) {
            const x = startPos.x + (dx * i);
            const y = startPos.y + (dy * i);
            
            if (x >= 0 && x < MAP_SIZE && y >= 0 && y < MAP_SIZE) {
                positions.push({ x, y });
            }
        }

        if (index === undefined) {
            return { positions, outOfBounds: false };
        }

        return {
            positions: index < positions.length ? [positions[index]] : [],
            outOfBounds: index >= positions.length
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

    ring: ({ startPos, radius }, index) => {
        const positions = [];
        
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                if (Math.abs(dx) === radius || Math.abs(dy) === radius) {
                    const x = startPos.x + dx;
                    const y = startPos.y + dy;
                    if (x >= 0 && x < MAP_SIZE && y >= 0 && y < MAP_SIZE) {
                        positions.push({ x, y });
                    }
                }
            }
        }

        if (index === undefined) {
            return { positions, outOfBounds: false };
        }

        return {
            positions: index < positions.length ? [positions[index]] : [],
            outOfBounds: index >= positions.length
        };
    },

    rectangle: ({ startPos, width, height, filled = false }, index) => {
        const positions = [];
        
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                if (filled || x === 0 || x === width - 1 || y === 0 || y === height - 1) {
                    const newX = startPos.x + x;
                    const newY = startPos.y + y;
                    if (newX >= 0 && newX < MAP_SIZE && newY >= 0 && newY < MAP_SIZE) {
                        positions.push({ x: newX, y: newY });
                    }
                }
            }
        }

        if (index === undefined) {
            return { positions, outOfBounds: false };
        }

        return {
            positions: index < positions.length ? [positions[index]] : [],
            outOfBounds: index >= positions.length
        };
    },

    parallelLines: ({ startPos, size }, index) => {
        const positions = [];
        
        for (let i = 0; i < size; i++) {
            // First line
            const x1 = startPos.x + i;
            const y1 = startPos.y;
            if (x1 >= 0 && x1 < MAP_SIZE && y1 >= 0 && y1 < MAP_SIZE) {
                positions.push({ x: x1, y: y1 });
            }
            const y2 = startPos.y + 1;
            if (x1 >= 0 && x1 < MAP_SIZE && y2 >= 0 && y2 < MAP_SIZE) {
                positions.push({ x: x1, y: y2 });
            }

            // Second line (with gap)
            const y3 = startPos.y + 3;
            if (x1 >= 0 && x1 < MAP_SIZE && y3 >= 0 && y3 < MAP_SIZE) {
                positions.push({ x: x1, y: y3 });
            }
            const y4 = startPos.y + 4;
            if (x1 >= 0 && x1 < MAP_SIZE && y4 >= 0 && y4 < MAP_SIZE) {
                positions.push({ x: x1, y: y4 });
            }
        }

        if (index === undefined) {
            return { positions, outOfBounds: false };
        }

        return {
            positions: index < positions.length ? [positions[index]] : [],
            outOfBounds: index >= positions.length
        };
    },

    patternPlacer: ({ pattern, patternArgs, terrain, targetPos }, index) => {
        // Calculate distances from target to all positions
        const positions = [];
        for (let y = 0; y < MAP_SIZE; y++) {
            for (let x = 0; x < MAP_SIZE; x++) {
                const distance = Math.max(Math.abs(x - targetPos.x), Math.abs(y - targetPos.y));
                positions.push({ x, y, distance });
            }
        }
        
        // Sort positions by distance from target
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
    }
};

module.exports = patterns;
