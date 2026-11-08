const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeWorld, makePorts } = require('../unit/observation/readerSupport');
const { createReader } = require('../../../src/bot/observation/ScreepsReader');
const { exportFixture, validateFixture, evaluateExportRequest, serializeFixture, MAX_FIXTURE_CHARS } = require('../../../src/bot/telemetry/ReplayExporter');
const replay = require('../../../tools/replay');
const { sampleStateView, sampleNormalizedEvent } = require('../support/fixtures');
const { fingerprint } = require('../../../src/bot/domain/fingerprint');

function snap(time, opts) {
    const w = makeWorld(Object.assign({ time: time }, opts || {}));
    return createReader(makePorts(w)).capture(time, { rooms: 'ALL_VISIBLE', stage: 'FULL' }).value;
}

function build(extra) {
    const snapshots = [snap(5000, { hideCpu: true, gap: true }), snap(5001)];
    const probe = exportFixture(Object.assign({ snapshots: snapshots, stateView: sampleStateView(), events: [], buildId: 'b-0000000000000000', seed: 7 }, extra || {}));
    const expected = replay.runFixture(probe).reasonCodes;
    return exportFixture({ snapshots: snapshots, stateView: sampleStateView(), events: [sampleNormalizedEvent()], expectedReasonCodes: expected, buildId: 'b-0000000000000000', seed: 7, policyVersion: 'p1' });
}

