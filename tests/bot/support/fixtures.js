// Valid sample DTOs of contract A.2. Each call returns a fresh object, so tests
// may mutate it to build negative cases. Shared by A0-A5 tests.

const { measured, unknownMeasure, snapshotFingerprint } = require('../../../src/bot/domain/dtos');
const { buildOperationKey, eventKey, spawnPoolNodeId } = require('../../../src/bot/domain/keys');
const { FLOW_FIELDS } = require('../../../src/bot/domain/dtos');
const layout = require('../../../src/bot/domain/stateLayout');
const { fingerprint } = require('../../../src/bot/domain/fingerprint');
const { CONTRACT_VERSION } = require('../../../src/bot/domain/version');

const ROOM = 'W5N8';
const TICK = 1000;

function pos(x, y) { return { roomName: ROOM, x: x, y: y }; }

function sampleOperationKey() {
    return buildOperationKey({ domain: ROOM, ownerEpoch: 7, demandStableKey: ROOM + '/feeding/spawn1', generation: 2, action: 'spawn', occurrence: '0' });
}

function sampleCreep(name) {
    return {
        name: name || 'h1',
        id: 'c1',
        roomName: ROOM,
        pos: pos(10, 10),
        spawning: false,
        body: [{ type: 'work', boost: null, hits: 100 }, { type: 'carry', boost: null, hits: 100 }, { type: 'move', boost: null, hits: 100 }],
        ticksToLive: measured(1200),
        store: { energy: measured(50), capacity: measured(50) },
        legacyRole: 'harvester',
        strategyEnvelope: null,
    };
}

function sampleRoomSnapshot() {
    const rawEntries = [{ originalArrayIndex: 0, event: 4, objectId: 'c1', data: { targetId: 's1', amount: 50, resourceType: 'energy' } }];
    return {
        roomName: ROOM,
        tick: TICK,
        visibility: 'VISIBLE',
        controller: {
            id: 'ctrl1', my: true, ownerName: 'Tarolrr', reservationOwner: null, level: 2,
            progress: measured(100), progressTotal: measured(45000), ticksToDowngrade: measured(10000), safeModeTicks: unknownMeasure('MISSING_FIELD'),
        },
        energyAvailable: measured(300),
        energyCapacityAvailable: measured(300),
        energyNodes: [
            { nodeId: 'creep:h1', nodeClass: 'CARGO', objectType: 'creep', roomName: ROOM, pos: pos(10, 10), amount: measured(50), capacity: measured(50) },
            { nodeId: 'spawn1id', nodeClass: 'SPAWN_EXTENSION', objectType: 'spawn', roomName: ROOM, pos: pos(20, 20), amount: measured(300), capacity: measured(300) },
        ],
        spawns: [{ id: 'spawn1id', name: 'Spawn1', roomName: ROOM, pos: pos(20, 20), spawning: null }],
        sources: [{ id: 'src1', pos: pos(5, 5), energy: measured(3000), energyCapacity: measured(3000), ticksToRegeneration: unknownMeasure('MISSING_FIELD') }],
        hostiles: [],
        constructionSites: [],
        eventLog: { effectTick: TICK - 1, observedAt: TICK, status: 'CAPTURED', rawLength: 1, rawFingerprint: fingerprint(rawEntries), entries: rawEntries },
        missingFields: ['controller.safeModeTicks', 'sources.src1.ticksToRegeneration'],
    };
}

function sampleSnapshot() {
    const snap = {
        dtoType: 'Snapshot',
        contractVersion: CONTRACT_VERSION,
        tick: TICK,
        shard: 'shard0',
        captureStage: 'FULL',
        cpu: { used: measured(1.5), limit: measured(20), tickLimit: measured(500), bucket: measured(10000) },
        rooms: { W5N8: sampleRoomSnapshot() },
        ownCreeps: { h1: sampleCreep('h1') },
        missingFields: [],
        fingerprint: 'fnv1a64:0000000000000000',
    };
    snap.fingerprint = snapshotFingerprint(snap);
    return snap;
}

