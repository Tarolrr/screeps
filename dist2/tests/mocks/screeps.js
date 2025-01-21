// Game constants
global.OK = 0;
global.ERR_NOT_OWNER = -1;
global.ERR_NO_PATH = -2;
global.ERR_NAME_EXISTS = -3;
global.ERR_BUSY = -4;
global.ERR_NOT_FOUND = -5;
global.ERR_NOT_ENOUGH_ENERGY = -6;
global.ERR_NOT_ENOUGH_RESOURCES = -6;
global.ERR_INVALID_TARGET = -7;
global.ERR_FULL = -8;
global.ERR_NOT_IN_RANGE = -9;
global.ERR_INVALID_ARGS = -10;
global.ERR_TIRED = -11;
global.ERR_NO_BODYPART = -12;
global.ERR_NOT_ENOUGH_EXTENSIONS = -6;
global.ERR_RCL_NOT_ENOUGH = -14;
global.ERR_GCL_NOT_ENOUGH = -15;

global.FIND_EXIT_TOP = 1;
global.FIND_EXIT_RIGHT = 3;
global.FIND_EXIT_BOTTOM = 5;
global.FIND_EXIT_LEFT = 7;
global.FIND_EXIT = 10;
global.FIND_CREEPS = 101;
global.FIND_MY_CREEPS = 102;
global.FIND_HOSTILE_CREEPS = 103;
global.FIND_SOURCES_ACTIVE = 104;
global.FIND_SOURCES = 105;
global.FIND_DROPPED_RESOURCES = 106;
global.FIND_STRUCTURES = 107;
global.FIND_MY_STRUCTURES = 108;
global.FIND_HOSTILE_STRUCTURES = 109;
global.FIND_FLAGS = 110;
global.FIND_CONSTRUCTION_SITES = 111;
global.FIND_MY_SPAWNS = 112;
global.FIND_HOSTILE_SPAWNS = 113;
global.FIND_MY_CONSTRUCTION_SITES = 114;
global.FIND_HOSTILE_CONSTRUCTION_SITES = 115;
global.FIND_MINERALS = 116;
global.FIND_NUKES = 117;
global.FIND_TOMBSTONES = 118;
global.FIND_POWER_CREEPS = 119;
global.FIND_MY_POWER_CREEPS = 120;
global.FIND_HOSTILE_POWER_CREEPS = 121;
global.FIND_DEPOSITS = 122;
global.FIND_RUINS = 123;

global.TOP = 1;
global.TOP_RIGHT = 2;
global.RIGHT = 3;
global.BOTTOM_RIGHT = 4;
global.BOTTOM = 5;
global.BOTTOM_LEFT = 6;
global.LEFT = 7;
global.TOP_LEFT = 8;

global.LOOK_CREEPS = "creep";
global.LOOK_ENERGY = "energy";
global.LOOK_RESOURCES = "resource";
global.LOOK_SOURCES = "source";
global.LOOK_MINERALS = "mineral";
global.LOOK_DEPOSITS = "deposit";
global.LOOK_STRUCTURES = "structure";
global.LOOK_FLAGS = "flag";
global.LOOK_CONSTRUCTION_SITES = "constructionSite";
global.LOOK_NUKES = "nuke";
global.LOOK_TERRAIN = "terrain";
global.LOOK_TOMBSTONES = "tombstone";
global.LOOK_POWER_CREEPS = "powerCreep";
global.LOOK_RUINS = "ruin";

global.STRUCTURE_SPAWN = "spawn";
global.STRUCTURE_EXTENSION = "extension";
global.STRUCTURE_ROAD = "road";
global.STRUCTURE_WALL = "constructedWall";
global.STRUCTURE_RAMPART = "rampart";
global.STRUCTURE_KEEPER_LAIR = "keeperLair";
global.STRUCTURE_PORTAL = "portal";
global.STRUCTURE_CONTROLLER = "controller";
global.STRUCTURE_LINK = "link";
global.STRUCTURE_STORAGE = "storage";
global.STRUCTURE_TOWER = "tower";
global.STRUCTURE_OBSERVER = "observer";
global.STRUCTURE_POWER_BANK = "powerBank";
global.STRUCTURE_POWER_SPAWN = "powerSpawn";
global.STRUCTURE_EXTRACTOR = "extractor";
global.STRUCTURE_LAB = "lab";
global.STRUCTURE_TERMINAL = "terminal";
global.STRUCTURE_CONTAINER = "container";
global.STRUCTURE_NUKER = "nuker";
global.STRUCTURE_FACTORY = "factory";
global.STRUCTURE_INVADER_CORE = "invaderCore";

// Controller structures
global.CONTROLLER_STRUCTURES = {
    spawn: { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 },
    extension: { 0: 0, 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 },
    road: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 },
    constructedWall: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 },
    rampart: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 },
    link: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 2, 6: 3, 7: 4, 8: 6 },
    storage: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
    tower: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 },
    observer: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1 },
    powerSpawn: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 1 }
};

// Game object
global.Game = {
    rooms: {},
    getObjectById: () => null,
    time: 0
};

// Memory object required for tests
global.Memory = {
    loggerState: {
        currentLevel: 'debug'
    },
    resourceManager: {
        resources: {}
    }
};

class MockStructure {
    constructor(id, pos, type) {
        this.id = id;
        this.pos = pos;
        this.structureType = type;
        this._destroyed = false;
        this._failDestroy = false;
    }

    destroy() {
        if (this._failDestroy) return ERR_BUSY;
        this._destroyed = true;
        return OK;
    }
}

class MockRoom {
    constructor(name) {
        this.name = name;
        this._structures = [];
        this._constructionSites = [];
        this.controller = {
            pos: new RoomPosition(25, 25, name),
            level: 5
        };
    }

