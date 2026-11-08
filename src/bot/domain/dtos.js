// DTO types and validators of contract A.2 (docs/strategy/CONTRACTS-A.md §4).
// Persisted state layout (Memory.strategy / Memory.strategyShadow), StatePatch
// ownership and StateView live in ./stateLayout.js.
//
// All DTOs are plain JSON data. Unknown measurable values use Measured:
//   { value: number|null, quality: Quality, reason: ReasonCode|null }
//   value === null  <=> quality === 'UNKNOWN' (and reason !== null)
// so a JSON round-trip never turns "unknown" into a valid zero.
// Collections inside DTOs are arrays sorted by their stable id, or records
// keyed by the stable id (canonical JSON sorts record keys).

const { S, validate } = require('./schema');
const E = require('./enums');
const { REASON_CODE_LIST, isReasonCode } = require('./reasonCodes');
const { isFingerprint, fingerprint } = require('./fingerprint');
const { isRoomName, isPosition, isOperationKey, eventKey } = require('./keys');
const { ResultKind } = require('./results');
const { CONTRACT_VERSION } = require('./version');

// ---------------------------------------------------------------- primitives

const tick = S.int({ min: 0 });
const nonNegNumber = S.number({ min: 0 });
const id = S.nonEmpty();
const roomName = S.custom(isRoomName, 'BAD_ROOM_NAME');
const position = S.custom(isPosition, 'BAD_POSITION');
const fp = S.custom(isFingerprint, 'BAD_FINGERPRINT');
const reasonCode = S.enumOf(arrayToEnum(REASON_CODE_LIST));
const operationKey = S.custom(isOperationKey, 'BAD_OPERATION_KEY');
const fieldList = S.refine(S.array(S.nonEmpty()), sortedUniqueStrings);

function arrayToEnum(list) {
    const result = {};
    for (let i = 0; i < list.length; i++) result[list[i]] = list[i];
    return result;
}

function sortedUniqueStrings(list) {
    for (let i = 1; i < list.length; i++) {
        if (!(list[i - 1] < list[i])) return [{ path: String(i), code: 'NOT_SORTED_UNIQUE' }];
    }
    return [];
}

function sortedBy(field) {
    return function (list) {
        for (let i = 1; i < list.length; i++) {
            if (!(list[i - 1][field] < list[i][field])) return [{ path: String(i), code: 'NOT_SORTED_UNIQUE' }];
        }
        return [];
    };
}

/** @typedef {{value:(number|null), quality:string, reason:(string|null)}} Measured */
const Measured = S.refine(S.object({
    value: S.nullable(S.number()),
    quality: S.enumOf(E.Quality),
    reason: S.nullable(reasonCode),
}), function (m) {
    if (m.value === null && m.quality !== E.Quality.UNKNOWN) return [{ path: 'quality', code: 'NULL_VALUE_NOT_UNKNOWN' }];
    if (m.value !== null && m.quality === E.Quality.UNKNOWN) return [{ path: 'value', code: 'UNKNOWN_WITH_VALUE' }];
    if (m.quality === E.Quality.UNKNOWN && m.reason === null) return [{ path: 'reason', code: 'UNKNOWN_WITHOUT_REASON' }];
    return [];
});

/**
 * @param {number} value finite number
 * @param {string} [quality] default OBSERVED
 * @returns {Measured}
 */
function measured(value, quality) {
    if (typeof value !== 'number' || !isFinite(value)) throw new TypeError('measured value must be a finite number');
    const q = quality === undefined ? E.Quality.OBSERVED : quality;
    if (q === E.Quality.UNKNOWN || !E.isEnumValue(E.Quality, q)) throw new TypeError('measured quality invalid: ' + String(q));
    return { value: value, quality: q, reason: null };
}

/**
 * @param {string} reason ReasonCode explaining why the value is unknown
 * @returns {Measured}
 */
function unknownMeasure(reason) {
    if (!isReasonCode(reason)) throw new TypeError('unknownMeasure needs a reason code');
    return { value: null, quality: E.Quality.UNKNOWN, reason: reason };
}

// ---------------------------------------------------------------- snapshot

const BodyPart = S.object({
    type: S.nonEmpty(),
    boost: S.nullable(S.nonEmpty()),
    hits: S.int({ min: 0, max: 100 }),
});

const StrategyEnvelope = S.object({
    operationKey: operationKey,
    homeRoom: roomName,
    ownerEpoch: S.int({ min: 0 }),
});

const CreepSnapshot = S.object({
    name: id,
    id: S.nullable(id),
    roomName: S.nullable(roomName),
    pos: S.nullable(position),
    spawning: S.bool(),
    body: S.array(BodyPart),
    ticksToLive: Measured,
    store: S.object({ energy: Measured, capacity: Measured }),
    legacyRole: S.nullable(S.nonEmpty()),
    strategyEnvelope: S.nullable(StrategyEnvelope),
});

const SpawnSnapshot = S.object({
    id: id,
    name: id,
    roomName: roomName,
    pos: position,
    spawning: S.nullable(S.object({ name: id, needTime: S.int({ min: 0 }), remainingTime: S.int({ min: 0 }) })),
});

const SourceSnapshot = S.object({
    id: id,
    pos: position,
    energy: Measured,
    energyCapacity: Measured,
    ticksToRegeneration: Measured,
});