function sampleNormalizedEvent() {
    return {
        eventKey: eventKey(ROOM, TICK - 1, 0),
        roomName: ROOM,
        effectTick: TICK - 1,
        observedAt: TICK,
        originalArrayIndex: 0,
        type: 'TRANSFER',
        rawEvent: 4,
        actorId: 'c1',
        sourceId: 'c1',
        targetId: 's1',
        resourceType: 'energy',
        amount: measured(50),
        energyAmount: measured(50),
        rawFingerprint: fingerprint([]),
    };
}

function sampleCallReceipt() {
    return { kind: 'RETURNED', commandId: 'cmd-1000-1', operationKey: sampleOperationKey(), action: 'spawn', actorRef: 'Spawn1', targetRef: null, tick: TICK, code: 0, errorCode: null };
}

function sampleEffectResult() {
    return { kind: 'CONFIRMED', operationKey: sampleOperationKey(), commandId: 'cmd-1000-1', evaluatedAt: TICK + 1, confirmedAmount: 150, effect: { spawningName: 's_abc' }, evidence: null, reason: null, eventKeys: [] };
}

function sampleOperation() {
    return {
        operationKey: sampleOperationKey(),
        state: 'ISSUED',
        createdAt: TICK,
        updatedAt: TICK,
        issuedAt: TICK,
        lastCommandId: 'cmd-1000-1',
        actorRef: 'Spawn1',
        targetRef: null,
        requestedAmount: 150,
        confirmedAmount: 0,
        reservationIds: ['r1'],
        lastReceipt: sampleCallReceipt(),
        lastEffect: null,
        reasonCode: null,
    };
}

function sampleReservation() {
    return {
        reservationId: 'r1', kind: 'SPEND', state: 'RESERVED', missionId: null, operationKey: sampleOperationKey(),
        roomName: ROOM, nodeId: spawnPoolNodeId(ROOM), targetNodeId: null, resourceType: 'energy',
        amount: 150, settledAmount: 0, releasedAmount: 0, unknownAmount: 0, dueAt: TICK + 10, createdAt: TICK, updatedAt: TICK,
    };
}

function sampleDemand() {
    return {
        stableKey: ROOM + '/feeding/spawn1', generation: 2, missionId: null, roomName: ROOM, capability: 'feed-spawn',
        measurementUnit: 'energy/tick', amount: 5, location: pos(20, 20), requiredBy: TICK + 50, earliestStart: null,
        criticality: 'CRITICAL', options: [sampleDemandOption()], createdAt: TICK,
    };
}

function sampleDemandOption() {
    return { body: ['carry', 'carry', 'move'], cost: 150, spawnTime: 9, provides: 5, travelTime: measured(20, 'ESTIMATED') };
}

function sampleProposal() {
    return {
        proposalId: 'p-1000-1', mode: 'shadow', roomName: ROOM, missionId: null, tick: TICK, inputFingerprint: fingerprint({ a: 1 }),
        expectedRevision: 3, reasonCode: 'SHADOW_ONLY', demands: [sampleDemand()], missionPatches: [],
        reservationRequests: [{ kind: 'SPEND', nodeId: 'spawn1id', targetNodeId: null, resourceType: 'energy', amount: 150, dueAt: TICK + 10 }],
        dependencies: [],
    };
}

function sampleDecisionRecord() {
    return {
        decisionId: 'd-1000-1', tick: TICK, roomName: ROOM, mode: 'shadow', reasonCode: 'SHADOW_ONLY', inputFingerprint: fingerprint({ a: 1 }),
        inputs: { energyAvailable: 300 }, alternatives: [{ label: 'feeder-150', proposalId: 'p-1000-1', reasonCode: 'SHADOW_ONLY', accepted: true }],
        selectedProposalId: 'p-1000-1', expectedNextFact: { spawningAt: TICK + 1 }, resultKind: 'READY', executed: false,
    };
}

function sampleControlRecord(overrides) {
    return Object.assign({ requestedMode: 'shadow', effectiveOwner: 'legacy', epoch: 3, transitionPhase: null, transitionId: null, previousOwner: null, blockedReason: null }, overrides || {});
}

function sampleStrategyRoot(rooms) {
    const root = layout.emptyStrategyRoot({ buildId: 'b-0000000000000000' });
    root.revision = 3;
    root.lastClosedTick = TICK - 1;
    root.control.rooms = rooms || { W5N8: sampleControlRecord() };
    return root;
}

