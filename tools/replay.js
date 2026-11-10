#!/usr/bin/env node
// Replay runner (A1): node tools/replay.js [--pipeline <name>] [--require <module>] <fixture.json>
//
// Loads a ReplayFixture, validates it (contract A.2 §4.6), runs a PURE pipeline over a
// deep-frozen copy (twice, to prove determinism) and compares reason codes (and, when the
// pipeline declares it, the forecast) with the fixture expectation.
// Exit codes: 0 reproduced, 1 mismatch, 2 invalid fixture/usage.
//
// Pipelines are registered by name (registerPipeline). 'snapshot-summary' summarizes
// snapshots; 'shadow-a5' (STRAT-A5) replays the shadow pipeline and is the default for
// fixtures with policyVersion 'shadow-a5.*'. --extract pulls the exported fixture out of
// a Memory JSON dump (Memory.strategyShadow.replayExport, docs/strategy/SHADOW-A.md).

'use strict';

const fs = require('fs');
const path = require('path');
const { validateFixture } = require('../src/bot/telemetry/ReplayExporter');
const { deepFreeze } = require('../src/bot/domain/freeze');
const { canonicalJson, canonicalClone } = require('../src/bot/domain/canonical');
const { fingerprint } = require('../src/bot/domain/fingerprint');

const pipelines = Object.create(null);

/**
 * @param {{name: string, run: function(object): {reasonCodes: string[], summary?: object, forecast?: object}, compare?: string[]}} spec
 *   run(fixture) is pure: it gets a deep-frozen fixture and returns reason codes (and
 *   optionally forecast: {[room]: ForecastSummary}). compare lists what is checked against
 *   the fixture: 'reasonCodes' (default) and/or 'forecast'.
 */
function registerPipeline(spec) {
    if (!spec || typeof spec.name !== 'string' || typeof spec.run !== 'function') throw new TypeError('registerPipeline needs {name, run}');
    if (pipelines[spec.name]) throw new Error('pipeline already registered: ' + spec.name);
    pipelines[spec.name] = Object.freeze({ name: spec.name, run: spec.run, compare: Object.freeze((spec.compare || ['reasonCodes']).slice()) });
}

function listPipelines() { return Object.keys(pipelines).sort(); }

function sortedUnique(list) {
    return list.slice().sort().filter(function (c, i, a) { return i === 0 || a[i - 1] !== c; });
}

/**
 * Default pipeline: energy by node class, creep counts, unknown fields, reason codes
 * derived only from the snapshots (MISSING_FIELD, NO_VISIBILITY, EVENT_GAP).
 */
function snapshotSummary(fixture) {
    const snaps = fixture.body.snapshots;
    const codes = [];
    const perTick = [];
    for (let i = 0; i < snaps.length; i++) {
        const s = snaps[i];
        const energyByClass = {};
        const unknownNodes = {};
        let hostiles = 0;
        const roomEntries = [];
        for (const name of Object.keys(s.rooms).sort()) {
            const room = s.rooms[name];
            if (room.visibility === 'NOT_VISIBLE') codes.push('NO_VISIBILITY');
            else if (room.eventLog.status !== 'CAPTURED') codes.push('EVENT_GAP');
            hostiles += room.hostiles.length;
            for (const node of room.energyNodes) {
                if (node.amount.value === null) unknownNodes[node.nodeClass] = (unknownNodes[node.nodeClass] || 0) + 1;
                else energyByClass[node.nodeClass] = (energyByClass[node.nodeClass] || 0) + node.amount.value;
            }
            roomEntries.push(name);
        }
        const creepNames = Object.keys(s.ownCreeps);
        let spawning = 0;
        for (const n of creepNames) if (s.ownCreeps[n].spawning) spawning++;
        if (s.missingFields.length > 0) codes.push('MISSING_FIELD');
        if (i > 0 && s.tick !== snaps[i - 1].tick + 1) codes.push('EVENT_GAP');
        perTick.push({
            tick: s.tick, rooms: roomEntries, energyByClass: energyByClass, unknownEnergyNodes: unknownNodes,
            creeps: { total: creepNames.length, spawning: spawning }, hostiles: hostiles, unknownFields: s.missingFields.slice(),
        });
    }
    return { reasonCodes: sortedUnique(codes), summary: { snapshots: perTick }, forecast: {} };
}

registerPipeline({ name: 'snapshot-summary', run: snapshotSummary, compare: ['reasonCodes'] });

// STRAT-A5 shadow pipeline (src/bot/integration/ShadowAdapter.js): re-runs RECONCILE..CLOSE
// over snapshots[1..n] from the state captured after CLOSE of snapshots[0] and compares
// the union of reason codes and the forecast of the last tick.
const SHADOW_PIPELINE = 'shadow-a5';
registerPipeline({
    name: SHADOW_PIPELINE,
    compare: ['reasonCodes', 'forecast'],
    run: function (fixture) { return require('../src/bot/integration/ShadowAdapter').replayShadowFixture(fixture); },
});

/** Default pipeline of a fixture: shadow fixtures carry policyVersion 'shadow-a5.*'. */
function defaultPipelineOf(fixtureJson) {
    const policy = fixtureJson && fixtureJson.header ? fixtureJson.header.policyVersion : null;
    return typeof policy === 'string' && policy.indexOf(SHADOW_PIPELINE + '.') === 0 ? SHADOW_PIPELINE : 'snapshot-summary';
}