const ControllerSnapshot = S.object({
    id: id,
    my: S.bool(),
    ownerName: S.nullable(S.nonEmpty()),
    reservationOwner: S.nullable(S.nonEmpty()),
    level: S.int({ min: 0, max: 8 }),
    progress: Measured,
    progressTotal: Measured,
    ticksToDowngrade: Measured,
    safeModeTicks: Measured,
});

const HostileSnapshot = S.object({
    id: id,
    ownerName: S.nullable(S.nonEmpty()),
    pos: position,
    body: S.array(BodyPart),
    hits: S.int({ min: 0 }),
    hitsMax: S.int({ min: 0 }),
});

const ConstructionSiteSnapshot = S.object({
    id: id,
    structureType: S.nonEmpty(),
    pos: position,
    my: S.bool(),
    progress: S.int({ min: 0 }),
    progressTotal: S.int({ min: 0 }),
});

/** nodeId conventions: structure/pile object id; 'creep:<name>' for CARGO; 'remote:<room>:<sourceId>' for REMOTE. */
const EnergyNode = S.refine(S.object({
    nodeId: id,
    nodeClass: S.enumOf(E.EnergyNodeClass),
    objectType: S.enumOf(E.EnergyObjectType),
    roomName: roomName,
    pos: S.nullable(position),
    amount: Measured,
    capacity: Measured,
}), function (node) {
    if (E.ENERGY_NODE_OBJECT_TYPES[node.nodeClass].indexOf(node.objectType) === -1) return [{ path: 'objectType', code: 'OBJECT_TYPE_NOT_IN_CLASS' }];
    return [];
});

const RawEventEntry = S.object({
    originalArrayIndex: S.int({ min: 0 }),
    event: S.int({ min: 0 }),
    objectId: S.nullable(S.nonEmpty()),
    data: S.nullable(S.json()),
});

const EventLogCapture = S.refine(S.object({
    effectTick: tick,
    observedAt: tick,
    status: S.enumOf(E.EventLogStatus),
    rawLength: S.nullable(S.int({ min: 0 })),
    rawFingerprint: S.nullable(fp),
    entries: S.nullable(S.refine(S.array(RawEventEntry), sortedBy('originalArrayIndex'))),
}), function (log) {
    const problems = [];
    if (log.effectTick !== log.observedAt - 1) problems.push({ path: 'effectTick', code: 'EFFECT_TICK_NOT_OBSERVED_MINUS_1' });
    if (log.status === E.EventLogStatus.CAPTURED) {
        if (log.entries === null || log.rawLength === null || log.rawFingerprint === null) problems.push({ path: 'entries', code: 'CAPTURED_WITHOUT_DATA' });
    } else if (log.entries !== null || log.rawLength !== null || log.rawFingerprint !== null) {
        problems.push({ path: 'entries', code: 'DATA_WITHOUT_CAPTURE' });
    }
    return problems;
});

const RoomSnapshot = S.refine(S.object({
    roomName: roomName,
    tick: tick,
    visibility: S.enumOf(E.Visibility),
    controller: S.nullable(ControllerSnapshot),
    energyAvailable: Measured,
    energyCapacityAvailable: Measured,
    energyNodes: S.refine(S.array(EnergyNode), sortedBy('nodeId')),
    spawns: S.refine(S.array(SpawnSnapshot), sortedBy('id')),
    sources: S.refine(S.array(SourceSnapshot), sortedBy('id')),
    hostiles: S.refine(S.array(HostileSnapshot), sortedBy('id')),
    constructionSites: S.refine(S.array(ConstructionSiteSnapshot), sortedBy('id')),
    eventLog: EventLogCapture,
    missingFields: fieldList,
}), function (room) {
    const problems = [];
    if (room.eventLog.observedAt !== room.tick) problems.push({ path: 'eventLog/observedAt', code: 'NOT_SNAPSHOT_TICK' });
    if (room.visibility === E.Visibility.NOT_VISIBLE) {
        if (room.energyNodes.length + room.spawns.length + room.sources.length + room.hostiles.length + room.constructionSites.length > 0 || room.controller !== null) {
            problems.push({ path: 'visibility', code: 'OBJECTS_WITHOUT_VISIBILITY' });
        }
        if (room.eventLog.status === E.EventLogStatus.CAPTURED) problems.push({ path: 'eventLog/status', code: 'EVENTS_WITHOUT_VISIBILITY' });
    }
    return problems;
});

const SnapshotCpu = S.object({ used: Measured, limit: Measured, tickLimit: Measured, bucket: Measured });

const SNAPSHOT_FIELDS = {
    dtoType: S.literal('Snapshot'),
    contractVersion: S.literal(CONTRACT_VERSION),
    tick: tick,
    shard: S.nullable(S.nonEmpty()),
    captureStage: S.enumOf({ CRITICAL: 'CRITICAL', FULL: 'FULL' }),
    cpu: SnapshotCpu,
    rooms: S.record(roomName, RoomSnapshot),
    ownCreeps: S.record(id, CreepSnapshot),
    missingFields: fieldList,
    fingerprint: fp,
};