function sampleShadowRoot() {
    const root = layout.emptyShadowRoot();
    root.rooms[ROOM] = { eventCursor: sampleEventCursor(), flowWindows: [sampleFlowWindow()], observedBindings: { h1: sampleObservedBinding() }, forecast: sampleForecastSummary(), decisionRing: [sampleDecisionRecord()] };
    root.ledger.reservations.r1 = sampleReservation();
    root.observedOperations[sampleObservedOperation().observationKey] = sampleObservedOperation();
    root.proposals['p-1000-1'] = sampleProposal();
    return root;
}

function sampleStateView(rooms) {
    return {
        dtoType: 'StateView', status: 'OPEN', sessionTick: TICK, blockedReason: null, quarantine: [],
        strategy: sampleStrategyRoot(rooms), shadow: sampleShadowRoot(),
    };
}

function sampleFlows(value) {
    const flows = {};
    for (const f of FLOW_FIELDS) flows[f] = measured(value);
    flows.unexplained = unknownMeasure('EVENT_GAP');
    return flows;
}

function sampleEventCursor() {
    return { roomName: ROOM, processedThroughTick: TICK - 1, lastObservedAt: TICK, lastRawFingerprint: fingerprint([]) };
}

function sampleFlowDelta() {
    return { roomName: ROOM, fromTick: TICK - 1, toTick: TICK, flows: sampleFlows(1), quality: 'OBSERVED', reasonCodes: ['EVENT_GAP'] };
}

function sampleFlowWindow() {
    return { roomName: ROOM, windowStart: TICK - 100, windowEnd: TICK, ticksCovered: 100, complete: true, topologyVersion: null, flows: sampleFlows(100), quality: 'OBSERVED', reasonCodes: [] };
}

function sampleBinding() {
    return { homeRoom: ROOM, ownerEpoch: 7, originEpoch: 7, legacyOrderId: null, operationKey: sampleOperationKey(), demandKey: ROOM + '/feeding/spawn1', generation: 2, assignmentId: null, observedLifeState: 'ALIVE' };
}

function sampleObservedBinding() {
    return { homeRoom: ROOM, homeSource: 'CREEP_MEMORY', homeQuality: 'OBSERVED', legacyRole: 'harvester', legacyOrderId: null, body: ['work', 'carry', 'move'], bodyCost: 200, firstSeen: TICK - 50, lastSeen: TICK, lifeState: 'ALIVE' };
}

function sampleObservedOperation() {
    return { observationKey: 'obs:TRANSFER:' + eventKey(ROOM, TICK - 1, 0), kind: 'TRANSFER', roomName: ROOM, actorRef: 'c1', targetRef: 's1', firstSeen: TICK, lastSeen: TICK, effect: 'CONFIRMED', amount: measured(50), energyAmount: measured(50), eventKeys: [eventKey(ROOM, TICK - 1, 0)] };
}

function sampleCalendar() {
    return {
        roomName: ROOM, fromTick: TICK, horizon: 300, quality: 'ESTIMATED', reasonCodes: ['NO_HISTORY'],
        entries: [
            { tick: TICK + 10, roomName: ROOM, kind: 'INCOME', amount: measured(80, 'ESTIMATED'), stableKey: ROOM + '/harvest/src1', reasonCode: 'NO_HISTORY' },
            { tick: TICK + 10, roomName: ROOM, kind: 'PAYMENT', amount: measured(150), stableKey: ROOM + '/feeding/spawn1', reasonCode: null },
        ],
    };
}

function sampleLedgerView() {
    return { roomName: ROOM, tick: TICK, nodes: [
        { nodeId: spawnPoolNodeId(ROOM), observed: measured(300), reserved: 150, disputed: 0, free: measured(150, 'DERIVED') },
        { nodeId: 'storage1', observed: unknownMeasure('NO_VISIBILITY'), reserved: 0, disputed: 0, free: unknownMeasure('NO_VISIBILITY') },
    ] };
}

function sampleReplacementPlan() {
    return { roomName: ROOM, tick: TICK, horizon: 1500, entries: [
        { stableKey: ROOM + '/feeding/spawn1', roomName: ROOM, currentCreepName: 'h1', ticksToLive: measured(1200), body: ['carry', 'carry', 'move'], bodyCost: 150, spawnTime: 9, travelTime: measured(20, 'ESTIMATED'), startBy: TICK + 1171, deadline: TICK + 1200, criticality: 'CRITICAL', reasonCode: null, quality: 'ESTIMATED' },
    ] };
}

