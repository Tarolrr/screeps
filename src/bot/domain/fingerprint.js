// Deterministic pure-JS fingerprint: 64-bit FNV-1a over the UTF-8 bytes of the
// canonical JSON text. No Node crypto, no typed arrays, no BigInt (portable to
// the Screeps runtime). The 64-bit state is kept as four 16-bit limbs.
//
// Collision posture: FNV-1a 64 is NOT cryptographic. It detects accidental
// change of inputs (cache keys, "input changed" checks, artifact identity in
// replay fixtures). Birthday bound ~2^32 values for a 50% collision; for the
// sets we compare (hundreds to thousands of records) the probability is
// negligible, but an adversary can construct collisions. Therefore a fingerprint
// is never the only proof of identity for money or creep ownership: full keys
// (operationKey, eventKey) are stored and compared where safety depends on it.

const { canonicalJson } = require('./canonical');
const { FINGERPRINT_ALGORITHM } = require('./version');

const PRIME_LOW = 0x1b3; // FNV 64 prime = 2^40 + 0x1b3

function hex4(n) {
    const s = n.toString(16);
    return '0000'.slice(s.length) + s;
}

/**
 * FNV-1a 64 of the UTF-8 encoding of a JS string.
 * Lone surrogates are encoded as U+FFFD (same as TextEncoder).
 * @param {string} text
 * @returns {string} 16 lower-case hex characters
 */
function fnv1a64Hex(text) {
    let h0 = 0x2325, h1 = 0x8422, h2 = 0x9ce4, h3 = 0xcbf2;

    function feed(b) {
        h0 ^= b;
        let t0 = h0 * PRIME_LOW;
        let t1 = h1 * PRIME_LOW;
        let t2 = h2 * PRIME_LOW + (h0 << 8);
        let t3 = h3 * PRIME_LOW + (h1 << 8);
        t1 += t0 >>> 16;
        t2 += t1 >>> 16;
        t3 += t2 >>> 16;
        h0 = t0 & 0xffff;
        h1 = t1 & 0xffff;
        h2 = t2 & 0xffff;
        h3 = t3 & 0xffff;
    }

    const length = text.length;
    for (let i = 0; i < length; i++) {
        let code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
                i++;
            } else {
                code = 0xfffd;
            }
        } else if (code >= 0xd800 && code <= 0xdfff) {
            code = 0xfffd;
        }
        if (code < 0x80) {
            feed(code);
        } else if (code < 0x800) {
            feed(0xc0 | (code >> 6));
            feed(0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
            feed(0xe0 | (code >> 12));
            feed(0x80 | ((code >> 6) & 0x3f));
            feed(0x80 | (code & 0x3f));
        } else {
            feed(0xf0 | (code >> 18));
            feed(0x80 | ((code >> 12) & 0x3f));
            feed(0x80 | ((code >> 6) & 0x3f));
            feed(0x80 | (code & 0x3f));
        }
    }
    return hex4(h3) + hex4(h2) + hex4(h1) + hex4(h0);
}

/**
 * Fingerprint of a plain JSON-safe value: 'fnv1a64:' + 16 hex chars of the
 * canonical JSON text. Stable under object key permutation.
 * @param {*} value
 * @returns {string}
 * @throws {import('./canonical').CanonicalError} for non JSON-safe input
 */
function fingerprint(value) {
    return FINGERPRINT_ALGORITHM + ':' + fnv1a64Hex(canonicalJson(value));
}

/**
 * Fingerprint of an already canonical (or arbitrary) text.
 * @param {string} text
 * @returns {string}
 */
function fingerprintText(text) {
    if (typeof text !== 'string') throw new TypeError('fingerprintText expects a string');
    return FINGERPRINT_ALGORITHM + ':' + fnv1a64Hex(text);
}

const FINGERPRINT_PATTERN = /^fnv1a64:[0-9a-f]{16}$/;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isFingerprint(value) {
    return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}

module.exports = {
    fnv1a64Hex,
    fingerprint,
    fingerprintText,
    isFingerprint,
    FINGERPRINT_PATTERN,
};
