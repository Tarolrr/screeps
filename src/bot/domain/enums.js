// Frozen enums of contract A.2 (docs/strategy/CONTRACTS-A.md §3).
// Values are strings stored as-is in DTOs and persisted records.

function makeEnum(values) {
    const result = {};
    for (let i = 0; i < values.length; i++) result[values[i]] = values[i];
    return Object.freeze(result);
}

/** Tick phases (ARCHITECTURE §3). */
const Phase = makeEnum(['BOOT', 'OBSERVE', 'RECONCILE', 'CRITICAL', 'FORECAST', 'PLAN', 'ADMIT', 'EXECUTE', 'CLOSE']);

/** Requested room mode in strategy.control.rooms[room].requestedMode (INTEGRATION). */
const RoomMode = Object.freeze({ LEGACY: 'legacy', SHADOW: 'shadow', ADAPTIVE_V1: 'adaptive-v1' });

/** Who executes intents for a room. 'unconfirmed' = control unknown/invalid, nobody is granted new rights. */
const EffectiveOwner = Object.freeze({ LEGACY: 'legacy', ADAPTIVE_V1: 'adaptive-v1', UNCONFIRMED: 'unconfirmed' });

/** Status of the new system for a room/domain. */
const NewSystemStatus = makeEnum(['OFF', 'SHADOW', 'SUSPENDED']);

/** Measurement quality attached to a value that may be unknown (value null <=> UNKNOWN). */
const Quality = makeEnum(['OBSERVED', 'DERIVED', 'ESTIMATED', 'STALE', 'UNKNOWN']);

/** Room visibility at capture time. */
const Visibility = makeEnum(['VISIBLE', 'NOT_VISIBLE']);

/** Physical energy node classes (DESIGN §3): every unit is counted in exactly one node. */
const EnergyNodeClass = makeEnum(['SPAWN_EXTENSION', 'STORAGE_CONTAINER', 'CARGO', 'PILE', 'REMOTE']);

/** Concrete object type behind an energy node. */
const EnergyObjectType = makeEnum(['spawn', 'extension', 'storage', 'container', 'link', 'terminal', 'tower', 'creep', 'resource', 'tombstone', 'ruin', 'remote']);

/** Which EnergyObjectType values belong to which EnergyNodeClass. */
const ENERGY_NODE_OBJECT_TYPES = Object.freeze({
    SPAWN_EXTENSION: Object.freeze(['spawn', 'extension']),
    STORAGE_CONTAINER: Object.freeze(['storage', 'container', 'link', 'terminal', 'tower']),
    CARGO: Object.freeze(['creep']),
    PILE: Object.freeze(['resource', 'tombstone', 'ruin']),
    REMOTE: Object.freeze(['remote']),
});

/** Event log capture status for one room/effectTick. */
const EventLogStatus = makeEnum(['CAPTURED', 'NOT_VISIBLE', 'UNAVAILABLE']);

/** Normalized event types (A3 maps raw EVENT_* codes; unmapped codes -> OTHER). */
const NormalizedEventType = makeEnum([
    'ATTACK', 'OBJECT_DESTROYED', 'ATTACK_CONTROLLER', 'BUILD', 'HARVEST', 'HEAL', 'REPAIR',
    'RESERVE_CONTROLLER', 'UPGRADE_CONTROLLER', 'EXIT', 'POWER', 'TRANSFER', 'OTHER',
]);

/** Operation lifecycle (ARCHITECTURE §5). */
const OperationState = makeEnum(['PREPARED', 'ISSUED', 'CONFIRMED', 'NO_EFFECT', 'UNKNOWN', 'UNKNOWN_RETIRED']);

/**
 * Allowed operation transitions. Same-state transitions only where listed:
 *   ISSUED->ISSUED   partial confirmation (confirmedAmount grows);
 *   UNKNOWN->UNKNOWN partial confirmation while the rest stays unknown;
 *   NO_EFFECT->ISSUED retry of the SAME operationKey with a NEW commandId after
 *                    preconditions were re-checked (ARCHITECTURE §5).
 * CONFIRMED and UNKNOWN_RETIRED are terminal. UNKNOWN never goes back to ISSUED:
 * a possibly executed operation is not repeated by assumption.
 */
const OPERATION_TRANSITIONS = Object.freeze({
    PREPARED: Object.freeze(['ISSUED', 'NO_EFFECT', 'UNKNOWN']),
    ISSUED: Object.freeze(['ISSUED', 'CONFIRMED', 'NO_EFFECT', 'UNKNOWN']),
    UNKNOWN: Object.freeze(['UNKNOWN', 'CONFIRMED', 'NO_EFFECT', 'UNKNOWN_RETIRED']),
    NO_EFFECT: Object.freeze(['ISSUED']),
    CONFIRMED: Object.freeze([]),
    UNKNOWN_RETIRED: Object.freeze([]),
});

/** Reservation kinds (ARCHITECTURE §5). */
const ReservationKind = makeEnum(['SPEND', 'MOVE', 'CAPACITY']);