function defineReplayTests(label) {
    test(label + ': export validates; JSON round-trip; runner reproduces result and reasons', function () {
        const fixture = build();
        assert.deepEqual(validateFixture(fixture), { ok: true });
        assert.equal(fixture.header.tickFrom, 5000);
        assert.equal(fixture.header.tickTo, 5001);
        assert.deepEqual(fixture.header.rooms, ['W1N1', 'W2N2']);
        assert.deepEqual(fixture.header.expectedReasonCodes, ['MISSING_FIELD']);
        const parsed = JSON.parse(serializeFixture(fixture));
        const a = replay.runFixture(parsed);
        const b = replay.runFixture(JSON.parse(JSON.stringify(fixture)));
        assert.equal(a.status, 'REPRODUCED', JSON.stringify(a));
        assert.deepEqual(a.reasonCodes, ['MISSING_FIELD']);
        assert.equal(a.outputFingerprint, b.outputFingerprint);
        const s0 = a.output.summary.snapshots[0];
        assert.equal(s0.energyByClass.CARGO, 70);
        assert.equal(s0.creeps.total, 4);
        assert.equal(s0.creeps.spawning, 1);
        assert.ok(s0.unknownFields.length > 0);
    });

    test(label + ': changed input is detected (fingerprint, and changed reasons after re-fingerprint)', function () {
        const fixture = JSON.parse(JSON.stringify(build()));
        const tampered = JSON.parse(JSON.stringify(fixture));
        tampered.body.snapshots[1].rooms.W1N1.energyAvailable.value = 1;
        const r = replay.runFixture(tampered);
        assert.equal(r.status, 'INVALID');
        assert.ok(r.errors.some(function (e) { return /FINGERPRINT_MISMATCH/.test(e.code); }), JSON.stringify(r.errors));
        // a consistent fixture whose expectation no longer matches the pipeline
        const wrong = JSON.parse(JSON.stringify(fixture));
        wrong.body.expectedReasonCodes = ['EVENT_GAP'];
        wrong.header.expectedReasonCodes = ['EVENT_GAP'];
        wrong.header.contentFingerprint = fingerprint(wrong.body);
        const m = replay.runFixture(wrong);
        assert.equal(m.status, 'MISMATCH');
        assert.equal(m.mismatches[0].field, 'reasonCodes');
        assert.deepEqual(m.mismatches[0].actual, ['MISSING_FIELD']);
    });

    test(label + ': gap between snapshot ticks yields EVENT_GAP, invisible room NO_VISIBILITY', function () {
        const gap = exportFixture({ snapshots: [snap(5000), snap(5003)], stateView: sampleStateView(), buildId: 'b-0000000000000000' });
        assert.ok(replay.runFixture(gap).reasonCodes.indexOf('EVENT_GAP') !== -1);
        const w = makeWorld({ time: 5000 });
        const s = createReader(makePorts(w)).capture(5000, { rooms: ['W1N1', 'W9N9'], stage: 'FULL' }).value;
        const fx = exportFixture({ snapshots: [s], stateView: sampleStateView(), buildId: 'b-0000000000000000' });
        assert.ok(replay.runFixture(fx).reasonCodes.indexOf('NO_VISIBILITY') !== -1);
    });

    test(label + ': pluggable pipeline registry (A5 hook), forecast comparison, nondeterminism detected', function () {
        const fixture = build();
        const name = 'test-plug-' + label;
        replay.registerPipeline({ name: name, compare: ['reasonCodes', 'forecast'], run: function (fx) { return { reasonCodes: ['MISSING_FIELD'], forecast: fx.body.expectedForecast }; } });
        assert.equal(replay.runFixture(fixture, { pipeline: name }).status, 'REPRODUCED');
        assert.ok(replay.listPipelines().indexOf(name) !== -1);
        assert.throws(function () { replay.registerPipeline({ name: name, run: function () { return {}; } }); });
        let n = 0;
        replay.registerPipeline({ name: name + '-flaky', run: function () { n++; return { reasonCodes: n % 2 ? ['MISSING_FIELD'] : [] }; } });
        const flaky = replay.runFixture(fixture, { pipeline: name + '-flaky' });
        assert.equal(flaky.status, 'MISMATCH');
        assert.equal(flaky.mismatches[0].field, 'determinism');
        // pipeline gets a frozen fixture: mutation attempts throw in strict code
        replay.registerPipeline({ name: name + '-mut', run: function (fx) { 'use strict'; fx.body.events.push(1); return { reasonCodes: [] }; } });
        assert.throws(function () { replay.runFixture(fixture, { pipeline: name + '-mut' }); }, TypeError);
        assert.equal(replay.runFixture(fixture, { pipeline: 'nope' }).status, 'INVALID');
    });

    test(label + ': CLI main reads a file and returns exit codes', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
        const file = path.join(dir, 'f.json');
        fs.writeFileSync(file, serializeFixture(build()));
        const chunks = [];
        const orig = process.stdout.write;
        process.stdout.write = function (c) { chunks.push(String(c)); return true; };
        let code;
        try { code = replay.main([file]); } finally { process.stdout.write = orig; }
        assert.equal(code, 0);
        assert.equal(JSON.parse(chunks.join('')).status, 'REPRODUCED');
        const bad = JSON.parse(fs.readFileSync(file, 'utf8'));
        bad.body.snapshots[0].tick = 1;
        fs.writeFileSync(file, JSON.stringify(bad));
        process.stdout.write = function () { return true; };
        try { code = replay.main([file]); } finally { process.stdout.write = orig; }
        assert.equal(code, 2);
        fs.rmSync(dir, { recursive: true });
    });

    test(label + ': export is bounded, rejects credentials and foreign Memory, explicit trigger only', function () {
        const base = { snapshots: [snap(5000)], stateView: sampleStateView(), buildId: 'b-0000000000000000' };
        const fixture = exportFixture(base);
        const withToken = JSON.parse(JSON.stringify(fixture));
        withToken.body.state.control.rooms.W5N8.apiToken = 'x';
        assert.equal(validateFixture(withToken).ok, false);
        const foreign = JSON.parse(JSON.stringify(fixture));
        foreign.body.state.creeps = { h1: {} };
        foreign.header.contentFingerprint = fingerprint(foreign.body);
        assert.equal(validateFixture(foreign).ok, false, 'foreign Memory key is UNKNOWN_FIELD');
        const many = [];
        for (let i = 0; i < 60; i++) many.push(snap(5000 + i));
        assert.throws(function () { exportFixture({ snapshots: many, stateView: sampleStateView(), buildId: 'b-0000000000000000' }); }, RangeError);
        const big = JSON.parse(JSON.stringify(fixture));
        big.body.snapshots[0].rooms.W1N1.eventLog.entries[0].data = { pad: 'x'.repeat(MAX_FIXTURE_CHARS) };
        assert.throws(function () { serializeFixture(big); }, TypeError);
        assert.equal(evaluateExportRequest(undefined, 10).export, false);
        assert.equal(evaluateExportRequest({ requested: 'yes' }, 10).export, false);
        assert.deepEqual(evaluateExportRequest({ requested: true, ticks: 9999 }, 10), { export: true, ticks: 50, reason: 'REQUESTED' });
        assert.equal(evaluateExportRequest({ requested: true, tickFrom: 20 }, 10).export, false);
    });
}

module.exports = { defineReplayTests };
