global.Game = {
    rooms: {},
    TERRAIN_MASK_WALL: 1,
    TERRAIN_MASK_SWAMP: 2,
    FIND_CREEPS: 'find_creeps'
};

global.Memory = {
    loggerState: {}
};

global.RIGHT = 3;
global.BOTTOM = 5;
global.BOTTOM_LEFT = 6;
global.LEFT = 7;
global.TOP_LEFT = 8;
global.TOP = 9;
global.TOP_RIGHT = 1;
global.BOTTOM_RIGHT = 2;

global.RoomPosition = class RoomPosition {
    constructor(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    }
};

// Mock room terrain
class RoomTerrain {
    constructor(terrain) {
        this.terrain = terrain;
    }

    get(x, y) {
        return parseInt(this.terrain[y * 50 + x]);
    }
}

// Mock room
class Room {
    constructor(terrain) {
        this._terrain = new RoomTerrain(terrain);
    }

    getTerrain() {
        return this._terrain;
    }

    findPath(fromPos, toPos, opts) {
        // Simple path finding - just return direct line
        const path = [];
        const dx = toPos.x - fromPos.x;
        const dy = toPos.y - fromPos.y;
        const steps = Math.max(Math.abs(dx), Math.abs(dy));
        
        for (let i = 0; i <= steps; i++) {
            const x = Math.round(fromPos.x + (dx * i / steps));
            const y = Math.round(fromPos.y + (dy * i / steps));
            path.push({ x, y });
        }
        
        return path;
    }

    find(type) {
        return []; // No creeps in visualizer
    }
}

module.exports = {
    setTerrain: (roomName, terrain) => {
        Game.rooms[roomName] = new Room(terrain);
    }
};