const Snapshot = S.refine(S.object(SNAPSHOT_FIELDS), function (snap) {
    const problems = [];
    const nodeIds = {};
    for (const name in snap.rooms) {
        const room = snap.rooms[name];
        if (room.roomName !== name) problems.push({ path: 'rooms/' + name + '/roomName', code: 'KEY_MISMATCH' });
        if (room.tick !== snap.tick) problems.push({ path: 'rooms/' + name + '/tick', code: 'NOT_SNAPSHOT_TICK' });
        for (let i = 0; i < room.energyNodes.length; i++) {
            const nodeId = room.energyNodes[i].nodeId;
            if (nodeIds[nodeId]) problems.push({ path: 'rooms/' + name + '/energyNodes/' + i, code: 'DUPLICATE_ENERGY_NODE' });
            nodeIds[nodeId] = true;
        }
    }
    for (const creepName in snap.ownCreeps) {
        if (snap.ownCreeps[creepName].name !== creepName) problems.push({ path: 'ownCreeps/' + creepName + '/name', code: 'KEY_MISMATCH' });
    }
    return problems;
});

/** Snapshot fields excluded from its fingerprint: the fingerprint itself and per-capture volatile CPU readings. */
const SNAPSHOT_FINGERPRINT_EXCLUDED = Object.freeze(['fingerprint', 'cpu']);

/**
 * Fingerprint of a Snapshot over all fields except SNAPSHOT_FINGERPRINT_EXCLUDED
 * (cpu.used/bucket change with every capture and must not make an otherwise
 * identical world look changed).
 * @param {object} snapshot
 * @returns {string}
 */
function snapshotFingerprint(snapshot) {
    const copy = {};
    for (const key in snapshot) {
        if (Object.prototype.hasOwnProperty.call(snapshot, key) && SNAPSHOT_FINGERPRINT_EXCLUDED.indexOf(key) === -1) copy[key] = snapshot[key];
    }
    return fingerprint(copy);
}

// ---------------------------------------------------------------- events

const NormalizedEvent = S.refine(S.object({
    eventKey: S.nonEmpty(),
    roomName: roomName,
    effectTick: tick,
    observedAt: tick,
    originalArrayIndex: S.int({ min: 0 }),
    type: S.enumOf(E.NormalizedEventType),
    rawEvent: S.int({ min: 0 }),
    actorId: S.nullable(S.nonEmpty()),
    sourceId: S.nullable(S.nonEmpty()),
    targetId: S.nullable(S.nonEmpty()),
    resourceType: S.nullable(S.nonEmpty()),
    amount: Measured,
    energyAmount: Measured,
    rawFingerprint: fp,
}), function (ev) {
    const problems = [];
    if ((ev.type === E.NormalizedEventType.TRANSFER || ev.type === E.NormalizedEventType.HARVEST) && ev.resourceType === 'energy' &&
        ev.amount.value !== null && ev.energyAmount.value !== ev.amount.value) {
        problems.push({ path: 'energyAmount', code: 'ENERGY_AMOUNT_MISMATCH' });
    }
    if (ev.effectTick !== ev.observedAt - 1) problems.push({ path: 'effectTick', code: 'EFFECT_TICK_NOT_OBSERVED_MINUS_1' });
    if (ev.eventKey !== eventKey(ev.roomName, ev.effectTick, ev.originalArrayIndex)) problems.push({ path: 'eventKey', code: 'KEY_MISMATCH' });
    return problems;
});

const EventGap = S.refine(S.object({
    roomName: roomName,
    fromTick: tick,
    toTick: tick,
    reasonCode: reasonCode,
}), function (gap) {
    return gap.fromTick <= gap.toTick ? [] : [{ path: 'toTick', code: 'RANGE_INVERTED' }];
});

// ---------------------------------------------------------------- receipts and effects

const CallReceipt = S.refine(S.object({
    kind: S.enumOf(E.CallReceiptKind),
    commandId: id,
    operationKey: operationKey,
    action: S.nonEmpty(),
    actorRef: id,
    targetRef: S.nullable(id),
    tick: tick,
    code: S.nullable(S.int()),
    errorCode: S.nullable(S.nonEmpty()),
}), function (r) {
    if (r.kind === E.CallReceiptKind.RETURNED && (r.code === null || r.errorCode !== null)) return [{ path: 'code', code: 'RETURNED_NEEDS_CODE_ONLY' }];
    if (r.kind === E.CallReceiptKind.THREW && (r.errorCode === null || r.code !== null)) return [{ path: 'errorCode', code: 'THREW_NEEDS_ERROR_ONLY' }];
    return [];
});

const EffectResult = S.refine(S.object({
    kind: S.enumOf(E.EffectKind),
    operationKey: operationKey,
    commandId: S.nullable(id),
    evaluatedAt: tick,
    confirmedAmount: S.nullable(nonNegNumber),
    effect: S.nullable(S.json()),
    evidence: S.nullable(S.json()),
    reason: S.nullable(reasonCode),
    eventKeys: S.refine(S.array(S.nonEmpty()), sortedUniqueStrings),
}), function (r) {
    if (r.kind === E.EffectKind.CONFIRMED && r.effect === null) return [{ path: 'effect', code: 'CONFIRMED_WITHOUT_EFFECT' }];
    if (r.kind === E.EffectKind.NO_EFFECT && r.evidence === null) return [{ path: 'evidence', code: 'NO_EFFECT_WITHOUT_EVIDENCE' }];
    if (r.kind === E.EffectKind.UNKNOWN && r.reason === null) return [{ path: 'reason', code: 'UNKNOWN_WITHOUT_REASON' }];
    return [];
});

