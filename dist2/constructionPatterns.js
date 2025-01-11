const patterns = {
    checkboard: (startPos, size = 3) => {
        const positions = [];
        for (let x = 0; x < size; x++) {
            for (let y = 0; y < size; y++) {
                if ((x + y) % 2 === 0) {
                    positions.push({
                        x: startPos.x + x,
                        y: startPos.y + y
                    });
                }
            }
        }
        return positions;
    },

    centeredCheckboard: (centerPos, maxCount) => {
        const positions = [];
        let radius = 1;
        
        // Generate positions in a spiral pattern until we have enough
        while (positions.length < maxCount) {
            for (let x = -radius; x <= radius; x++) {
                for (let y = -radius; y <= radius; y++) {
                    // Skip positions closer to center (already processed)
                    if (Math.abs(x) < radius && Math.abs(y) < radius) continue;
                    
                    // Add position if it forms a checkboard pattern
                    if ((x + y + radius) % 2 === 0) {
                        positions.push({
                            x: centerPos.x + x,
                            y: centerPos.y + y
                        });
                        
                        if (positions.length >= maxCount) {
                            return positions;
                        }
                    }
                }
            }
            radius++;
        }
        
        return positions;
    },

    line: (startPos, length, direction = RIGHT) => {
        const positions = [];
        const dx = direction === RIGHT ? 1 : (direction === LEFT ? -1 : 0);
        const dy = direction === BOTTOM ? 1 : (direction === TOP ? -1 : 0);
        
        for (let i = 0; i < length; i++) {
            positions.push({
                x: startPos.x + (dx * i),
                y: startPos.y + (dy * i)
            });
        }
        return positions;
    },

    path: (room, fromPos, toPos, opts = {}) => {
        const path = room.findPath(
            new RoomPosition(fromPos.x, fromPos.y, room.name),
            new RoomPosition(toPos.x, toPos.y, room.name),
            { swampCost: 1, ...opts }
        );
        return path.map(p => ({ x: p.x, y: p.y }));
    },

    ring: (centerPos, radius) => {
        const positions = [];
        for (let x = -radius; x <= radius; x++) {
            for (let y = -radius; y <= radius; y++) {
                // Only include points that form a ring
                if (Math.abs(x) === radius || Math.abs(y) === radius) {
                    positions.push({
                        x: centerPos.x + x,
                        y: centerPos.y + y
                    });
                }
            }
        }
        return positions;
    },

    rectangle: (startPos, width, height) => {
        const positions = [];
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                positions.push({
                    x: startPos.x + x,
                    y: startPos.y + y
                });
            }
        }
        return positions;
    }
};

function isValidPosition(room, pos) {
    const roomPos = new RoomPosition(pos.x, pos.y, room.name);
    
    // Check terrain
    const terrain = Game.map.getRoomTerrain(room.name);
    if (terrain.get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
        return false;
    }

    // Check for existing structures or construction sites
    const lookResults = roomPos.look();
    for (const result of lookResults) {
        if (result.type === LOOK_STRUCTURES || result.type === LOOK_CONSTRUCTION_SITES) {
            return false;
        }
    }

    return true;
}

module.exports = {
    patterns,
    isValidPosition
};
