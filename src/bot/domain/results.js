// Computation results of contract A.2 (ARCHITECTURE §4).
//
//   READY(value, inputFingerprint)  { kind:'READY', value, inputFingerprint }
//   DEFERRED(cursor, reason)        { kind:'DEFERRED', cursor, reason }
//   UNKNOWN(reason, missingFields)  { kind:'UNKNOWN', reason, missingFields }
//   REJECTED(reasonCode, evidence)  { kind:'REJECTED', reasonCode, evidence }
//
// Results are plain JSON-safe objects (shallow frozen), so READY and UNKNOWN stay
// distinguishable after a JSON round-trip. A refusal is REJECTED, not an
// exception. Constructors validate cheap invariants; the READY value is checked
// only for undefined/function (deep JSON-safety of large values is checked by
// validateResult or the DTO validators, to keep CPU predictable).

const { checkJsonSafe, isPlainObject } = require('./canonical');
const { isFingerprint } = require('./fingerprint');
const { assertReasonCode, isReasonCode } = require('./reasonCodes');

const ResultKind = Object.freeze({
    READY: 'READY',
    DEFERRED: 'DEFERRED',
    UNKNOWN: 'UNKNOWN',
    REJECTED: 'REJECTED',
});

function assertJsonSafe(value, what) {
    const check = checkJsonSafe(value);
    if (!check.ok) throw new TypeError(what + ' is not JSON-safe: ' + check.code + ' at ' + check.path);
}

/**
 * @template T
 * @param {T} value JSON-safe value (null allowed, undefined not)
 * @param {string} inputFingerprint fingerprint of the inputs the value was computed from
 * @returns {{kind:'READY', value:T, inputFingerprint:string}}
 */
function READY(value, inputFingerprint) {
    if (value === undefined || typeof value === 'function') throw new TypeError('READY value must be JSON-safe (use null for none)');
    if (!isFingerprint(inputFingerprint)) throw new TypeError('READY inputFingerprint must be a fingerprint');
    return Object.freeze({ kind: ResultKind.READY, value: value, inputFingerprint: inputFingerprint });
}

/**
 * @param {*} cursor JSON-safe resume cursor or null
 * @param {string} reason ReasonCode
 */
function DEFERRED(cursor, reason) {
    if (cursor === undefined) cursor = null;
    assertJsonSafe(cursor, 'DEFERRED cursor');
    return Object.freeze({ kind: ResultKind.DEFERRED, cursor: cursor, reason: assertReasonCode(reason) });
}

/**
 * @param {string} reason ReasonCode
 * @param {string[]} [missingFields] field paths that were not observed; sorted, de-duplicated copy
 */
function UNKNOWN(reason, missingFields) {
    const list = missingFields === undefined ? [] : missingFields;
    if (!Array.isArray(list)) throw new TypeError('UNKNOWN missingFields must be an array of strings');
    const unique = [];
    for (let i = 0; i < list.length; i++) {
        if (typeof list[i] !== 'string' || list[i] === '') throw new TypeError('UNKNOWN missingFields must be non-empty strings');
        if (unique.indexOf(list[i]) === -1) unique.push(list[i]);
    }
    unique.sort();
    return Object.freeze({ kind: ResultKind.UNKNOWN, reason: assertReasonCode(reason), missingFields: Object.freeze(unique) });
}

/**
 * @param {string} reasonCode ReasonCode
 * @param {object|null} [evidence] plain JSON-safe values allowing the code to be checked
 */
function REJECTED(reasonCode, evidence) {
    const ev = evidence === undefined ? null : evidence;
    if (ev !== null && !isPlainObject(ev)) throw new TypeError('REJECTED evidence must be a plain object or null');
    assertJsonSafe(ev, 'REJECTED evidence');
    return Object.freeze({ kind: ResultKind.REJECTED, reasonCode: assertReasonCode(reasonCode), evidence: ev });
}

function isReady(result) { return !!result && result.kind === ResultKind.READY; }
function isDeferred(result) { return !!result && result.kind === ResultKind.DEFERRED; }
function isUnknown(result) { return !!result && result.kind === ResultKind.UNKNOWN; }
function isRejected(result) { return !!result && result.kind === ResultKind.REJECTED; }

/**
 * Structural validation of any Result (deep JSON-safety included).
 * @param {*} result
 * @returns {{ok:true} | {ok:false, errors:Array<{path:string, code:string}>}}
 */
function validateResult(result) {
    const errors = [];
    if (!isPlainObject(result)) {
        return { ok: false, errors: [{ path: '$', code: 'NOT_PLAIN_OBJECT' }] };
    }
    const safe = checkJsonSafe(result);
    if (!safe.ok) errors.push({ path: '$' + safe.path, code: safe.code });
    const keys = Object.keys(result).sort().join(',');
    switch (result.kind) {
        case ResultKind.READY:
            if (keys !== 'inputFingerprint,kind,value') errors.push({ path: '$', code: 'BAD_SHAPE' });
            if (!isFingerprint(result.inputFingerprint)) errors.push({ path: '$/inputFingerprint', code: 'BAD_FINGERPRINT' });
            break;
        case ResultKind.DEFERRED:
            if (keys !== 'cursor,kind,reason') errors.push({ path: '$', code: 'BAD_SHAPE' });
            if (!isReasonCode(result.reason)) errors.push({ path: '$/reason', code: 'BAD_REASON' });
            break;
        case ResultKind.UNKNOWN:
            if (keys !== 'kind,missingFields,reason') errors.push({ path: '$', code: 'BAD_SHAPE' });
            if (!isReasonCode(result.reason)) errors.push({ path: '$/reason', code: 'BAD_REASON' });
            if (!Array.isArray(result.missingFields)) errors.push({ path: '$/missingFields', code: 'NOT_ARRAY' });
            break;
        case ResultKind.REJECTED:
            if (keys !== 'evidence,kind,reasonCode') errors.push({ path: '$', code: 'BAD_SHAPE' });
            if (!isReasonCode(result.reasonCode)) errors.push({ path: '$/reasonCode', code: 'BAD_REASON' });
            if (result.evidence !== null && !isPlainObject(result.evidence)) errors.push({ path: '$/evidence', code: 'NOT_PLAIN_OBJECT' });
            break;
        default:
            errors.push({ path: '$/kind', code: 'BAD_KIND' });
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors: errors };
}

/**
 * @param {*} value
 * @returns {boolean}
 */
function isResult(value) {
    return isPlainObject(value) && Object.prototype.hasOwnProperty.call(ResultKind, value.kind);
}

module.exports = {
    ResultKind,
    READY,
    DEFERRED,
    UNKNOWN,
    REJECTED,
    isReady,
    isDeferred,
    isUnknown,
    isRejected,
    isResult,
    validateResult,
};