// ---------------------------------------------------------------- operations and ledger

const Operation = S.refine(S.object({
    operationKey: operationKey,
    state: S.enumOf(E.OperationState),
    createdAt: tick,
    updatedAt: tick,
    issuedAt: S.nullable(tick),
    lastCommandId: S.nullable(id),
    actorRef: S.nullable(id),
    targetRef: S.nullable(id),
    requestedAmount: S.nullable(nonNegNumber),
    confirmedAmount: nonNegNumber,
    reservationIds: S.refine(S.array(id), sortedUniqueStrings),
    lastReceipt: S.nullable(CallReceipt),
    lastEffect: S.nullable(EffectResult),
    reasonCode: S.nullable(reasonCode),
}), function (op) {
    const problems = [];
    if (op.updatedAt < op.createdAt) problems.push({ path: 'updatedAt', code: 'BEFORE_CREATED' });
    if (op.requestedAmount !== null && op.confirmedAmount > op.requestedAmount) problems.push({ path: 'confirmedAmount', code: 'ABOVE_REQUESTED' });
    if (op.state === E.OperationState.ISSUED && op.issuedAt === null) problems.push({ path: 'issuedAt', code: 'ISSUED_WITHOUT_TICK' });
    if ((op.state === E.OperationState.UNKNOWN || op.state === E.OperationState.UNKNOWN_RETIRED) && op.reasonCode === null) problems.push({ path: 'reasonCode', code: 'UNKNOWN_WITHOUT_REASON' });
    if (op.state === E.OperationState.CONFIRMED && (op.lastEffect === null || op.lastEffect.kind !== E.EffectKind.CONFIRMED)) problems.push({ path: 'lastEffect', code: 'CONFIRMED_WITHOUT_EFFECT' });
    if (op.lastReceipt !== null && op.lastReceipt.operationKey !== op.operationKey) problems.push({ path: 'lastReceipt/operationKey', code: 'KEY_MISMATCH' });
    if (op.lastEffect !== null && op.lastEffect.operationKey !== op.operationKey) problems.push({ path: 'lastEffect/operationKey', code: 'KEY_MISMATCH' });
    return problems;
});

const Reservation = S.refine(S.object({
    reservationId: id,
    kind: S.enumOf(E.ReservationKind),
    state: S.enumOf(E.ReservationState),
    missionId: S.nullable(id),
    operationKey: S.nullable(operationKey),
    roomName: roomName,
    nodeId: id,
    targetNodeId: S.nullable(id),
    resourceType: S.nonEmpty(),
    amount: nonNegNumber,
    settledAmount: nonNegNumber,
    releasedAmount: nonNegNumber,
    unknownAmount: nonNegNumber,
    dueAt: S.nullable(tick),
    createdAt: tick,
    updatedAt: tick,
}), function (r) {
    const problems = [];
    const closed = r.settledAmount + r.releasedAmount + r.unknownAmount;
    if (closed > r.amount) problems.push({ path: 'settledAmount', code: 'ABOVE_AMOUNT' });
    if (r.kind === E.ReservationKind.MOVE && r.targetNodeId === null) problems.push({ path: 'targetNodeId', code: 'MOVE_WITHOUT_TARGET' });
    const terminal = r.state === E.ReservationState.SETTLED || r.state === E.ReservationState.RELEASED || r.state === E.ReservationState.RETIRED;
    if (terminal && closed !== r.amount) problems.push({ path: 'state', code: 'CLOSED_NOT_BALANCED' });
    if ((r.state === E.ReservationState.SETTLED || r.state === E.ReservationState.RELEASED) && r.unknownAmount !== 0) problems.push({ path: 'unknownAmount', code: 'CLOSED_WITH_DISPUTE' });
    if (r.state === E.ReservationState.RETIRED && !(r.unknownAmount > 0)) problems.push({ path: 'unknownAmount', code: 'RETIRED_WITHOUT_UNKNOWN' });
    if (r.state === E.ReservationState.RESERVED && r.unknownAmount !== 0) problems.push({ path: 'unknownAmount', code: 'DISPUTE_BEFORE_ISSUE' });
    if (r.state === E.ReservationState.PARTIAL && !(r.settledAmount > 0)) problems.push({ path: 'settledAmount', code: 'PARTIAL_WITHOUT_SETTLEMENT' });
    if (r.updatedAt < r.createdAt) problems.push({ path: 'updatedAt', code: 'BEFORE_CREATED' });
    return problems;
});

/** One admissible way to cover a Demand (DESIGN §3 "допустимые варианты тела/назначения"). */
const DemandOption = S.refine(S.object({
    body: S.array(S.nonEmpty()),
    cost: S.int({ min: 0 }),
    spawnTime: S.int({ min: 0 }),
    provides: nonNegNumber,
    travelTime: Measured,
}), function (o) {
    return o.body.length === 0 && o.cost > 0 ? [{ path: 'body', code: 'COST_WITHOUT_BODY' }] : [];
});

const Demand = S.object({
    stableKey: id,
    generation: S.int({ min: 0 }),
    missionId: S.nullable(id),
    roomName: roomName,
    capability: S.nonEmpty(),
    measurementUnit: S.enumOf(E.MeasurementUnit),
    amount: nonNegNumber,
    location: S.nullable(position),
    requiredBy: S.nullable(tick),
    earliestStart: S.nullable(tick),
    criticality: S.enumOf(E.Criticality),
    options: S.array(DemandOption),
    createdAt: tick,
});

