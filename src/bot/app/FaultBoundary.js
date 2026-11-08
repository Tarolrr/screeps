// FaultBoundary of contract A.2 (ARCHITECTURE §7).
//
// One boundary instance guards many components, each with its own FaultStatus:
//   - an exception rejects only that component's output:
//       REJECTED(COMPONENT_FAULT, {component, errorName, message, tick, consecutiveFailures})
//   - after a failure the component is not retried earlier than RETRY_COOLDOWN_TICKS (25)
//     unless its inputFingerprint changed -> REJECTED(RETRY_COOLDOWN, {component, retryAt});
//   - BREAKER_THRESHOLD (3) consecutive failures open a breaker for BREAKER_TICKS (100)
//     -> REJECTED(CIRCUIT_OPEN, {component, until}); input change does not bypass it;
//   - after the breaker expires the component is half-open: one success closes it,
//     one failure re-opens it for another 100 ticks;
//   - `bypassCooldown` components (legacy executor, critical observation) always run;
//     their failures are still recorded for diagnostics.
// Status lives in an injectable store: default is a heap Map (lost on reset);
// A2 may provide a store backed by StateStore namespace `faults`.

const { REJECTED, isResult } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { isFingerprint } = require('../domain/fingerprint');

const RETRY_COOLDOWN_TICKS = 25;
const BREAKER_THRESHOLD = 3;
const BREAKER_TICKS = 100;
const MAX_MESSAGE = 200;

/**
 * @typedef {Object} FaultStatus
 * @property {string} component
 * @property {number} consecutiveFailures
 * @property {number} totalFailures
 * @property {number|null} lastFailureTick
 * @property {string|null} lastInputFingerprint
 * @property {string|null} lastErrorCode
 * @property {number|null} breakerUntil
 * @property {boolean} halfOpen
 */

/**
 * @typedef {Object} FaultStore
 * @property {function(string): (FaultStatus|null)} load returns a MUTABLE COPY (never the stored object)
 * @property {function(string, FaultStatus): void} save
 */

/** @returns {FaultStore} heap-only store */
function createHeapFaultStore() {
    const map = new Map();
    return {
        load: function (component) { return map.has(component) ? Object.assign({}, map.get(component)) : null; },
        save: function (component, status) { map.set(component, Object.assign({}, status)); },
    };
}

function emptyStatus(component) {
    return {
        component: component,
        consecutiveFailures: 0,
        totalFailures: 0,
        lastFailureTick: null,
        lastInputFingerprint: null,
        lastErrorCode: null,
        breakerUntil: null,
        halfOpen: false,
    };
}

function describeError(error) {
    const name = error && typeof error.name === 'string' && error.name ? error.name : 'Error';
    let message = error && typeof error.message === 'string' ? error.message : String(error);
    if (message.length > MAX_MESSAGE) message = message.slice(0, MAX_MESSAGE);
    return { name: name, message: message };
}

/**
 * @param {{store?: FaultStore, log?: {warn: function(string, object): void}}} [options]
 */
function createFaultBoundary(options) {
    const store = options && options.store ? options.store : createHeapFaultStore();
    const log = options && options.log ? options.log : null;

    /**
     * @param {string} component stable component name
     * @param {{tick:(number|null), inputFingerprint?:(string|null), bypassCooldown?:boolean}} guard
     * @param {function(): object} fn must return a Result
     * @returns {object} Result
     */
    function run(component, guard, fn) {
        const tick = typeof guard.tick === 'number' ? guard.tick : null;
        const inputFingerprint = isFingerprint(guard.inputFingerprint) ? guard.inputFingerprint : null;
        const bypass = !!guard.bypassCooldown;
        const loaded = store.load(component);
        // The store contract says load() returns a mutable copy; copy again defensively.
        const status = loaded ? Object.assign({}, loaded) : emptyStatus(component);

        if (!bypass && tick !== null) {
            if (status.breakerUntil !== null) {
                if (tick < status.breakerUntil) return REJECTED(ReasonCode.CIRCUIT_OPEN, { component: component, until: status.breakerUntil });
                status.breakerUntil = null;
                status.halfOpen = true;
                store.save(component, status);
            }
            if (status.consecutiveFailures > 0 && status.lastFailureTick !== null &&
                tick < status.lastFailureTick + RETRY_COOLDOWN_TICKS &&
                (inputFingerprint === null || inputFingerprint === status.lastInputFingerprint)) {
                return REJECTED(ReasonCode.RETRY_COOLDOWN, { component: component, retryAt: status.lastFailureTick + RETRY_COOLDOWN_TICKS });
            }
        }

        let output;
        let failure = null;
        try {
            output = fn();
            if (!isResult(output)) failure = { name: 'ContractError', message: 'component returned a non-Result value' };
        } catch (error) {
            failure = describeError(error);
        }

        if (failure === null) {
            if (status.consecutiveFailures !== 0 || status.halfOpen || status.breakerUntil !== null) {
                status.consecutiveFailures = 0;
                status.halfOpen = false;
                status.breakerUntil = null;
                store.save(component, status);
            }
            return output;
        }

        status.consecutiveFailures += 1;
        status.totalFailures += 1;
        status.lastFailureTick = tick;
        status.lastInputFingerprint = inputFingerprint;
        status.lastErrorCode = failure.name;
        if (!bypass && tick !== null && (status.halfOpen || status.consecutiveFailures >= BREAKER_THRESHOLD)) {
            status.breakerUntil = tick + BREAKER_TICKS;
            status.halfOpen = false;
        }
        store.save(component, status);
        const evidence = {
            component: component,
            consecutiveFailures: status.consecutiveFailures,
            errorName: failure.name,
            message: failure.message,
            tick: tick,
        };
        if (log) log.warn('COMPONENT_FAULT', evidence);
        return REJECTED(ReasonCode.COMPONENT_FAULT, evidence);
    }

    return Object.freeze({
        run: run,
        /** @returns {FaultStatus} copy of the current status */
        status: function (component) { return store.load(component) || emptyStatus(component); },
    });
}

module.exports = {
    RETRY_COOLDOWN_TICKS,
    BREAKER_THRESHOLD,
    BREAKER_TICKS,
    createFaultBoundary,
    createHeapFaultStore,
};