/**
 * Reservation lifecycle (DESIGN §3) + RETIRED (ARCHITECTURE §5 UNKNOWN_RETIRED):
 * the disputed (unknownAmount) part is no longer held on the node, but its upper
 * bound keeps counting against the mission limit / exposure.
 * A reservation is "disputed" while it is not terminal and unknownAmount > 0.
 */
const ReservationState = makeEnum(['RESERVED', 'ISSUED', 'SETTLED', 'PARTIAL', 'RELEASED', 'RETIRED']);

const RESERVATION_TRANSITIONS = Object.freeze({
    RESERVED: Object.freeze(['ISSUED', 'RELEASED']),
    ISSUED: Object.freeze(['ISSUED', 'SETTLED', 'PARTIAL', 'RELEASED', 'RETIRED']),
    PARTIAL: Object.freeze(['PARTIAL', 'SETTLED', 'RELEASED', 'RETIRED']),
    SETTLED: Object.freeze([]),
    RELEASED: Object.freeze([]),
    RETIRED: Object.freeze([]),
});

/** Observed life state of a creep binding. */
const LifeState = makeEnum(['SPAWNING', 'ALIVE', 'DEAD', 'MISSING', 'UNKNOWN']);

/** Where an ObservedBinding's home room came from (best first). */
const HomeSource = makeEnum(['LEGACY_ORDER', 'CREEP_MEMORY', 'SPAWN_ROOM', 'CURRENT_ROOM', 'UNKNOWN']);

/** Kinds of legacy/world operations observed by A3 in shadow (no operationKey of ours). */
const ObservedOperationKind = makeEnum(['SPAWN', 'TRANSFER', 'PICKUP', 'BUILD', 'REPAIR', 'UPGRADE', 'HARVEST', 'OTHER']);

/** Forecast calendar entry kinds. */
const CalendarEntryKind = makeEnum(['INCOME', 'PAYMENT', 'DEADLINE']);

/** Funding status of a room domain after reconciliation (ARCHITECTURE §5). */
const DomainStatus = makeEnum(['OK', 'UNCERTAIN_FUNDING']);

/** strategy.migrations.status */
const MigrationStatus = makeEnum(['NONE', 'RUNNING', 'CANCELLED', 'DONE']);

/** StatePatch operations. */
const PatchOp = Object.freeze({ SET: 'set', DELETE: 'delete' });

/** Writers allowed to submit StatePatch through StateStore.apply (one per stage-A task). */
const StateWriter = Object.freeze({ STATE: 'state', OBSERVATION: 'observation', FINANCE: 'finance', PLANNING: 'planning' });

/** Demand measurement units (ARCHITECTURE §4). */
const MeasurementUnit = Object.freeze({ ENERGY_PER_TICK: 'energy/tick', WORK_PER_TICK: 'work/tick', COVERAGE: 'coverage' });

/** Demand criticality. */
const Criticality = makeEnum(['CRITICAL', 'REQUIRED', 'OPTIONAL']);

/** CallReceipt kinds: what happened to the API call, never the effect (§4). */
const CallReceiptKind = makeEnum(['RETURNED', 'THREW']);

/** EffectMatcher output kinds (§4). */
const EffectKind = makeEnum(['CONFIRMED', 'NO_EFFECT', 'UNKNOWN']);

/** Status of a StateView returned by StateStore.open. */
const StateStatus = makeEnum(['OPEN', 'READ_ONLY', 'SUSPENDED']);

/** Component work-budget class used by TickRunner/WorkBudget. */
const BudgetClass = Object.freeze({ EXEMPT: 'exempt', CRITICAL: 'critical', OPTIONAL: 'optional' });

/**
 * @param {object} enumObject
 * @param {*} value
 * @returns {boolean}
 */
function isEnumValue(enumObject, value) {
    if (typeof value !== 'string') return false;
    for (const key in enumObject) {
        if (Object.prototype.hasOwnProperty.call(enumObject, key) && enumObject[key] === value) return true;
    }
    return false;
}

/**
 * @param {object} transitions one of OPERATION_TRANSITIONS / RESERVATION_TRANSITIONS
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransition(transitions, from, to) {
    const allowed = Object.prototype.hasOwnProperty.call(transitions, from) ? transitions[from] : null;
    return allowed !== null && allowed.indexOf(to) !== -1;
}

module.exports = {
    Phase,
    RoomMode,
    EffectiveOwner,
    NewSystemStatus,
    Quality,
    Visibility,
    EnergyNodeClass,
    EnergyObjectType,
    ENERGY_NODE_OBJECT_TYPES,
    EventLogStatus,
    NormalizedEventType,
    OperationState,
    OPERATION_TRANSITIONS,
    ReservationKind,
    ReservationState,
    RESERVATION_TRANSITIONS,
    LifeState,
    HomeSource,
    ObservedOperationKind,
    CalendarEntryKind,
    DomainStatus,
    MigrationStatus,
    PatchOp,
    StateWriter,
    MeasurementUnit,
    Criticality,
    CallReceiptKind,
    EffectKind,
    StateStatus,
    BudgetClass,
    isEnumValue,
    canTransition,
};