const ReservationRequest = S.refine(S.object({
    kind: S.enumOf(E.ReservationKind),
    nodeId: id,
    targetNodeId: S.nullable(id),
    resourceType: S.nonEmpty(),
    amount: nonNegNumber,
    dueAt: S.nullable(tick),
}), function (r) {
    return r.kind === E.ReservationKind.MOVE && r.targetNodeId === null ? [{ path: 'targetNodeId', code: 'MOVE_WITHOUT_TARGET' }] : [];
});

const Proposal = S.object({
    proposalId: id,
    mode: S.enumOf({ SHADOW: E.RoomMode.SHADOW, ADAPTIVE_V1: E.RoomMode.ADAPTIVE_V1 }),
    roomName: S.nullable(roomName),
    missionId: S.nullable(id),
    tick: tick,
    inputFingerprint: fp,
    expectedRevision: S.nullable(S.int({ min: 0 })),
    reasonCode: reasonCode,
    demands: S.array(Demand),
    missionPatches: S.array(S.json(), { maxLength: 0 }), // stage A: always empty (missions are stage B)
    reservationRequests: S.array(ReservationRequest),
    dependencies: S.refine(S.array(id), sortedUniqueStrings),
});

const DecisionRecord = S.refine(S.object({
    decisionId: id,
    tick: tick,
    roomName: S.nullable(roomName),
    mode: S.enumOf(E.RoomMode),
    reasonCode: reasonCode,
    inputFingerprint: fp,
    inputs: S.json(),
    alternatives: S.array(S.object({
        label: S.nonEmpty(),
        proposalId: S.nullable(id),
        reasonCode: reasonCode,
        accepted: S.bool(),
    })),
    selectedProposalId: S.nullable(id),
    expectedNextFact: S.nullable(S.json()),
    resultKind: S.enumOf(ResultKind),
    executed: S.bool(),
}), function (d) {
    if (d.mode === E.RoomMode.SHADOW && d.executed) return [{ path: 'executed', code: 'SHADOW_EXECUTED' }];
    if (d.inputs === null || typeof d.inputs !== 'object' || Array.isArray(d.inputs)) return [{ path: 'inputs', code: 'EXPECTED_OBJECT' }];
    return [];
});

// ---------------------------------------------------------------- state and replay

const ControlRecord = S.object({
    requestedMode: S.enumOf(E.RoomMode),
    effectiveOwner: S.enumOf(E.EffectiveOwner),
    epoch: S.int({ min: 0 }),
    transitionPhase: S.nullable(S.nonEmpty()),
    transitionId: S.nullable(id),
    previousOwner: S.nullable(S.enumOf(E.EffectiveOwner)),
    blockedReason: S.nullable(reasonCode),
});

const ReplayFixtureHeader = S.refine(S.object({
    fixtureType: S.literal('ReplayFixture'),
    fixtureVersion: S.literal(1),
    contractVersion: S.nonEmpty(),
    buildId: S.nonEmpty(),
    schemaVersion: S.int({ min: 1 }),
    policyVersion: S.nullable(S.nonEmpty()),
    seed: S.nullable(S.int()),
    tickFrom: tick,
    tickTo: tick,
    rooms: S.refine(S.array(roomName), sortedUniqueStrings),
    contentFingerprint: fp,
    expectedReasonCodes: S.refine(S.array(reasonCode), sortedUniqueStrings),
}), function (h) {
    return h.tickFrom <= h.tickTo ? [] : [{ path: 'tickTo', code: 'RANGE_INVERTED' }];
});

const FaultStatus = S.object({
    component: id,
    consecutiveFailures: S.int({ min: 0 }),
    totalFailures: S.int({ min: 0 }),
    lastFailureTick: S.nullable(tick),
    lastInputFingerprint: S.nullable(fp),
    lastErrorCode: S.nullable(S.nonEmpty()),
    breakerUntil: S.nullable(tick),
    halfOpen: S.bool(),
});

// ---------------------------------------------------------------- cross-worker DTOs (A.2)

const reasonList = S.refine(S.array(reasonCode), sortedUniqueStrings);

/** Event processing cursor per room (A3). processedThroughTick is an effectTick. */
const EventCursor = S.refine(S.object({
    roomName: roomName,
    processedThroughTick: tick,
    lastObservedAt: tick,
    lastRawFingerprint: S.nullable(fp),
}), function (c) {
    return c.processedThroughTick < c.lastObservedAt ? [] : [{ path: 'processedThroughTick', code: 'NOT_BEFORE_OBSERVATION' }];
});

/**
 * Flow categories (DESIGN §3 observation profile). internalTransfer covers
 * transfer/withdraw/pickup/drop between own nodes and is NEVER income.
 */
const FLOW_FIELDS = Object.freeze(['harvest', 'externalIn', 'externalOut', 'spawnSpend', 'build', 'repair', 'upgrade', 'decayLoss', 'internalTransfer', 'unexplained']);

const Flows = S.object((function () {
    const fields = {};
    for (let i = 0; i < FLOW_FIELDS.length; i++) fields[FLOW_FIELDS[i]] = Measured;
    return fields;
})());