function sampleForecastSummary() {
    return { roomName: ROOM, computedAt: TICK, horizon: 300, freeEnergyNow: measured(150, 'DERIVED'), incomeLowerPerTick: measured(8, 'ESTIMATED'), committedPayments: measured(150), nextDeficitTick: null, calendarFingerprint: fingerprint(sampleCalendar()), quality: 'ESTIMATED', reasonCodes: ['NO_HISTORY'] };
}

/** One valid StatePatch per stage-A writer. */
function sampleStatePatches() {
    return {
        state: { patchId: 'pt-1', writer: 'state', namespace: 'strategy', path: ['control', 'rooms', ROOM], op: 'set', value: sampleControlRecord() },
        observation: { patchId: 'pt-2', writer: 'observation', namespace: 'strategyShadow', path: ['rooms', ROOM, 'eventCursor'], op: 'set', value: sampleEventCursor() },
        finance: { patchId: 'pt-3', writer: 'finance', namespace: 'strategyShadow', path: ['rooms', ROOM, 'forecast'], op: 'set', value: sampleForecastSummary() },
        planning: { patchId: 'pt-4', writer: 'planning', namespace: 'strategyShadow', path: ['rooms', ROOM, 'decisionRing'], op: 'set', value: [sampleDecisionRecord()] },
    };
}

function sampleReconciliationPatch() {
    return {
        tick: TICK,
        patches: [sampleStatePatches().observation, { patchId: 'pt-5', writer: 'observation', namespace: 'strategyShadow', path: ['observedOperations', sampleObservedOperation().observationKey], op: 'set', value: sampleObservedOperation() }],
        gaps: [{ roomName: ROOM, fromTick: TICK - 5, toTick: TICK - 3, reasonCode: 'EVENT_GAP' }],
        domainStatus: { W5N8: 'OK' },
        reasonCodes: ['EVENT_GAP'],
    };
}

function sampleReplayFixture() {
    const body = {
        snapshots: [sampleSnapshot()],
        state: { revision: 3, control: { rooms: { W5N8: sampleControlRecord() } }, shadowRooms: { W5N8: { eventCursor: sampleEventCursor(), flowWindows: [sampleFlowWindow()] } } },
        events: [sampleNormalizedEvent()],
        expectedReasonCodes: ['NO_HISTORY', 'SHADOW_ONLY'],
        expectedForecast: { W5N8: sampleForecastSummary() },
    };
    const header = sampleReplayFixtureHeader();
    header.tickFrom = TICK;
    header.tickTo = TICK;
    header.contentFingerprint = fingerprint(body);
    return { header: header, body: body };
}

function sampleReplayFixtureHeader() {
    return {
        fixtureType: 'ReplayFixture', fixtureVersion: 1, contractVersion: CONTRACT_VERSION, buildId: 'b-0000000000000000', schemaVersion: 1,
        policyVersion: null, seed: null, tickFrom: TICK, tickTo: TICK + 10, rooms: [ROOM], contentFingerprint: fingerprint({}), expectedReasonCodes: ['NO_HISTORY', 'SHADOW_ONLY'],
    };
}

module.exports = {
    ROOM,
    TICK,
    sampleOperationKey,
    sampleCreep,
    sampleRoomSnapshot,
    sampleSnapshot,
    sampleNormalizedEvent,
    sampleCallReceipt,
    sampleEffectResult,
    sampleOperation,
    sampleReservation,
    sampleDemand,
    sampleProposal,
    sampleDecisionRecord,
    sampleControlRecord,
    sampleStateView,
    sampleReplayFixtureHeader,
    sampleDemandOption,
    sampleStrategyRoot,
    sampleShadowRoot,
    sampleEventCursor,
    sampleFlowDelta,
    sampleFlowWindow,
    sampleBinding,
    sampleObservedBinding,
    sampleObservedOperation,
    sampleCalendar,
    sampleLedgerView,
    sampleReplacementPlan,
    sampleForecastSummary,
    sampleStatePatches,
    sampleReconciliationPatch,
    sampleReplayFixture,
};
