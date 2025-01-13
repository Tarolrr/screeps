const logger = require('./logger');

const MAP_SIZE = 50;

const patterns = {
    single: ({ pos }, index) => {
        if (index > 0) {
            return { positions: [], outOfBounds: true };
        }
        
        const x = pos.x;
        const y = pos.y;
        const outOfBounds = x < 0 || x >= MAP_SIZE || y < 0 || y >= MAP_SIZE;
        
        return {
            positions: outOfBounds ? [] : [pos],
            outOfBounds
        };
    },

    checkboard: ({ startPos, size = 3, centered = false }, index) => {
        const positions = [];
        let outOfBounds = false;
        
        if (centered) {
            const radius = Math.floor(size / 2);
            let count = 0;
            
            for (let x = -radius; x <= radius && count <= index; x++) {
                for (let y = -radius; y <= radius && count <= index; y++) {
                    const newX = startPos.x + x;
                    const newY = startPos.y + y;
                    
                    if ((x + y) % 2 === 0) {
                        if (newX >= 0 && newX < MAP_SIZE && newY >= 0 && newY < MAP_SIZE) {
                            if (count === index) {
                                positions.push({ x: newX, y: newY });
                            }
                            count++;
                        }
                    }
                }
            }
            
            if (count <= index) {
                outOfBounds = true;
            }
            
        } else {
            let count = 0;
            for (let x = 0; x < size && count <= index; x++) {
                for (let y = 0; y < size && count <= index; y++) {
                    const newX = startPos.x + x;
                    const newY = startPos.y + y;
                    
                    if ((x + y) % 2 === 0) {
                        if (newX >= 0 && newX < MAP_SIZE && newY >= 0 && newY < MAP_SIZE) {
                            if (count === index) {
                                positions.push({ x: newX, y: newY });
                            }
                            count++;
                        } else {
                            outOfBounds = true;
                        }
                    }
                }
            }
            
            if (count <= index) {
                outOfBounds = true;
            }
        }
        
        return { positions, outOfBounds };
    },

    line: ({ startPos, direction = RIGHT }, index) => {
        const dx = direction === RIGHT ? 1 : (direction === LEFT ? -1 : 0);
        const dy = direction === BOTTOM ? 1 : (direction === TOP ? -1 : 0);
        
        const x = startPos.x + (dx * index);
        const y = startPos.y + (dy * index);
        
        const outOfBounds = x < 0 || x >= MAP_SIZE || y < 0 || y >= MAP_SIZE;
        
        return {
            positions: outOfBounds ? [] : [{ x, y }],
            outOfBounds
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

    ring: ({ centerPos, radius }, index) => {
        const positions = [];
        let count = 0;
        let outOfBounds = false;
        
        // Calculate total points in ring
        const totalPoints = radius * 8;
        if (index >= totalPoints) {
            return { positions: [], outOfBounds: true };
        }
        
        // Generate points in clockwise order
        for (let x = -radius; x <= radius && count <= index; x++) {
            for (let y = -radius; y <= radius && count <= index; y++) {
                if (Math.abs(x) === radius || Math.abs(y) === radius) {
                    const newX = centerPos.x + x;
                    const newY = centerPos.y + y;
                    
                    if (newX >= 0 && newX < MAP_SIZE && newY >= 0 && newY < MAP_SIZE) {
                        if (count === index) {
                            positions.push({ x: newX, y: newY });
                        }
                        count++;
                    } else {
                        outOfBounds = true;
                    }
                }
            }
        }
        
        return { positions, outOfBounds };
    },

    rectangle: ({ startPos, width, height, filled = false }, index) => {
        const positions = [];
        let count = 0;
        let outOfBounds = false;
        
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                const newX = startPos.x + x;
                const newY = startPos.y + y;
                
                if (filled || x === 0 || x === width - 1 || y === 0 || y === height - 1) {
                    if (newX >= 0 && newX < MAP_SIZE && newY >= 0 && newY < MAP_SIZE) {
                        if (count === index) {
                            positions.push({ x: newX, y: newY });
                            return { positions, outOfBounds };
                        }
                        count++;
                    } else {
                        outOfBounds = true;
                    }
                }
            }
        }
        
        return { positions: [], outOfBounds: true };
    }
};

module.exports = patterns;