/** Energy flows of one room between two consecutive observations (A3). */
const FlowDelta = S.refine(S.object({
    roomName: roomName,
    fromTick: tick,
    toTick: tick,
    flows: Flows,
    quality: S.enumOf(E.Quality),
    reasonCodes: reasonList,
}), function (d) {
    return d.fromTick < d.toTick ? [] : [{ path: 'toTick', code: 'RANGE_INVERTED' }];
});

const FLOW_WINDOW_TICKS = 100;

/** 100-tick aggregate (DESIGN §3: 30 windows per room are retained). */
const FlowWindow = S.refine(S.object({
    roomName: roomName,
    windowStart: tick,
    windowEnd: tick,
    ticksCovered: S.int({ min: 0, max: FLOW_WINDOW_TICKS }),
    complete: S.bool(),
    topologyVersion: S.nullable(S.nonEmpty()),
    flows: Flows,
    quality: S.enumOf(E.Quality),
    reasonCodes: reasonList,
}), function (w) {
    const problems = [];
    if (w.windowStart % FLOW_WINDOW_TICKS !== 0) problems.push({ path: 'windowStart', code: 'NOT_WINDOW_ALIGNED' });
    if (w.windowEnd !== w.windowStart + FLOW_WINDOW_TICKS) problems.push({ path: 'windowEnd', code: 'BAD_WINDOW_END' });
    if (w.complete && w.ticksCovered !== FLOW_WINDOW_TICKS) problems.push({ path: 'complete', code: 'COMPLETE_WITH_GAPS' });
    return problems;
});

/** Authoritative creep binding of the new system (ARCHITECTURE §6). Stage A: none are written. */
const Binding = S.object({
    homeRoom: roomName,
    ownerEpoch: S.int({ min: 0 }),
    originEpoch: S.int({ min: 0 }),
    legacyOrderId: S.nullable(id),
    operationKey: S.nullable(operationKey),
    demandKey: S.nullable(id),
    generation: S.nullable(S.int({ min: 0 })),
    assignmentId: S.nullable(id),
    observedLifeState: S.enumOf(E.LifeState),
});

/** Observation-only binding of an existing (legacy) creep (A3). Grants no rights. */
const ObservedBinding = S.refine(S.object({
    homeRoom: S.nullable(roomName),
    homeSource: S.enumOf(E.HomeSource),
    homeQuality: S.enumOf(E.Quality),
    legacyRole: S.nullable(S.nonEmpty()),
    legacyOrderId: S.nullable(id),
    body: S.array(S.nonEmpty()),
    bodyCost: S.int({ min: 0 }),
    firstSeen: tick,
    lastSeen: tick,
    lifeState: S.enumOf(E.LifeState),
}), function (b) {
    const problems = [];
    if ((b.homeRoom === null) !== (b.homeSource === E.HomeSource.UNKNOWN)) problems.push({ path: 'homeSource', code: 'HOME_SOURCE_MISMATCH' });
    if (b.homeRoom === null && b.homeQuality !== E.Quality.UNKNOWN) problems.push({ path: 'homeQuality', code: 'NULL_VALUE_NOT_UNKNOWN' });
    if (b.firstSeen > b.lastSeen) problems.push({ path: 'lastSeen', code: 'RANGE_INVERTED' });
    return problems;
});

/** A world/legacy action observed in shadow (A3); not an Operation of ours (no operationKey). */
const ObservedOperation = S.refine(S.object({
    observationKey: id,
    kind: S.enumOf(E.ObservedOperationKind),
    roomName: roomName,
    actorRef: S.nullable(id),
    targetRef: S.nullable(id),
    firstSeen: tick,
    lastSeen: tick,
    effect: S.enumOf(E.EffectKind),
    amount: Measured,
    energyAmount: Measured,
    eventKeys: S.refine(S.array(S.nonEmpty()), sortedUniqueStrings),
}), function (o) {
    return o.firstSeen <= o.lastSeen ? [] : [{ path: 'lastSeen', code: 'RANGE_INVERTED' }];
});

const CalendarEntry = S.object({
    tick: tick,
    roomName: roomName,
    kind: S.enumOf(E.CalendarEntryKind),
    amount: Measured,
    stableKey: id,
    reasonCode: S.nullable(reasonCode),
});

function calendarOrder(a, b) {
    if (a.tick !== b.tick) return a.tick < b.tick ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.stableKey !== b.stableKey) return a.stableKey < b.stableKey ? -1 : 1;
    return 0;
}

/** Forecast calendar of one room (A4); entries sorted by (tick, kind, stableKey), unique. */
const Calendar = S.refine(S.object({
    roomName: roomName,
    fromTick: tick,
    horizon: S.int({ min: 1 }),
    entries: S.array(CalendarEntry),
    quality: S.enumOf(E.Quality),
    reasonCodes: reasonList,
}), function (c) {
    const problems = [];
    for (let i = 0; i < c.entries.length; i++) {
        const e = c.entries[i];
        if (e.roomName !== c.roomName) problems.push({ path: 'entries/' + i + '/roomName', code: 'KEY_MISMATCH' });
        if (e.tick < c.fromTick || e.tick > c.fromTick + c.horizon) problems.push({ path: 'entries/' + i + '/tick', code: 'OUTSIDE_HORIZON' });
        if (i > 0 && calendarOrder(c.entries[i - 1], e) >= 0) problems.push({ path: 'entries/' + i, code: 'NOT_SORTED_UNIQUE' });
    }
    return problems;
});

