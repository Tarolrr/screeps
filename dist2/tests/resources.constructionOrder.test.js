const { MockRoom, MockStructure, resetGameState } = require('./mocks/screeps');
const Resource = require('../resources.Resource');
const ConstructionOrder = require('../resources.constructionOrder');

describe('ConstructionOrder', () => {
    beforeEach(() => {
        resetGameState();
        // Set up a test room
        Game.rooms.test = new MockRoom('test');
    });

    describe('Structure Ownership', () => {
        let order;
        const testPositions = [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 3 }
        ];

        beforeEach(() => {
            order = new ConstructionOrder({
                id: 'test_order',
                structureType: 'extension',
                pattern: { type: 'test' },
                roomName: 'test',
                count: 2,
                positions: testPositions
            });
        });

        test('should claim existing structures in its positions', () => {
            // Create two structures in our positions
            const structure1 = new MockStructure('struct1', { x: 1, y: 1 }, 'extension');
            const structure2 = new MockStructure('struct2', { x: 2, y: 2 }, 'extension');
            Game.rooms.test._addStructure(structure1);
            Game.rooms.test._addStructure(structure2);

            order.claimStructures(testPositions);

            expect(order.ownedStructureIds).toContain('struct1');
            expect(order.ownedStructureIds).toContain('struct2');
            expect(order.ownedStructureIds.length).toBe(2);
        });

        test('should not claim more structures than count', () => {
            // Create three structures but count is 2
            const structure1 = new MockStructure('struct1', { x: 1, y: 1 }, 'extension');
            const structure2 = new MockStructure('struct2', { x: 2, y: 2 }, 'extension');
            const structure3 = new MockStructure('struct3', { x: 3, y: 3 }, 'extension');
            Game.rooms.test._addStructure(structure1);
            Game.rooms.test._addStructure(structure2);
            Game.rooms.test._addStructure(structure3);

            // First claim all structures
            order.claimStructures(testPositions);
            // Set flag and remove excess
            order.hasWrongPositionStructures = true;
            order.removeExcessStructures();

            // Should have destroyed one structure (the last one)
            expect(structure3._destroyed).toBe(true);
            expect(structure1._destroyed).toBe(false);
            expect(structure2._destroyed).toBe(false);
        });

        test('should remove structures when positions change', () => {
            // Set up initial structures
            const structure1 = new MockStructure('struct1', { x: 1, y: 1 }, 'extension');
            const structure2 = new MockStructure('struct2', { x: 2, y: 2 }, 'extension');
            Game.rooms.test._addStructure(structure1);
            Game.rooms.test._addStructure(structure2);
            
            // First claim with original positions
            order.claimStructures(testPositions);

            // Change positions and trigger update
            const newPositions = [
                { x: 1, y: 1 },  // Keep this one
                { x: 4, y: 4 }   // New position
            ];
            order.positions = newPositions;
            
            // Set flag and remove excess
            order.hasWrongPositionStructures = true;
            order.removeExcessStructures();

            // struct1 should remain, struct2 should be destroyed
            expect(structure1._destroyed).toBe(false);
            expect(structure2._destroyed).toBe(true);
        });

        test('should remove all structures when type changes', () => {
            // Set up initial structures
            const structure1 = new MockStructure('struct1', { x: 1, y: 1 }, 'extension');
            const structure2 = new MockStructure('struct2', { x: 2, y: 2 }, 'extension');
            Game.rooms.test._addStructure(structure1);
            Game.rooms.test._addStructure(structure2);
            
            // First claim with original positions
            order.claimStructures(testPositions);

            // Change structure type and set flag
            order.structureType = 'spawn';
            order.hasWrongTypeStructures = true;
            order.removeExcessStructures();

            // Both structures should be destroyed
            expect(structure1._destroyed).toBe(true);
            expect(structure2._destroyed).toBe(true);
        });

        test('should generate construction sites only for unowned positions', () => {
            // Create one existing structure
            const structure1 = new MockStructure('struct1', { x: 1, y: 1 }, 'extension');
            Game.rooms.test._addStructure(structure1);
            order.claimStructures(testPositions);

            const sites = order.generateConstructionSitePositions(2);

            // Should only get one position for construction (x:2,y:2) since (x:1,y:1) is occupied
            expect(sites.length).toBe(1);
            expect(sites[0].x).toBe(2);
            expect(sites[0].y).toBe(2);
        });

        test('should validate and clean up invalid owned structures', () => {
            // Set up initial structures
            const structure1 = new MockStructure('struct1', { x: 1, y: 1 }, 'extension');
            const structure2 = new MockStructure('struct2', { x: 2, y: 2 }, 'extension');
            Game.rooms.test._addStructure(structure1);
            Game.rooms.test._addStructure(structure2);
            order.claimStructures(testPositions);

            // Remove one structure from game but keep its ID in ownedStructureIds
            Game.rooms.test._removeStructure('struct1');

            order.validateOwnedStructures();

            expect(order.ownedStructureIds).not.toContain('struct1');
            expect(order.ownedStructureIds).toContain('struct2');
        });

        test('should handle failed structure deletion', () => {
            // Set up initial structures
            const structure1 = new MockStructure('struct1', { x: 1, y: 1 }, 'extension');
            const structure2 = new MockStructure('struct2', { x: 2, y: 2 }, 'extension');
            Game.rooms.test._addStructure(structure1);
            Game.rooms.test._addStructure(structure2);
            
            // First claim with original positions
            order.claimStructures(testPositions);

            // Make structure2 fail to delete (simulating hostile creep)
            structure2._failDestroy = true;

            // Change positions and trigger update
            const newPositions = [
                { x: 1, y: 1 },  // Keep this one
                { x: 4, y: 4 }   // New position
            ];
            order.positions = newPositions;
            
            // Set flag and remove excess
            order.hasWrongPositionStructures = true;
            order.removeExcessStructures();

            // struct2 should not be destroyed due to failure
            expect(structure1._destroyed).toBe(false);
            expect(structure2._destroyed).toBe(false);
            expect(order.hasWrongPositionStructures).toBe(true); // Flag should remain true
        });
    });
});
