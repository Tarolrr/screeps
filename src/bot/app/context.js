// Capability sets and planning contexts of contract A.2 (ARCHITECTURE §4).
//
// A context carries values only: tick, immutable snapshot, state view/revision,
// versions, owner tokens, capability flags, a WorkBudget view and accepted
// reservations. It never contains raw Game, Memory or a Gateway. In stage A no
// context has a `gateway` key at all (shadow: by contract; legacy: legacy runs
// through LegacyAdapter, not through contexts).

const { deepFreeze } = require('../domain/freeze');
const { RoomMode } = require('../domain/enums');

const Capability = Object.freeze({
    READ_SNAPSHOT: 'READ_SNAPSHOT',
    READ_STATE: 'READ_STATE',
    PROPOSE: 'PROPOSE',
    RECORD_SHADOW_TELEMETRY: 'RECORD_SHADOW_TELEMETRY',
    ISSUE_INTENTS: 'ISSUE_INTENTS',
    WRITE_LEGACY_MEMORY: 'WRITE_LEGACY_MEMORY',
});

/** Capability flags per mode in stage A. ISSUE_INTENTS/WRITE_LEGACY_MEMORY are never granted. */
const STAGE_A_CAPABILITIES = Object.freeze({
    legacy: Object.freeze({ READ_SNAPSHOT: true, READ_STATE: true, PROPOSE: false, RECORD_SHADOW_TELEMETRY: false, ISSUE_INTENTS: false, WRITE_LEGACY_MEMORY: false }),
    shadow: Object.freeze({ READ_SNAPSHOT: true, READ_STATE: true, PROPOSE: true, RECORD_SHADOW_TELEMETRY: true, ISSUE_INTENTS: false, WRITE_LEGACY_MEMORY: false }),
});

const FORBIDDEN_CONTEXT_KEYS = Object.freeze(['gateway', 'game', 'Game', 'memory', 'Memory', 'rawMemory', 'RawMemory']);

/**
 * @param {string} mode 'legacy' | 'shadow'
 * @returns {Readonly<Object<string, boolean>>}
 */
function capabilitiesFor(mode) {
    if (mode === RoomMode.ADAPTIVE_V1) throw new TypeError('adaptive-v1 has no capability set in stage A (UNSUPPORTED_CAPABILITY)');
    if (!Object.prototype.hasOwnProperty.call(STAGE_A_CAPABILITIES, mode)) throw new TypeError('Unknown mode: ' + String(mode));
    return STAGE_A_CAPABILITIES[mode];
}

/**
 * Build a frozen planning context. Throws if a forbidden key (gateway, Game,
 * Memory...) is supplied.
 * @param {Object} parts
 * @param {string} parts.mode 'legacy' | 'shadow'
 * @param {number} parts.tick
 * @param {object|null} parts.snapshot Snapshot DTO (deep-frozen here)
 * @param {object|null} parts.stateView StateView DTO (deep-frozen here)
 * @param {number|null} parts.stateRevision
 * @param {{contractVersion:string, schemaVersion:number, buildId:string, policyVersion:(string|null)}} parts.versions
 * @param {Object<string, {room:string, owner:string, epoch:number}>} parts.ownerTokens
 * @param {{admit: function(object): object}} parts.budget WorkBudget view
 * @param {object[]} [parts.reservations] accepted reservations of this tick
 */
function createContext(parts) {
    for (let i = 0; i < FORBIDDEN_CONTEXT_KEYS.length; i++) {
        if (Object.prototype.hasOwnProperty.call(parts, FORBIDDEN_CONTEXT_KEYS[i])) {
            throw new TypeError('Context must not carry ' + FORBIDDEN_CONTEXT_KEYS[i]);
        }
    }
    const capabilities = capabilitiesFor(parts.mode);
    return Object.freeze({
        mode: parts.mode,
        tick: parts.tick,
        snapshot: parts.snapshot === null || parts.snapshot === undefined ? null : deepFreeze(parts.snapshot),
        stateView: parts.stateView === null || parts.stateView === undefined ? null : deepFreeze(parts.stateView),
        stateRevision: parts.stateRevision === undefined ? null : parts.stateRevision,
        versions: deepFreeze(Object.assign({}, parts.versions)),
        ownerTokens: deepFreeze(Object.assign({}, parts.ownerTokens || {})),
        capabilities: capabilities,
        budget: parts.budget,
        reservations: deepFreeze((parts.reservations || []).slice()),
    });
}

module.exports = {
    Capability,
    STAGE_A_CAPABILITIES,
    FORBIDDEN_CONTEXT_KEYS,
    capabilitiesFor,
    createContext,
};