/** Free energy per ledger node (A4). free = observed - reserved - disputed (may be negative = overcommitted). */
const LedgerNodeView = S.refine(S.object({
    nodeId: id,
    observed: Measured,
    reserved: nonNegNumber,
    disputed: nonNegNumber,
    free: Measured,
}), function (n) {
    if (n.observed.value === null) return n.free.value === null ? [] : [{ path: 'free', code: 'FREE_KNOWN_WITHOUT_OBSERVATION' }];
    if (n.free.value === null) return [{ path: 'free', code: 'FREE_UNKNOWN_WITH_OBSERVATION' }];
    return Math.abs(n.free.value - (n.observed.value - n.reserved - n.disputed)) > 1e-9 ? [{ path: 'free', code: 'FREE_NOT_BALANCED' }] : [];
});

const LedgerView = S.object({
    roomName: roomName,
    tick: tick,
    nodes: S.refine(S.array(LedgerNodeView), sortedBy('nodeId')), // includes spawnPool:<room> for SPEND on spawning
});

/** Planned replacement of one demand's executor (A4). */
const ReplacementPlanEntry = S.object({
    stableKey: id,
    roomName: roomName,
    currentCreepName: S.nullable(id),
    ticksToLive: Measured,
    body: S.array(S.nonEmpty()),
    bodyCost: S.int({ min: 0 }),
    spawnTime: S.int({ min: 0 }),
    travelTime: Measured,
    startBy: S.nullable(tick),
    deadline: S.nullable(tick),
    criticality: S.enumOf(E.Criticality),
    reasonCode: S.nullable(reasonCode),
    quality: S.enumOf(E.Quality),
});

const ReplacementPlan = S.object({
    roomName: roomName,
    tick: tick,
    horizon: S.int({ min: 1 }),
    entries: S.refine(S.array(ReplacementPlanEntry), sortedBy('stableKey')),
});

/** Persisted forecast summary per room (A4, Memory.strategyShadow.rooms[room].forecast). */
const ForecastSummary = S.object({
    roomName: roomName,
    computedAt: tick,
    horizon: S.int({ min: 1 }),
    freeEnergyNow: Measured,
    incomeLowerPerTick: Measured,
    committedPayments: Measured,
    nextDeficitTick: S.nullable(tick),
    calendarFingerprint: S.nullable(fp),
    quality: S.enumOf(E.Quality),
    reasonCodes: reasonList,
});

/** Structural StatePatch; ownership and value schema are checked by stateLayout.validateStatePatch. */
const StatePatchShape = S.refine(S.object({
    patchId: id,
    writer: S.enumOf(E.StateWriter),
    namespace: S.enumOf({ STRATEGY: 'strategy', SHADOW: 'strategyShadow' }),
    path: S.array(S.nonEmpty()),
    op: S.enumOf(E.PatchOp),
    value: S.optional(S.json()),
}), function (p) {
    const problems = [];
    if (p.path.length === 0) problems.push({ path: 'path', code: 'EMPTY_PATH' });
    const hasValue = Object.prototype.hasOwnProperty.call(p, 'value');
    if (p.op === E.PatchOp.SET && !hasValue) problems.push({ path: 'value', code: 'SET_WITHOUT_VALUE' });
    if (p.op === E.PatchOp.DELETE && hasValue) problems.push({ path: 'value', code: 'DELETE_WITH_VALUE' });
    return problems;
});

function eventOrder(a, b) {
    if (a.effectTick !== b.effectTick) return a.effectTick < b.effectTick ? -1 : 1;
    if (a.roomName !== b.roomName) return a.roomName < b.roomName ? -1 : 1;
    if (a.originalArrayIndex !== b.originalArrayIndex) return a.originalArrayIndex < b.originalArrayIndex ? -1 : 1;
    return 0;
}

/** Selected StateView fields stored in a replay fixture (no foreign Memory). */
const ReplayStateSelection = S.object({
    revision: S.int({ min: 0 }),
    control: S.object({ rooms: S.record(roomName, ControlRecord) }),
    shadowRooms: S.record(roomName, S.object({
        eventCursor: S.nullable(EventCursor),
        flowWindows: S.array(FlowWindow),
    })),
});

const ReplayFixtureBody = S.refine(S.object({
    snapshots: S.refine(S.array(Snapshot), sortedBy('tick')),
    state: ReplayStateSelection,
    events: S.array(NormalizedEvent),
    expectedReasonCodes: reasonList,
    expectedForecast: S.record(roomName, ForecastSummary),
}), function (b) {
    const problems = [];
    if (b.snapshots.length === 0) problems.push({ path: 'snapshots', code: 'EMPTY' });
    for (let i = 1; i < b.events.length; i++) {
        if (eventOrder(b.events[i - 1], b.events[i]) >= 0) problems.push({ path: 'events/' + i, code: 'NOT_SORTED_UNIQUE' });
    }
    return problems;
});