/**
 * Extract the exported fixture from a Memory JSON dump (whole Memory, or only
 * Memory.strategyShadow). Returns {fixture} or {error}.
 * @param {*} memoryJson parsed dump
 */
function extractFixtureFromMemory(memoryJson) {
    if (!memoryJson || typeof memoryJson !== 'object') return { error: 'NOT_AN_OBJECT' };
    const shadow = memoryJson.strategyShadow && typeof memoryJson.strategyShadow === 'object' ? memoryJson.strategyShadow : memoryJson;
    const exp = shadow.replayExport;
    if (!exp || typeof exp !== 'object') return { error: 'NO_REPLAY_EXPORT' };
    if (exp.status !== 'READY' || !exp.fixture) return { error: 'EXPORT_NOT_READY', status: exp.status || null, reasonCode: exp.reasonCode || null, detail: exp.detail || null };
    return { fixture: exp.fixture };
}

/**
 * @param {*} fixtureJson parsed JSON
 * @param {{pipeline?: string}} [options]
 * @returns {{status: 'REPRODUCED'|'MISMATCH'|'INVALID', pipeline: string, errors: Array, mismatches: Array<{field: string, expected: *, actual: *}>, reasonCodes: string[], outputFingerprint: (string|null), output: (object|null)}}
 */
function runFixture(fixtureJson, options) {
    const name = options && options.pipeline ? options.pipeline : defaultPipelineOf(fixtureJson);
    const result = { status: 'INVALID', pipeline: name, errors: [], mismatches: [], reasonCodes: [], outputFingerprint: null, output: null };
    const pipeline = pipelines[name];
    if (!pipeline) { result.errors.push({ path: 'pipeline', code: 'UNKNOWN_PIPELINE' }); return result; }
    const check = validateFixture(fixtureJson);
    if (!check.ok) { result.errors = check.errors; return result; }

    const frozen = deepFreeze(canonicalClone(fixtureJson));
    const first = canonicalClone(pipeline.run(frozen));
    const second = canonicalClone(pipeline.run(deepFreeze(canonicalClone(fixtureJson))));
    if (canonicalJson(first) !== canonicalJson(second)) {
        result.status = 'MISMATCH';
        result.mismatches.push({ field: 'determinism', expected: 'identical output on rerun', actual: 'outputs differ' });
        return result;
    }
    result.output = first;
    result.outputFingerprint = fingerprint(first);
    result.reasonCodes = sortedUnique(first.reasonCodes || []);
    for (const field of pipeline.compare) {
        const expected = field === 'forecast' ? frozen.body.expectedForecast : frozen.body.expectedReasonCodes;
        const actual = field === 'forecast' ? (first.forecast || {}) : result.reasonCodes;
        if (canonicalJson(expected) !== canonicalJson(actual)) result.mismatches.push({ field: field, expected: expected, actual: actual });
    }
    result.status = result.mismatches.length ? 'MISMATCH' : 'REPRODUCED';
    return result;
}

const USAGE = 'usage: node tools/replay.js [--pipeline <name>] [--require <module>] <fixture.json>\n' +
    '       node tools/replay.js --extract <memory-dump.json> [--out <fixture.json>]   (Memory or Memory.strategyShadow dump)\n';

function main(argv) {
    let pipeline = null;
    let file = null;
    let extract = null;
    let out = null;
    const args = argv.slice();
    while (args.length) {
        const a = args.shift();
        if (a === '--pipeline') pipeline = args.shift();
        else if (a === '--require') require(path.resolve(process.cwd(), args.shift()));
        else if (a === '--extract') extract = args.shift();
        else if (a === '--out') out = args.shift();
        else file = a;
    }
    if (extract) {
        let dump;
        try { dump = JSON.parse(fs.readFileSync(extract, 'utf8')); } catch (error) { process.stderr.write('cannot read memory dump: ' + error.message + '\n'); return 2; }
        const got = extractFixtureFromMemory(dump);
        if (!got.fixture) { process.stdout.write(canonicalJson({ status: 'NO_FIXTURE', error: got.error, exportStatus: got.status || null, reasonCode: got.reasonCode || null, detail: got.detail || null }) + '\n'); return 2; }
        const text = canonicalJson(got.fixture) + '\n';
        if (out) fs.writeFileSync(out, text);
        else process.stdout.write(text);
        if (!file) return 0;
    }
    if (!file) { process.stderr.write(USAGE); return 2; }
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { process.stderr.write('cannot read fixture: ' + error.message + '\n'); return 2; }
    const result = runFixture(json, { pipeline: pipeline || defaultPipelineOf(json) });
    process.stdout.write(canonicalJson({ status: result.status, pipeline: result.pipeline, reasonCodes: result.reasonCodes, outputFingerprint: result.outputFingerprint, mismatches: result.mismatches, errors: result.errors }) + '\n');
    return result.status === 'REPRODUCED' ? 0 : result.status === 'MISMATCH' ? 1 : 2;
}

module.exports = { registerPipeline, listPipelines, runFixture, snapshotSummary, defaultPipelineOf, extractFixtureFromMemory, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
