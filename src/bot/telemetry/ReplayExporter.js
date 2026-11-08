// ReplayExporter (A1, contract A.2 §4.6, §10): pure construction/validation of a
// ReplayFixture {header, body} from values. No Game/Memory access and no I/O: the
// caller decides where the JSON goes (an explicit, bounded export; see REPLAY.md).
//
// A fixture contains only: Snapshot DTOs, selected StateView fields (revision,
// control, shadow eventCursor/flowWindows), normalized events, expected reason
// codes/forecast. Everything else is rejected by the DTO schema (UNKNOWN_FIELD), and
// validateFixture additionally rejects credential-like keys.

const { validateReplayFixture, validateSnapshot } = require('../domain/dtos');
const { fingerprint } = require('../domain/fingerprint');
const { canonicalJson, canonicalClone } = require('../domain/canonical');
const { CONTRACT_VERSION, SCHEMA_VERSION } = require('../domain/version');

/** Upper bound of a serialized fixture (canonical JSON, UTF-16 units). */
const MAX_FIXTURE_CHARS = 262144;
const MAX_SNAPSHOTS = 50;
const CREDENTIAL_KEY = /pass(word)?|token|secret|credential|api[-_]?key|authorization|cookie/i;

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function eventOrder(a, b) {
    return cmp(a.effectTick, b.effectTick) || cmp(a.roomName, b.roomName) || cmp(a.originalArrayIndex, b.originalArrayIndex);
}

function credentialKeys(value, path, out) {
    if (value === null || typeof value !== 'object') return;
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
        const p = path + '/' + keys[i];
        if (!Array.isArray(value) && CREDENTIAL_KEY.test(keys[i])) out.push({ path: p, code: 'CREDENTIAL_LIKE_KEY' });
        credentialKeys(value[keys[i]], p, out);
    }
}

/**
 * Build a fixture. Throws TypeError (with .errors) when the result is invalid and
 * RangeError('FIXTURE_TOO_LARGE') when it exceeds MAX_FIXTURE_CHARS / MAX_SNAPSHOTS.
 * @param {{snapshots: object[], stateView: object, events?: object[], expectedReasonCodes?: string[], expectedForecast?: object,
 *          buildId: string, policyVersion?: (string|null), seed?: (number|null), schemaVersion?: number}} input
 * @returns {import('../domain/types').ReplayFixture}
 */
function exportFixture(input) {
    if (!input || !Array.isArray(input.snapshots)) throw new TypeError('exportFixture: snapshots required');
    if (input.snapshots.length > MAX_SNAPSHOTS) throw new RangeError('FIXTURE_TOO_LARGE');
    const snapshots = canonicalClone(input.snapshots).sort(function (a, b) { return cmp(a.tick, b.tick); });
    const view = input.stateView;
    if (!view || !view.strategy) throw new TypeError('exportFixture: stateView required');

    const shadowRooms = {};
    const shadowIn = view.shadow && view.shadow.rooms ? view.shadow.rooms : {};
    const names = Object.keys(shadowIn).sort();
    for (let i = 0; i < names.length; i++) {
        const r = shadowIn[names[i]];
        shadowRooms[names[i]] = { eventCursor: r.eventCursor === undefined ? null : r.eventCursor, flowWindows: r.flowWindows || [] };
    }
    const reasonCodes = (input.expectedReasonCodes || []).slice().sort().filter(function (c, i, a) { return i === 0 || a[i - 1] !== c; });
    const roomSet = {};
    for (let i = 0; i < snapshots.length; i++) for (const n in snapshots[i].rooms) roomSet[n] = true;

    const body = canonicalClone({
        snapshots: snapshots,
        state: { revision: view.strategy.revision, control: { rooms: view.strategy.control.rooms }, shadowRooms: shadowRooms },
        events: (input.events || []).slice().sort(eventOrder),
        expectedReasonCodes: reasonCodes,
        expectedForecast: input.expectedForecast || {},
    });
    const header = {
        fixtureType: 'ReplayFixture', fixtureVersion: 1, contractVersion: CONTRACT_VERSION, buildId: input.buildId,
        schemaVersion: input.schemaVersion === undefined ? SCHEMA_VERSION : input.schemaVersion,
        policyVersion: input.policyVersion === undefined ? null : input.policyVersion,
        seed: input.seed === undefined ? null : input.seed,
        tickFrom: snapshots.length ? snapshots[0].tick : 0, tickTo: snapshots.length ? snapshots[snapshots.length - 1].tick : 0,
        rooms: Object.keys(roomSet).sort(), contentFingerprint: fingerprint(body), expectedReasonCodes: reasonCodes,
    };
    const fixture = { header: header, body: body };
    const check = validateFixture(fixture);
    if (!check.ok) {
        const error = new TypeError('exportFixture: invalid fixture ' + JSON.stringify(check.errors.slice(0, 3)));
        error.errors = check.errors;
        throw error;
    }
    return fixture;
}

/**
 * Domain validateReplayFixture plus: size bound, snapshot fingerprints, no credential-like keys.
 * @param {*} fixture
 * @returns {{ok: true} | {ok: false, errors: Array<{path: string, code: string}>}}
 */
function validateFixture(fixture) {
    const base = validateReplayFixture(fixture);
    if (!base.ok) return base;
    const errors = [];
    const snaps = fixture.body.snapshots;
    for (let i = 0; i < snaps.length; i++) {
        const r = validateSnapshot(snaps[i], { checkFingerprint: true });
        if (!r.ok) errors.push({ path: 'body/snapshots/' + i + r.errors[0].path.replace(/^\$/, ''), code: r.errors[0].code });
    }
    if (snaps.length > MAX_SNAPSHOTS) errors.push({ path: 'body/snapshots', code: 'TOO_MANY_SNAPSHOTS' });
    credentialKeys(fixture, '', errors);
    if (canonicalJson(fixture).length > MAX_FIXTURE_CHARS) errors.push({ path: '', code: 'FIXTURE_TOO_LARGE' });
    return errors.length ? { ok: false, errors: errors.slice(0, 20) } : { ok: true };
}

/**
 * Explicit export trigger: `request` is the operator flag value read by the
 * composition (planned location: Memory.strategyShadow.exportRequest; not yet in the
 * contract, see REPLAY.md). Pure decision, bounded window.
 * @param {*} request {requested: true, tickFrom?: int, ticks?: 1..MAX_SNAPSHOTS}
 * @param {number} tick current tick
 * @returns {{export: boolean, ticks: number, reason: string}}
 */
function evaluateExportRequest(request, tick) {
    if (!request || request.requested !== true) return { export: false, ticks: 0, reason: 'NOT_REQUESTED' };
    const from = Number.isInteger(request.tickFrom) ? request.tickFrom : tick;
    const ticks = Number.isInteger(request.ticks) && request.ticks >= 1 ? Math.min(request.ticks, MAX_SNAPSHOTS) : 1;
    if (tick < from) return { export: false, ticks: ticks, reason: 'NOT_YET' };
    return { export: true, ticks: ticks, reason: 'REQUESTED' };
}

/**
 * Bounded serialization for writing a fixture to a local artifact.
 * @param {object} fixture
 * @returns {string} canonical JSON
 */
function serializeFixture(fixture) {
    const check = validateFixture(fixture);
    if (!check.ok) { const e = new TypeError('serializeFixture: invalid fixture'); e.errors = check.errors; throw e; }
    return canonicalJson(fixture);
}

module.exports = { MAX_FIXTURE_CHARS, MAX_SNAPSHOTS, exportFixture, validateFixture, evaluateExportRequest, serializeFixture };