const ReplayFixture = S.refine(S.object({
    header: ReplayFixtureHeader,
    body: ReplayFixtureBody,
}), function (f) {
    const problems = [];
    if (fingerprint(f.body) !== f.header.contentFingerprint) problems.push({ path: 'header/contentFingerprint', code: 'FINGERPRINT_MISMATCH' });
    const snaps = f.body.snapshots;
    if (snaps.length > 0 && (snaps[0].tick !== f.header.tickFrom || snaps[snaps.length - 1].tick !== f.header.tickTo)) problems.push({ path: 'header/tickFrom', code: 'RANGE_MISMATCH' });
    if (f.header.expectedReasonCodes.join(',') !== f.body.expectedReasonCodes.join(',')) problems.push({ path: 'header/expectedReasonCodes', code: 'KEY_MISMATCH' });
    return problems;
});

const SCHEMAS = Object.freeze({
    Measured: Measured,
    BodyPart: BodyPart,
    CreepSnapshot: CreepSnapshot,
    SpawnSnapshot: SpawnSnapshot,
    SourceSnapshot: SourceSnapshot,
    ControllerSnapshot: ControllerSnapshot,
    HostileSnapshot: HostileSnapshot,
    ConstructionSiteSnapshot: ConstructionSiteSnapshot,
    EnergyNode: EnergyNode,
    RawEventEntry: RawEventEntry,
    EventLogCapture: EventLogCapture,
    RoomSnapshot: RoomSnapshot,
    Snapshot: Snapshot,
    NormalizedEvent: NormalizedEvent,
    EventGap: EventGap,
    CallReceipt: CallReceipt,
    EffectResult: EffectResult,
    Operation: Operation,
    Reservation: Reservation,
    Demand: Demand,
    ReservationRequest: ReservationRequest,
    Proposal: Proposal,
    DecisionRecord: DecisionRecord,
    ControlRecord: ControlRecord,
    ReplayFixtureHeader: ReplayFixtureHeader,
    FaultStatus: FaultStatus,
    DemandOption: DemandOption,
    EventCursor: EventCursor,
    FlowDelta: FlowDelta,
    FlowWindow: FlowWindow,
    Binding: Binding,
    ObservedBinding: ObservedBinding,
    ObservedOperation: ObservedOperation,
    CalendarEntry: CalendarEntry,
    Calendar: Calendar,
    LedgerNodeView: LedgerNodeView,
    LedgerView: LedgerView,
    ReplacementPlanEntry: ReplacementPlanEntry,
    ReplacementPlan: ReplacementPlan,
    ForecastSummary: ForecastSummary,
    StatePatchShape: StatePatchShape,
    ReplayStateSelection: ReplayStateSelection,
    ReplayFixtureBody: ReplayFixtureBody,
    ReplayFixture: ReplayFixture,
});

function validator(name) {
    const schema = SCHEMAS[name];
    return function (value) { return validate(schema, value); };
}

/**
 * Validate a Snapshot; with {checkFingerprint:true} also recompute its fingerprint.
 * @param {*} value
 * @param {{checkFingerprint?: boolean}} [options]
 */
function validateSnapshot(value, options) {
    const result = validate(Snapshot, value);
    if (!result.ok || !(options && options.checkFingerprint)) return result;
    if (snapshotFingerprint(value) !== value.fingerprint) return { ok: false, errors: [{ path: '$/fingerprint', code: 'FINGERPRINT_MISMATCH' }] };
    return result;
}

/**
 * Disputed = not terminal and part of the amount has an unknown outcome
 * (the node's optional spending stays closed while disputed).
 * @param {object} reservation
 */
function isDisputedReservation(reservation) {
    return reservation.unknownAmount > 0 && E.RESERVATION_TRANSITIONS[reservation.state].length > 0;
}

module.exports = {
    SCHEMAS,
    FLOW_FIELDS,
    FLOW_WINDOW_TICKS,
    SNAPSHOT_FINGERPRINT_EXCLUDED,
    measured,
    unknownMeasure,
    snapshotFingerprint,
    isDisputedReservation,
    validateMeasured: validator('Measured'),
    validateEnergyNode: validator('EnergyNode'),
    validateCreepSnapshot: validator('CreepSnapshot'),
    validateRoomSnapshot: validator('RoomSnapshot'),
    validateSnapshot: validateSnapshot,
    validateNormalizedEvent: validator('NormalizedEvent'),
    validateEventGap: validator('EventGap'),
    validateCallReceipt: validator('CallReceipt'),
    validateEffectResult: validator('EffectResult'),
    validateOperation: validator('Operation'),
    validateReservation: validator('Reservation'),
    validateDemand: validator('Demand'),
    validateProposal: validator('Proposal'),
    validateDecisionRecord: validator('DecisionRecord'),
    validateControlRecord: validator('ControlRecord'),
    validateReplayFixtureHeader: validator('ReplayFixtureHeader'),
    validateFaultStatus: validator('FaultStatus'),
    validateDemandOption: validator('DemandOption'),
    validateEventCursor: validator('EventCursor'),
    validateFlowDelta: validator('FlowDelta'),
    validateFlowWindow: validator('FlowWindow'),
    validateBinding: validator('Binding'),
    validateObservedBinding: validator('ObservedBinding'),
    validateObservedOperation: validator('ObservedOperation'),
    validateCalendar: validator('Calendar'),
    validateLedgerView: validator('LedgerView'),
    validateReplacementPlan: validator('ReplacementPlan'),
    validateForecastSummary: validator('ForecastSummary'),
    validateReplayFixture: validator('ReplayFixture'),
};