    // Helper methods for tests
    _addStructure(structure) {
        this._structures.push(structure);
    }

    _addConstructionSite(site) {
        this._constructionSites.push(site);
    }

    _removeStructure(id) {
        const index = this._structures.findIndex(s => s.id === id);
        if (index !== -1) {
            this._structures.splice(index, 1);
            return true;
        }
        return false;
    }

    find(type) {
        switch(type) {
            case FIND_MY_STRUCTURES:
                return this._structures;
            case FIND_MY_CONSTRUCTION_SITES:
                return this._constructionSites;
            case FIND_MY_SPAWNS:
                return this._structures.filter(s => s.structureType === 'spawn');
            default:
                return [];
        }
    }

    lookForAt(type, x, y) {
        switch(type) {
            case LOOK_STRUCTURES:
                return this._structures.filter(s => s.pos.x === x && s.pos.y === y);
            case LOOK_CONSTRUCTION_SITES:
                return this._constructionSites.filter(s => s.pos.x === x && s.pos.y === y);
            default:
                return [];
        }
    }

    createConstructionSite(x, y, type) {
        const site = new MockConstructionSite(`${type}_${x}_${y}`, { x, y });
        this._constructionSites.push(site);
        return OK;
    }

    getTerrain() {
        return {
            get(x, y) {
                return 0;
            }
        };
    }
}

class MockRoomPosition {
    constructor(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    }
}

class MockConstructionSite {
    constructor(id, pos) {
        this.id = id;
        this.pos = pos;
    }
}
// // Mock Game object and its components
// class MockStructure {
//     constructor(id, pos, structureType) {
//         this.id = id;
//         this.pos = pos;
//         this.structureType = structureType;
//         this._destroyed = false;
//         this._failDestroy = false;
//     }

//     destroy() {
//         if (this._failDestroy) return ERR_BUSY;
//         this._destroyed = true;
//         return OK;
//     }
// }

// class MockConstructionSite {
//     constructor(id, pos, structureType = 'extension') {
//         this.id = id;
//         this.pos = pos;
//         this.structureType = structureType;
//         this.progress = 0;
//         this.progressTotal = 100;
//     }
// }

// class MockRoom {
//     constructor(name) {
//         this.name = name;
//         this._structures = [];
//         this._constructionSites = [];
//         this.controller = {
//             pos: new RoomPosition(25, 25, name),
//             level: 5
//         };
//     }

//     // Helper methods for tests
//     _addStructure(structure) {
//         this._structures.push(structure);
//     }

//     _removeStructure(id) {
//         const index = this._structures.findIndex(s => s.id === id);
//         if (index !== -1) {
//             this._structures.splice(index, 1);
//         }
//     }

//     _addConstructionSite(site) {
//         this._constructionSites.push(site);
//     }

//     find(type) {
//         if (type === FIND_MY_SPAWNS) {
//             return this._structures.filter(s => s.structureType === 'spawn');
//         }
//         if (type === FIND_MY_CONSTRUCTION_SITES) {
//             return this._constructionSites;
//         }
//         return [];
//     }

//     lookForAt(type, x, y) {
//         if (type === LOOK_STRUCTURES) {
//             return this._structures.filter(s => s.pos.x === x && s.pos.y === y && !s._destroyed);
//         }
//         if (type === LOOK_CONSTRUCTION_SITES) {
//             return this._constructionSites.filter(s => s.pos.x === x && s.pos.y === y);
//         }
//         return [];
//     }

//     createConstructionSite(x, y, structureType) {
//         // Check if there's already a structure or site here
//         const structures = this.lookForAt(LOOK_STRUCTURES, x, y);
//         const sites = this.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
        
//         if (structures.length > 0 || sites.length > 0) {
//             return ERR_INVALID_TARGET;
//         }

//         const site = new MockConstructionSite(`site_${x}_${y}`, { x, y }, structureType);
//         this._constructionSites.push(site);
//         return OK;
//     }

//     getTerrain() {
//         return {
//             get(x, y) {
//                 return 0;
//             }
//         };
//     }
// }

// class MockRoomPosition {
//     constructor(x, y, roomName) {
//         this.x = x;
//         this.y = y;
//         this.roomName = roomName;
//     }

//     lookFor(type) {
//         const room = Game.rooms[this.roomName];
//         if (!room) return [];
//         return room.lookForAt(type, this.x, this.y);
//     }
// }


// Creep parts
global.MOVE = "move";
global.WORK = "work";
global.CARRY = "carry";
global.ATTACK = "attack";
global.RANGED_ATTACK = "ranged_attack";
global.TOUGH = "tough";
global.HEAL = "heal";
global.CLAIM = "claim";

// Game globals
global.Memory = {
    loggerState: {
        currentLevel: 'debug'
    },
    resourceManager: {
        resources: {}
    }
};

global.Game = {
    rooms: {},
    time: 0,
    getObjectById: (id) => {
        for (const room of Object.values(Game.rooms)) {
            if (room._structures.find(s => s.id === id)) {
                const structure = room._structures.find(s => s.id === id);
                return structure._destroyed ? null : structure;
            }
            if (room._constructionSites.find(s => s.id === id)) {
                return room._constructionSites.find(s => s.id === id);
            }
        }
        return null;
    }
};

// RoomPosition constructor
global.RoomPosition = MockRoomPosition;

module.exports = {
    MockStructure,
    MockRoom,
    MockConstructionSite,
    MockRoomPosition,
    // Helper functions for tests
    resetGameState: () => {
        Game.rooms = {};
        Game.time = 0;
        Memory.resourceManager.resources = {};
    }
};
