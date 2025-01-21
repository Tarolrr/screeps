// Mock Memory object first
global.Memory = {
    loggerState: {
        currentLevel: 'debug'
    },
    resourceManager: {
        resources: {}
    }
};

// Mock CreepOrder
jest.mock('../resources.creepOrder', () => ({
    SCHEMAS: {
        BUILDER: {
            constantParts: ['move', 'carry', 'work'],
            ratioParts: { 'work': 1 },
            maxCost: 700
        },
        MULE: {
            constantParts: ['move', 'carry'],
            ratioParts: { 'carry': 1 },
            maxCost: 600
        }
    }
}));

const { MockRoom, MockStructure, MockConstructionSite } = require('./mocks/screeps');
const resourceManager = require('../resourceManager');
const ConstructionOrder = require('../resources.constructionOrder');
const BuildController = require('../BuildController');
const logger = require('../logger');
logger.setLevel('debug');

describe('BuildController', () => {
    let controller;
    let testRoom;
    let spawn;

    beforeEach(() => {
        // Reset game state
        testRoom = new MockRoom('test');
        spawn = new MockStructure('spawn1', { x: 25, y: 25 }, 'spawn');
        testRoom._addStructure(spawn);

        // Set up Game object
        global.Game = {
            rooms: { test: testRoom },
            time: 100,
            getObjectById: (id) => {
                if (id === 'spawn1') return spawn;
                return null;
            }
        };

        // Reset resourceManager
        resourceManager.resources = {};
        resourceManager.lastId = 0;
        resourceManager.registerResourceType('constructionOrder', ConstructionOrder);

        // Get controller singleton
        controller = require('../BuildController');
    });

    describe('reconcile', () => {
        test('should process construction orders in priority order', () => {
            logger.info('should process construction orders in priority order');
            // Create construction orders through resourceManager
            const order1Id = resourceManager.applyResource('constructionOrder', {
                roomName: 'test',
                structureType: 'extension',
                positions: [{ x: 1, y: 1 }],
                priority: 1
            });

            const order2Id = resourceManager.applyResource('constructionOrder', {
                roomName: 'test',
                structureType: 'extension',
                positions: [{ x: 2, y: 2 }],
                priority: 2
            });

            controller.handleConstructionSites();

            // Verify construction sites were created in priority order
            const sites = testRoom._constructionSites;
            expect(sites.length).toBe(2);
            expect(sites[0].pos).toEqual({ x: 2, y: 2 }); // Higher priority first
            expect(sites[1].pos).toEqual({ x: 1, y: 1 });
        });

        test('should respect MAX_CONSTRUCTION_SITES limit', () => {
            logger.info('should respect MAX_CONSTRUCTION_SITES limit');
            // Add existing construction sites
            for (let i = 0; i < 4; i++) {
                testRoom._addConstructionSite(new MockConstructionSite(`site${i}`, { x: 10 + i, y: 10 }));
            }

            // Create construction orders through resourceManager
            resourceManager.applyResource('constructionOrder', {
                roomName: 'test',
                structureType: 'extension',
                positions: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
                priority: 1
            });

            global.MAX_CONSTRUCTION_SITES = 5;
            controller.handleConstructionSites();

            // Should only create one more construction site
            expect(testRoom.find(FIND_MY_CONSTRUCTION_SITES).length).toBe(5);
        });

        test('should stop processing orders when MAX_CONSTRUCTION_SITES is reached', () => {
            logger.info('should stop processing orders when MAX_CONSTRUCTION_SITES is reached');
            // Add existing construction sites up to limit
            for (let i = 0; i < 5; i++) {
                testRoom._addConstructionSite(new MockConstructionSite(`site${i}`, { x: 10 + i, y: 10 }));
            }

            // Create construction order through resourceManager
            resourceManager.applyResource('constructionOrder', {
                roomName: 'test',
                structureType: 'extension',
                positions: [{ x: 1, y: 1 }],
                priority: 1
            });

            global.MAX_CONSTRUCTION_SITES = 5;
            controller.handleConstructionSites();

            // Should not create any more construction sites
            expect(testRoom.find(FIND_MY_CONSTRUCTION_SITES).length).toBe(5);
        });
    });

    describe('applyResources', () => {
        test('should create builder and mule creep orders', () => {
            logger.info('should create builder and mule creep orders');
            // Create a construction site to trigger builder creation
            testRoom._addConstructionSite(new MockConstructionSite('site1', { x: 1, y: 1 }));

            // Mock source for mule
            global.Game.getObjectById = jest.fn().mockImplementation((id) => {
                if (id === 'spawn1') return spawn;
                if (id === 'source1') return { id: 'source1', pos: { x: 10, y: 10 } };
                return null;
            });

            controller.applyResources();

            // Should create builder order
            const builders = resourceManager.getResourcesOfType('creepOrder')
                .filter(order => order.role === 'builder');
            expect(builders.length).toBe(1);
            expect(builders[0].priority).toBe(40);
            expect(builders[0].roomName).toBe('test');

            // Should create mule order
            const mules = resourceManager.getResourcesOfType('creepOrder')
                .filter(order => order.role === 'mule');
            expect(mules.length).toBe(1);
            expect(mules[0].priority).toBe(49);
            expect(mules[0].roomName).toBe('test');
        });

        test('should not create orders for rooms without spawns', () => {
            logger.info('should not create orders for rooms without spawns');
            // Create room without spawn
            const emptyRoom = new MockRoom('empty');
            global.Game.rooms.empty = emptyRoom;

            // Create construction order in empty room
            resourceManager.applyResource('constructionOrder', {
                roomName: 'empty',
                structureType: 'extension',
                positions: [{ x: 1, y: 1 }],
                priority: 1
            });

            controller.applyResources();

            // Should not create any orders for the empty room
            const emptyRoomOrders = resourceManager.getResourcesOfType('creepOrder')
                .filter(order => order.roomName === 'empty');
            expect(emptyRoomOrders.length).toBe(0);
        });
    });
});
