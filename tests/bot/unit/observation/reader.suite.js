const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, makePorts, TrapViolation } = require('./readerSupport');
const { createReader } = require('../../../../src/bot/observation/ScreepsReader');
const { buildSnapshot, classifyEnergyNodes } = require('../../../../src/bot/observation/WorldSnapshotBuilder');
const { validateSnapshot, snapshotFingerprint } = require('../../../../src/bot/domain/dtos');
const { canonicalJson } = require('../../../../src/bot/domain/canonical');
const { createWorkBudget, createScopedBudget } = require('../../../../src/bot/app/WorkBudget');

const SCOPE = { rooms: 'ALL_VISIBLE', stage: 'FULL' };

function capture(world, budget, extra) {
    const ports = makePorts(world, extra);
    return createReader(ports).capture(world.Game.time, SCOPE, budget);
}

function ready(world, budget, extra) {
    const r = capture(world, budget, extra);
    assert.equal(r.kind, 'READY', JSON.stringify(r));
    return r.value;
}

function defineReaderTests(label) {
    test(label + ': snapshot validates, is deep-frozen and covers the world', function () {
        const w = makeWorld();
        const s = ready(w);
        assert.deepEqual(validateSnapshot(s, { checkFingerprint: true }), { ok: true });
        assert.ok(Object.isFrozen(s) && Object.isFrozen(s.rooms.W1N1) && Object.isFrozen(s.rooms.W1N1.energyNodes[0]) && Object.isFrozen(s.rooms.W1N1.eventLog.entries));
        const room = s.rooms.W1N1;
        assert.equal(room.controller.level, 3);
        assert.deepEqual(room.controller.safeModeTicks, { value: 0, quality: 'OBSERVED', reason: null }, 'safeMode undefined = inactive');
        assert.equal(room.spawns[0].spawning.remainingTime, 4);
        assert.deepEqual(room.sources.map(function (x) { return x.id; }), ['src0', 'src1']);
        assert.equal(room.sources[0].ticksToRegeneration.value, null);
        assert.equal(room.hostiles[0].body[0].type, 'attack');
        assert.equal(room.constructionSites[0].id, 'site1');
        assert.deepEqual(room.energyNodes.map(function (n) { return n.nodeId; }),
            ['cont1', 'creep:h1', 'creep:h2', 'drop1', 'ext1', 'ext2', 'ruin1', 'spawn1id', 'stor1', 'tomb1']);
        const classes = {};
        room.energyNodes.forEach(function (n) { classes[n.nodeClass] = (classes[n.nodeClass] || 0) + 1; });
        assert.deepEqual(classes, { CARGO: 2, PILE: 3, SPAWN_EXTENSION: 3, STORAGE_CONTAINER: 2 });
        assert.deepEqual(s.rooms.W2N2.energyNodes.map(function (n) { return n.nodeId; }), ['creep:far', 'remote:W2N2:src2']);
        assert.equal(s.ownCreeps.h1.body[1].boost, 'KH');
        assert.equal(s.ownCreeps.h3.spawning, true);
        assert.equal(s.ownCreeps.h3.ticksToLive.quality, 'UNKNOWN');
        assert.equal(s.ownCreeps.h1.legacyRole, 'harvester', 'role via read-only creepMemory port (A.3), creep.memory getter never read');
        assert.equal(s.shard, 'shard0');
    });

    test(label + ': event log is captured raw with original indices', function () {
        const s = ready(makeWorld());
        const log = s.rooms.W1N1.eventLog;
        assert.equal(log.status, 'CAPTURED');
        assert.equal(log.effectTick, 4999);
        assert.equal(log.rawLength, 3);
        assert.deepEqual(log.entries.map(function (e) { return [e.originalArrayIndex, e.event, e.objectId]; }), [[0, 5, 'c1'], [1, 1, 'hs1'], [2, 9, null]]);
        assert.equal(s.rooms.W2N2.eventLog.status, 'CAPTURED');
        assert.equal(s.rooms.W2N2.eventLog.rawLength, 0);
    });

    test(label + ': permutation of Game objects gives byte-identical canonical snapshot and fingerprint', function () {
        const a = ready(makeWorld());
        const b = ready(makeWorld({ permute: true }));
        assert.equal(canonicalJson(a), canonicalJson(b));
        assert.equal(a.fingerprint, b.fingerprint);
        assert.equal(canonicalJson(a), canonicalJson(ready(makeWorld())), 'same Game twice');
    });

    test(label + ': fingerprint ignores cpu, changes with the world', function () {
        const a = ready(makeWorld());
        const b = ready(makeWorld({ hideCpu: true }));
        assert.equal(a.fingerprint, b.fingerprint);
        assert.equal(b.cpu.used.quality, 'UNKNOWN');
        assert.equal(b.cpu.bucket.quality, 'UNKNOWN');
        const c = ready(makeWorld({ time: 5001 }));
        assert.notEqual(a.fingerprint, c.fingerprint);
    });

    test(label + ': JSON round-trip keeps UNKNOWN, no prototypes or Game references', function () {
        const s = ready(makeWorld({ hideCpu: true }));
        const copy = JSON.parse(JSON.stringify(s));
        assert.deepEqual(copy, s);
        assert.deepEqual(copy.cpu.used, { value: null, quality: 'UNKNOWN', reason: 'MISSING_FIELD' });
        assert.equal(copy.rooms.W1N1.sources[0].ticksToRegeneration.value, null);
        assert.deepEqual(validateSnapshot(copy, { checkFingerprint: true }), { ok: true });
        (function walk(v) {
            if (v && typeof v === 'object') {
                const p = Object.getPrototypeOf(v);
                assert.ok(p === Object.prototype || p === Array.prototype, 'plain only');
                Object.keys(v).forEach(function (k) { walk(v[k]); });
            }
        })(s);
    });

    test(label + ': trap: reading never mutates, calls mutators, writes Memory or touches creep.memory', function () {
        const w = makeWorld();
        ready(w, undefined, { creepMemory: true });
        assert.deepEqual(w.journal.violations, []);
        assert.deepEqual(w.violations, []);
        assert.deepEqual(w.memory.journal.writes, []);
        assert.equal(w.memory.serialize(), JSON.stringify({ creeps: { h1: { role: 'harvester', home: 'W1N1' } }, rooms: {} }), 'no Memory.creeps entry auto-created');
        assert.equal(w.memory.raw.creeps.h3, undefined);
    });

    test(label + ': trap self-check: the creep.memory getter and mutating calls would be caught', function () {
        const w = makeWorld();
        assert.throws(function () { return w.Game.creeps.h3.memory; }, TrapViolation);
        assert.throws(function () { w.Game.creeps.h1.moveTo(1, 1); }, TrapViolation);
        assert.throws(function () { w.Game.rooms.W1N1.createConstructionSite(1, 1, 'road'); }, TrapViolation);
        assert.throws(function () { w.Game.creeps.h1.ticksToLive = 5; }, TrapViolation);
        assert.throws(function () { Object.defineProperty(w.Game.rooms.W1N1, 'x', { value: 1 }); }, TrapViolation);
    });

    test(label + ': legacy role is read through the port hook as an observation only', function () {
        const w = makeWorld();
        const s = ready(w, undefined, { creepMemory: true });
        assert.equal(s.ownCreeps.h1.legacyRole, 'harvester');
        assert.equal(s.ownCreeps.h2.legacyRole, null);
        assert.equal(s.ownCreeps.h1.strategyEnvelope, null);
    });

    test(label + ': invisible requested room is NOT_VISIBLE, not an empty room', function () {
        const w = makeWorld();
        const r = createReader(makePorts(w)).capture(5000, { rooms: ['W1N1', 'W9N9'], stage: 'FULL' }, undefined);
        assert.equal(r.kind, 'READY');
        const room = r.value.rooms.W9N9;
        assert.equal(room.visibility, 'NOT_VISIBLE');
        assert.equal(room.eventLog.status, 'NOT_VISIBLE');
        assert.equal(room.energyAvailable.quality, 'UNKNOWN');
        assert.equal(room.energyAvailable.reason, 'NO_VISIBILITY');
        assert.deepEqual(room.energyNodes, []);
    });

    test(label + ': budget admit before creeps and each room; deferral is DEFERRED with cursor naming deferred rooms', function () {
        const w = makeWorld();
        const asked = [];
        const budget = { admit: function (block) { asked.push(block.name); return asked.length >= 3 ? { kind: 'DEFERRED', cursor: block.cursor, reason: 'BUDGET_DEFERRED' } : { kind: 'READY', value: {}, inputFingerprint: 'fnv1a64:0000000000000000' }; } };
        const r = capture(w, budget);
        assert.deepEqual(asked, ['observe.creeps', 'observe.room.W1N1', 'observe.room.W2N2']);
        assert.equal(r.kind, 'DEFERRED');
        assert.equal(r.reason, 'BUDGET_DEFERRED');
        assert.deepEqual(r.cursor, { tick: 5000, deferredRooms: ['W2N2'], capturedRooms: ['W1N1'], block: 'room' });
        const unk = capture(makeWorld(), { admit: function () { return { kind: 'UNKNOWN', reason: 'MISSING_FIELD', missingFields: ['cpu.used'] }; } });
        assert.equal(unk.kind, 'UNKNOWN');
    });

    test(label + ': real WorkBudget: low bucket defers, unknown CPU is UNKNOWN, healthy CPU is READY', function () {
        const mk = function (cpu) { const w = makeWorld(); Object.assign(w.Game.cpu, cpu); return w; };
        const wLow = makeWorld();
        const lowPorts = makePorts(wLow);
        const fakeCpu = function (reading) { return { read: function () { return Object.assign({ missingFields: [] }, reading); } }; };
        const base = createWorkBudget(fakeCpu({ used: 1, limit: 20, tickLimit: 500, bucket: 10 }));
        const r = createReader(lowPorts).capture(5000, SCOPE, createScopedBudget(base, fakeCpu({ used: 1, limit: 20, tickLimit: 500, bucket: 10 }), 3));
        assert.equal(r.kind, 'DEFERRED');
        assert.ok(r.cursor.deferredRooms.length === 2);
        const okBase = createWorkBudget(fakeCpu({ used: 1, limit: 20, tickLimit: 500, bucket: 10000 }));
        const ok = createReader(makePorts(mk({}))).capture(5000, SCOPE, createScopedBudget(okBase, fakeCpu({ used: 1, limit: 20, tickLimit: 500, bucket: 10000 }), 3));
        assert.equal(ok.kind, 'READY');
        const unknownBase = createWorkBudget(fakeCpu({ used: null, limit: 20, tickLimit: 500, bucket: 10000, missingFields: ['cpu.used'] }));
        const u = createReader(makePorts(mk({}))).capture(5000, SCOPE, unknownBase);
        assert.equal(u.kind, 'UNKNOWN');
    });

    test(label + ': stale tick, bad scope and unavailable events are explicit', function () {
        const w = makeWorld();
        const reader = createReader(makePorts(w));
        assert.equal(reader.capture(4999, SCOPE).kind, 'REJECTED');
        assert.equal(reader.capture(5000, { rooms: 'ALL_VISIBLE', stage: 'CRITICAL' }).kind, 'REJECTED');
        assert.equal(reader.capture(5000, { rooms: 'x', stage: 'FULL' }).kind, 'REJECTED');
        const s = ready(makeWorld({ noEventLog: 'W2N2' }));
        assert.equal(s.rooms.W2N2.eventLog.status, 'UNAVAILABLE');
    });

    test(label + ': engine-defined absence is not listed in missingFields; genuine gaps are', function () {
        const s = ready(makeWorld());
        assert.deepEqual(s.missingFields, [], 'no genuine gaps in the healthy fake world');
        const foreign = s.rooms.W2N2;
        assert.equal(foreign.controller.ticksToDowngrade.quality, 'UNKNOWN');
        assert.equal(foreign.controller.progress.quality, 'UNKNOWN');
        assert.equal(foreign.energyAvailable.quality, 'UNKNOWN');
        assert.equal(s.rooms.W1N1.sources[0].ticksToRegeneration.quality, 'UNKNOWN');
        const gap = ready(makeWorld({ gap: true }));
        assert.deepEqual(gap.missingFields, ['rooms.W1N1.sources.src0.energy', 'rooms.W1N1.sources.src0.ticksToRegeneration']);
    });

    test(label + ': no silent zero defaults: invalid ints are listed, a missing remainingTime never looks finished', function () {
        const base = {
            tick: 10, shard: null, captureStage: 'FULL', cpu: { used: 1, limit: 20, tickLimit: 500, bucket: 9000 }, creeps: [
                { name: 'a', id: 'x', roomName: 'W1N1', pos: { roomName: 'W1N1', x: 1, y: 1 }, spawning: false, body: [{ type: 'work' }, { hits: 100 }], ticksToLive: 5, energy: 0, capacity: 50, legacyRole: null },
            ],
            rooms: {
                W1N1: {
                    roomName: 'W1N1', tick: 10, visible: true, eventLog: { raw: [] }, energyAvailable: 1, energyCapacityAvailable: 2,
                    controller: { id: 'c', my: true, ownerName: 'me', level: undefined, progress: 1, progressTotal: 2, ticksToDowngrade: 3 },
                    structures: [], sources: [], piles: [], creeps: [],
                    spawns: [{ id: 'sp', name: 'S', pos: { roomName: 'W1N1', x: 2, y: 2 }, spawning: { name: 'n', needTime: 9 } }],
                    hostiles: [{ id: 'h', ownerName: null, pos: { roomName: 'W1N1', x: 3, y: 3 }, body: [{ type: 'attack' }] }],
                    constructionSites: [{ id: 's', structureType: 'road', pos: { roomName: 'W1N1', x: 4, y: 4 }, my: true }],
                },
            },
        };
        const s = buildSnapshot(base);
        assert.deepEqual(validateSnapshot(s, { checkFingerprint: true }), { ok: true });
        const sp = s.rooms.W1N1.spawns[0].spawning;
        assert.equal(sp.needTime, 9);
        assert.ok(sp.remainingTime >= 1, 'not a finished spawn');
        assert.deepEqual(s.missingFields, [
            'ownCreeps.a.body.0.hits', 'ownCreeps.a.body.1.type',
            'rooms.W1N1.constructionSites.s.progress', 'rooms.W1N1.constructionSites.s.progressTotal',
            'rooms.W1N1.controller.level', 'rooms.W1N1.hostiles.h.body.0.hits', 'rooms.W1N1.hostiles.h.hits', 'rooms.W1N1.hostiles.h.hitsMax',
            'rooms.W1N1.spawns.sp.spawning.remainingTime',
        ]);
    });

    test(label + ': builder is pure over plain observations; unknown numbers never become 0', function () {
        const obs = {
            tick: 10, shard: null, captureStage: 'FULL', cpu: { used: null, limit: 20, tickLimit: 500, bucket: 9000 },
            creeps: [],
            rooms: {
                W1N1: {
                    roomName: 'W1N1', tick: 10, visible: true, eventLog: { raw: [] }, controller: null, energyAvailable: undefined, energyCapacityAvailable: 300,
                    structures: [{ id: 'x1', objectType: 'extension', pos: { roomName: 'W1N1', x: 1, y: 1 }, energy: NaN, capacity: 50 }],
                    spawns: [], sources: [], hostiles: [], constructionSites: [], piles: [], creeps: [],
                },
            },
        };
        const s = buildSnapshot(obs);
        assert.deepEqual(validateSnapshot(s, { checkFingerprint: true }), { ok: true });
        assert.equal(s.rooms.W1N1.energyNodes[0].amount.value, null);
        assert.equal(s.rooms.W1N1.energyAvailable.quality, 'UNKNOWN');
        assert.equal(snapshotFingerprint(s), s.fingerprint);
        assert.ok(s.missingFields.indexOf('rooms.W1N1.energyNodes.x1.amount') !== -1);
        assert.equal(classifyEnergyNodes(obs.rooms.W1N1).length, 1);
    });
}

module.exports = { defineReaderTests, makeWorld };
