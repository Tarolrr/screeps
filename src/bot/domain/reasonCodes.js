// Frozen reason-code enum of contract A.2 (docs/strategy/CONTRACTS-A.md §2).
// Journals store the code plus the values that allow it to be checked; human
// readable text is generated on top (ARCHITECTURE §4). Adding a code is a
// contract change and goes through the coordinator.

const ReasonCode = Object.freeze({
    // ARCHITECTURE §4 minimum
    STALE_OWNER: 'STALE_OWNER',
    STALE_INPUT: 'STALE_INPUT',
    NO_VISIBILITY: 'NO_VISIBILITY',
    INSUFFICIENT_LIQUIDITY: 'INSUFFICIENT_LIQUIDITY',
    CRITICAL_DEADLINE: 'CRITICAL_DEADLINE',
    BUDGET_DEFERRED: 'BUDGET_DEFERRED',
    AMBIGUOUS_EFFECT: 'AMBIGUOUS_EFFECT',
    INCOMPATIBLE_SCHEMA: 'INCOMPATIBLE_SCHEMA',
    UNSUPPORTED_CAPABILITY: 'UNSUPPORTED_CAPABILITY',
    LEGACY_BINDING_CONFLICT: 'LEGACY_BINDING_CONFLICT',

    // Stage A additions (justification in CONTRACTS-A.md §2)
    EVENT_GAP: 'EVENT_GAP',                       // §5: lost event interval, never filled with zeros
    UNEXPLAINED_BALANCE: 'UNEXPLAINED_BALANCE',   // DESIGN §3: balance delta not explained by flows
    UNCERTAIN_FUNDING: 'UNCERTAIN_FUNDING',       // §5: domain lost evidence, optional spending closed
    SHADOW_ONLY: 'SHADOW_ONLY',                   // shadow decision, never executed
    NO_HISTORY: 'NO_HISTORY',                     // DESIGN §3: fewer than 3 complete flow windows
    MISSING_FIELD: 'MISSING_FIELD',               // required observation absent -> UNKNOWN, not 0
    INVALID_RECORD: 'INVALID_RECORD',             // DTO/persisted record failed validation (quarantine)
    NAME_COLLISION: 'NAME_COLLISION',             // §5: short name hash maps to another full key
    COMPONENT_FAULT: 'COMPONENT_FAULT',           // §7: component threw, its output rejected
    RETRY_COOLDOWN: 'RETRY_COOLDOWN',             // §7: retry < 25 ticks with unchanged input
    CIRCUIT_OPEN: 'CIRCUIT_OPEN',                 // §7: 3 consecutive failures -> 100 tick breaker

    // contract A.4 (STRAT-A5)
    NOT_REQUESTED: 'NOT_REQUESTED',               // new-system work not requested for the room (default legacy, no shadow)
});

const REASON_CODE_LIST = Object.freeze(Object.keys(ReasonCode).sort());

/**
 * @param {*} value
 * @returns {boolean}
 */
function isReasonCode(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ReasonCode, value);
}

/**
 * @param {*} value
 * @returns {string}
 * @throws {TypeError}
 */
function assertReasonCode(value) {
    if (!isReasonCode(value)) throw new TypeError('Unknown reason code: ' + String(value));
    return value;
}

module.exports = {
    ReasonCode,
    REASON_CODE_LIST,
    isReasonCode,
    assertReasonCode,
};
