// A2 StateStore / StateCodec / MigrationRegistry / Retention tests. Defined once,
// executed natively (state.test.js) and with dist2/mapPatch.js active
// (state-mappatch.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const F = require('../../support/fixtures');
const H = require('./helpers');
const layout = require('../../../../src/bot/domain/stateLayout');
const { routeRooms } = require('../../../../src/bot/app/OwnershipRouter');
const { createFaultBoundary } = require('../../../../src/bot/app/FaultBoundary');
const { READY } = require('../../../../src/bot/domain/results');
const { fingerprint } = require('../../../../src/bot/domain/fingerprint');
const Codec = require('../../../../src/bot/state/StateCodec');
const R = require('../../../../src/bot/state/Retention');
const M = require('../../../../src/bot/state/MigrationRegistry');

const ROOM = F.ROOM;
const TICK = F.TICK;

class GameLike { constructor() { this.id = 'x'; this.energy = 5; } }

function roomsWritten(world) {
    return Array.from(new Set(world.journal().writes.map(function (w) { return w.where.split('.')[1]; }))).sort();
}

function ids(view) {
    return view.strategy.recentPatchIds.map(function (e) { return e.slice(0, e.lastIndexOf('|fnv1a64:')); });
}

function anyFrozen(value) {
    if (value === null || typeof value !== 'object') return false;
    if (Object.isFrozen(value)) return true;
    return Object.keys(value).some(function (k) { return anyFrozen(value[k]); });
}

function deepFrozen(value) {
    if (value === null || typeof value !== 'object') return true;
    if (!Object.isFrozen(value)) return false;
    return Object.keys(value).every(function (k) { return deepFrozen(value[k]); });
}

function cursorPatch(id, room, observedAt) {
    return { patchId: id, namespace: 'strategyShadow', path: ['rooms', room || ROOM, 'eventCursor'], op: 'set', value: { roomName: room || ROOM, processedThroughTick: (observedAt || TICK) - 1, lastObservedAt: observedAt || TICK, lastRawFingerprint: null } };
}

function decisionRing(room, tick, count, pad) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const d = F.sampleDecisionRecord();
        d.decisionId = 'd-' + room + '-' + i;
        d.roomName = room;
        d.tick = tick;
        d.inputs = { pad: pad || '' };
        out.push(d);
    }
    return out;
}

/** Synthetic schema v0: {schemaVersion:0, revision, rooms:{[room]:{mode, epoch}}}. */
function v0Source(revision) {
    return { schemaVersion: 0, revision: revision === undefined ? 5 : revision, rooms: { W5N8: { mode: 'shadow', epoch: 3 }, W6N8: { mode: 'legacy', epoch: 1 } } };
}

function v0Registry() {
    const registry = M.createMigrationRegistry();
    registry.register(0, function (draft) {
        const root = layout.emptyStrategyRoot({ buildId: 'b-test' });
        root.revision = draft.revision;
        Object.keys(draft.rooms).forEach(function (room) {
            root.control.rooms[room] = { requestedMode: draft.rooms[room].mode, effectiveOwner: 'legacy', epoch: draft.rooms[room].epoch, transitionPhase: null, transitionId: null, previousOwner: null, blockedReason: null };
        });
        return root;
    });
    return registry;
}

const SAFE = Object.freeze({ threat: false, ticksToCriticalDeadline: 500, unresolvedOperations: 0, snapshotFresh: true });

function defineStateTests(label) {
    // ------------------------------------------------------------ open / session
    test(label + ': absent namespaces open as empty schema1 without writing Memory', function () {
        const world = H.createWorld();
        const store = world.store();
        const r = store.open(TICK);
        assert.equal(r.kind, 'READY');
        assert.equal(r.value.status, 'OPEN');
        assert.equal(r.value.strategy.revision, 0);
        assert.deepEqual(r.value.strategy.control.rooms, {});
        assert.deepEqual(layout.validateStateView(r.value), { ok: true });
        assert.ok(deepFrozen(r.value));
        assert.deepEqual(world.journal().writes, [], 'read-only tick writes nothing');
        const table = routeRooms({ state: r, roomNames: [ROOM] });
        assert.equal(table.stateSource, 'OPEN');
        assert.equal(table.rooms[ROOM].effectiveOwner, 'legacy');
    });

    test(label + ': same-tick reopen returns the same session; next tick re-reads', function () {
        const world = H.createWorld();
        const store = world.store();
        const a = store.open(TICK);
        assert.equal(store.open(TICK), a, 'identical result object');
        world.edit(function (m) { m.strategy = layout.emptyStrategyRoot(); m.strategy.revision = 9; });
        assert.equal(store.open(TICK).value.strategy.revision, 0, 'no second independent copy in the same tick');
        world.nextTick();
        assert.equal(store.open(world.tick).value.strategy.revision, 9);
        assert.equal(store.open(null).kind, 'UNKNOWN');
    });

    // ------------------------------------------------------------ apply
    test(label + ': apply is whole-batch, revision++ once, copy-on-write, frozen view, writes only strategy namespaces', function () {
        const world = H.createWorld();
        const store = world.store();
        store.open(TICK);
        const before = store.view();
        const obs = store.api().forWriter('observation');
        const r = obs.apply(0, [cursorPatch('p1'), { patchId: 'p2', namespace: 'strategyShadow', path: ['observedOperations', F.sampleObservedOperation().observationKey], op: 'set', value: F.sampleObservedOperation() }]);
        assert.equal(r.kind, 'READY', JSON.stringify(r));
        assert.deepEqual(r.value, { revision: 1 });
        const v = store.view();
        assert.notEqual(v, before);
        assert.equal(before.strategy.revision, 0, 'old view unchanged');
        assert.equal(v.strategy.revision, 1);
        assert.deepEqual(ids(v), ['p1', 'p2']);
        assert.ok(/^p1\|fnv1a64:[0-9a-f]{16}$/.test(v.strategy.recentPatchIds[0]), 'entry carries the content hash');
        assert.deepEqual(v.shadow.rooms[ROOM].flowWindows, [], 'intermediate room created from emptyShadowRoom');
        assert.equal(v.shadow.rooms[ROOM].eventCursor.lastObservedAt, TICK);
        assert.equal(v.strategy.control, before.strategy.control, 'untouched domains shared');
        assert.ok(deepFrozen(v));
        assert.deepEqual(layout.validateStateView(v), { ok: true });
        assert.deepEqual(roomsWritten(world), ['strategy', 'strategyShadow']);
        assert.equal(JSON.parse(world.serialize()).strategy.revision, 1);

        // one bad patch rejects the whole batch
        const bad = obs.apply(1, [cursorPatch('p3', 'W1N1'), { patchId: 'p4', namespace: 'strategyShadow', path: ['rooms', ROOM, 'eventCursor'], op: 'set', value: { roomName: 'W9N9', processedThroughTick: 1, lastObservedAt: 2, lastRawFingerprint: null } }]);
        assert.equal(bad.kind, 'REJECTED');
        assert.equal(bad.reasonCode, 'INVALID_RECORD');
        assert.equal(bad.evidence.patchId, 'p4');
        assert.equal(store.view().strategy.revision, 1);
        assert.equal(store.view().shadow.rooms.W1N1, undefined, 'valid sibling not applied');

        // foreign revision
        const stale = obs.apply(0, [cursorPatch('p5')]);
        assert.equal(stale.reasonCode, 'STALE_INPUT');
        assert.deepEqual({ e: stale.evidence.expectedRevision, a: stale.evidence.actualRevision }, { e: 0, a: 1 });

        // idempotent replay: same patchIds are no-ops, even with an old revision
        world.journal();
        const replay = obs.apply(0, [cursorPatch('p1')]);
        assert.equal(replay.kind, 'READY');
        assert.deepEqual(replay.value, { revision: 1, replayed: true });
        assert.deepEqual(world.journal().writes, [], 'replay writes nothing');
        // a replay may not claim a future revision
        assert.equal(obs.apply(5, [cursorPatch('p1')]).reasonCode, 'STALE_INPUT');
        // same patchId with different content is refused
        const reused = obs.apply(1, [cursorPatch('p1', 'W4N4')]);
        assert.equal(reused.reasonCode, 'INVALID_RECORD');
        assert.equal(reused.evidence.errors[0].code, 'PATCH_ID_REUSED');
        // duplicate id inside one batch
        assert.equal(obs.apply(1, [cursorPatch('p6'), cursorPatch('p6')]).evidence.errors[0].code, 'DUPLICATE_PATCH_ID');
        // mixed duplicate + new: only the new one counts
        const mixed = obs.apply(1, [cursorPatch('p1'), cursorPatch('p7', 'W2N2')]);
        assert.equal(mixed.value.revision, 2);
        assert.deepEqual(ids(store.view()), ['p1', 'p2', 'p7']);
        // empty batch: no revision
        assert.equal(obs.apply(2, []).value.revision, 2);
    });

    test(label + ': recentPatchIds keeps the last 256 ids', function () {
        const world = H.createWorld();
        const store = world.store();
        store.open(TICK);
        const obs = store.api().forWriter('observation');
        for (let i = 0; i < 260; i++) assert.equal(obs.apply(i, [cursorPatch('id-' + i)]).kind, 'READY');
        const list = ids(store.view());
        assert.equal(list.length, 256);
        assert.equal(list[0], 'id-4');
        assert.equal(obs.apply(260, [cursorPatch('id-0')]).value.revision, 261, 'evicted id is applied again');
    });

    test(label + ': writer-bound handles stamp and enforce the writer; services handle is read-only', function () {
        const world = H.createWorld();
        const store = world.store();
        store.open(TICK);
        const api = store.api();
        assert.deepEqual(Object.keys(api).sort(), ['apply', 'forWriter', 'view']);
        const finance = api.forWriter('finance');
        assert.equal(finance.writer, 'finance');
        const forecast = { patchId: 'f1', namespace: 'strategyShadow', path: ['rooms', ROOM, 'forecast'], op: 'set', value: F.sampleForecastSummary() };
        // a component cannot write another writer's path through its own handle
        const foreign = api.forWriter('observation').apply(0, [forecast]);
        assert.equal(foreign.evidence.errors[0].code, 'NOT_PATH_OWNER');
        // nor claim another writer
        const claimed = api.forWriter('observation').apply(0, [Object.assign({ writer: 'finance' }, forecast)]);
        assert.equal(claimed.evidence.errors[0].code, 'WRITER_MISMATCH');
        assert.equal(finance.apply(0, [forecast]).kind, 'READY');
        assert.equal(forecast.writer, undefined, 'caller patch not mutated');
        assert.throws(function () { api.forWriter('state'); }, TypeError);
        assert.throws(function () { api.forWriter('gateway'); }, TypeError);
        const ro = store.readOnlyApi();
        assert.deepEqual(Object.keys(ro).sort(), ['apply', 'view']);
        assert.equal(ro.apply(1, [forecast]).evidence.errors[0].code, 'READ_ONLY_HANDLE');
        assert.equal(ro.view().strategy.revision, 1);
        for (const handle of [api, ro, finance]) {
            for (const key of Object.keys(handle)) assert.equal(['memory', 'ports', 'Memory', 'read', 'write'].indexOf(key), -1);
        }
    });

    test(label + ': forbidden keys and prototype assignment are rejected', function () {
        const world = H.createWorld();
        const store = world.store();
        store.open(TICK);
        const api = store.api();
        const viaPath = api.forWriter('observation').apply(0, [{ patchId: 'x1', namespace: 'strategyShadow', path: ['observedOperations', '__proto__'], op: 'set', value: F.sampleObservedOperation() }]);
        assert.equal(viaPath.kind, 'REJECTED');
        const ring = decisionRing(ROOM, TICK, 1);
        ring[0].inputs = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}}');
        const viaValue = api.forWriter('planning').apply(0, [{ patchId: 'x2', namespace: 'strategyShadow', path: ['rooms', ROOM, 'decisionRing'], op: 'set', value: ring }]);
        assert.equal(viaValue.evidence.errors[0].code, 'FORBIDDEN_KEY');
        assert.equal({}.polluted, undefined);
        assert.equal(Object.prototype.polluted, undefined);
        // Game objects / NaN / undefined never reach Memory
        const game = api.forWriter('planning').apply(0, [{ patchId: 'x3', namespace: 'strategyShadow', path: ['rooms', ROOM, 'decisionRing'], op: 'set', value: [Object.assign(decisionRing(ROOM, TICK, 1)[0], { inputs: { obj: new GameLike() } })] }]);
        assert.equal(game.kind, 'REJECTED');
        const nan = api.forWriter('planning').apply(0, [{ patchId: 'x4', namespace: 'strategyShadow', path: ['rooms', ROOM, 'decisionRing'], op: 'set', value: [Object.assign(decisionRing(ROOM, TICK, 1)[0], { inputs: { v: NaN } })] }]);
        assert.equal(nan.kind, 'REJECTED');
        assert.equal(store.view().strategy.revision, 0);
        assert.deepEqual(world.journal().writes, []);
    });

    // ------------------------------------------------------------ reset round-trip
    test(label + ': reset round-trip keeps ids, operationKey, generation, occurrence and watermark; no Game refs', function () {
        const root = H.richStrategyRoot();
        const shadow = F.sampleShadowRoot();
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: root, strategyShadow: shadow }));
        const store = world.store();
        const opened = store.open(TICK);
        assert.equal(opened.kind, 'READY', JSON.stringify(opened));
        assert.deepEqual(opened.value.quarantine, []);
        assert.equal(store.api().forWriter('observation').apply(3, [cursorPatch('rt-1', 'W1N1')]).kind, 'READY');
        assert.equal(store.faultStore().save('reconcile.events', { component: 'reconcile.events', consecutiveFailures: 1, totalFailures: 1, lastFailureTick: TICK, lastInputFingerprint: fingerprint({ a: 1 }), lastErrorCode: 'Error', breakerUntil: null, halfOpen: false }), undefined);
        // serialization -> JSON -> new heap (global reset)
        const text = world.serialize();
        assert.doesNotThrow(function () { Codec.encode('strategy', JSON.parse(text).strategy); });
        world.nextTick();
        const reset = world.store();
        const v = reset.open(world.tick).value;
        assert.deepEqual(v.quarantine, []);
        assert.equal(v.strategy.revision, 4, 'one component batch; the fault save is internal (no revision bump)');
        assert.deepEqual(Object.keys(v.strategy.operations).sort(), [H.opKey(0), H.opKey(1), H.opKey(2)].sort());
        for (const key of Object.keys(root.operations)) {
            assert.deepEqual(JSON.parse(JSON.stringify(v.strategy.operations[key])), root.operations[key]);
        }
        assert.deepEqual(JSON.parse(JSON.stringify(v.strategy.bindings)), root.bindings, 'binding generation/operationKey');
        assert.deepEqual(JSON.parse(JSON.stringify(v.strategy.demands)), root.demands, 'demand stableKey/generation');
        assert.deepEqual(JSON.parse(JSON.stringify(v.strategy.assignments)), root.assignments, 'watermark');
        assert.deepEqual(JSON.parse(JSON.stringify(v.strategy.ledger)), root.ledger);
        assert.deepEqual(JSON.parse(JSON.stringify(v.strategy.control)), root.control);
        assert.equal(v.strategy.faults['reconcile.events'].lastInputFingerprint, fingerprint({ a: 1 }));
        const shadowCopy = JSON.parse(JSON.stringify(shadow));
        shadowCopy.rooms.W1N1 = Object.assign(layout.emptyShadowRoom(), { eventCursor: cursorPatch('x', 'W1N1').value });
        assert.deepEqual(JSON.parse(JSON.stringify(v.shadow)), shadowCopy);
        assert.equal(ids(reset.view()).indexOf('rt-1') !== -1, true, 'dedup survives reset');
        assert.equal(reset.api().forWriter('observation').apply(0, [cursorPatch('rt-1', 'W1N1')]).value.replayed, true, 'replay after reset is a no-op');
        assert.equal(reset.view().strategy.revision, 4);
        // the decoded view is a copy, not Memory objects
        assert.ok(deepFrozen(v));
        assert.equal(Object.isFrozen(world.raw().strategy), false);
    });

    // ------------------------------------------------------------ corruption localized
    test(label + ': damaged records are quarantined locally and preserved in Memory', function () {
        const root = H.richStrategyRoot();
        root.operations[H.opKey(1)].confirmedAmount = 'NaN';                 // bad record
        root.faults.bad = { component: 'other', consecutiveFailures: 0 };    // key mismatch + missing fields
        root.futureDomain = { anything: true };                              // unknown top-level key
        const shadow = F.sampleShadowRoot();
        shadow.rooms[ROOM].flowWindows = [{ broken: true }];
        shadow.rooms[ROOM].observedBindings.h2 = { homeRoom: ROOM };
        shadow.rooms.W2N2 = Object.assign(layout.emptyShadowRoom(), { eventCursor: { roomName: 'W2N2', processedThroughTick: 4, lastObservedAt: 5, lastRawFingerprint: null } });
        shadow.rooms['not-a-room'] = layout.emptyShadowRoom();
        shadow.proposals['p-bad'] = { proposalId: 'p-bad' };
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: root, strategyShadow: shadow }));
        const store = world.store();
        const r = store.open(TICK);
        assert.equal(r.kind, 'READY', JSON.stringify(r));
        assert.deepEqual(layout.validateStateView(r.value), { ok: true });
        assert.deepEqual(r.value.quarantine.map(function (q) { return q.namespace + ':' + q.key + ':' + q.reasonCode; }), [
            'strategy:faults.bad:INVALID_RECORD',
            'strategy:futureDomain:INVALID_RECORD',
            'strategy:operations.' + H.opKey(1) + ':INVALID_RECORD',
            'strategyShadow:proposals.p-bad:INVALID_RECORD',
            'strategyShadow:rooms.W5N8.flowWindows:INVALID_RECORD',
            'strategyShadow:rooms.W5N8.observedBindings.h2:INVALID_RECORD',
            'strategyShadow:rooms.not-a-room:INVALID_RECORD',
        ]);
        // the rest loaded
        assert.ok(r.value.strategy.operations[H.opKey(0)]);
        assert.ok(r.value.strategy.operations[H.opKey(2)]);
        assert.equal(r.value.strategy.operations[H.opKey(1)], undefined);
        assert.ok(r.value.strategy.faults['plan.room']);
        assert.equal(r.value.shadow.rooms.W2N2.eventCursor.lastObservedAt, 5);
        assert.ok(r.value.shadow.rooms[ROOM].observedBindings.h1);
        assert.deepEqual(r.value.shadow.rooms[ROOM].flowWindows, []);
        assert.ok(r.value.shadow.proposals['p-1000-1']);
        const router = routeRooms({ state: r, roomNames: [ROOM] });
        assert.equal(router.rooms[ROOM].newSystem, 'SHADOW', 'a damaged record does not suspend the room');

        // an unrelated write keeps every quarantined raw value in Memory
        const obs = store.api().forWriter('observation');
        assert.equal(obs.apply(3, [cursorPatch('c1', 'W3N3')]).kind, 'READY');
        const mem = JSON.parse(world.serialize());
        assert.deepEqual(mem.strategy.operations[H.opKey(1)], root.operations[H.opKey(1)]);
        assert.deepEqual(mem.strategy.faults.bad, root.faults.bad);
        assert.deepEqual(mem.strategy.futureDomain, root.futureDomain);
        assert.deepEqual(mem.strategyShadow.rooms[ROOM].flowWindows, [{ broken: true }]);
        assert.deepEqual(mem.strategyShadow.rooms[ROOM].observedBindings.h2, { homeRoom: ROOM });
        assert.deepEqual(mem.strategyShadow.rooms['not-a-room'], layout.emptyShadowRoom());
        assert.deepEqual(mem.strategyShadow.proposals['p-bad'], { proposalId: 'p-bad' });

        // component writers can neither overwrite nor delete a quarantined record
        const fwSet = obs.apply(4, [{ patchId: 'c2', namespace: 'strategyShadow', path: ['rooms', ROOM, 'flowWindows'], op: 'set', value: [F.sampleFlowWindow()] }]);
        assert.equal(fwSet.evidence.errors[0].code, 'QUARANTINED');
        const bindDel = obs.apply(4, [{ patchId: 'c2b', namespace: 'strategyShadow', path: ['rooms', ROOM, 'observedBindings', 'h2'], op: 'delete' }]);
        assert.equal(bindDel.evidence.errors[0].code, 'QUARANTINED');
        const propDel = store.api().forWriter('planning').apply(4, [{ patchId: 'c2c', namespace: 'strategyShadow', path: ['proposals', 'p-bad'], op: 'delete' }]);
        assert.equal(propDel.evidence.errors[0].code, 'QUARANTINED');
        // nor delete a parent of one (writer state included)
        const del = store.apply(4, [{ patchId: 'c3', writer: 'state', namespace: 'strategyShadow', path: ['rooms', ROOM], op: 'delete' }]);
        assert.equal(del.evidence.errors[0].code, 'QUARANTINE_CONFLICT');
        // a fault save onto a quarantined fault record falls back to heap, raw kept
        store.faultStore().save('bad', { component: 'bad', consecutiveFailures: 1, totalFailures: 1, lastFailureTick: TICK, lastInputFingerprint: null, lastErrorCode: 'E', breakerUntil: null, halfOpen: false });
        assert.deepEqual(JSON.parse(world.serialize()).strategy.faults.bad, root.faults.bad);
        assert.deepEqual(JSON.parse(world.serialize()).strategyShadow.rooms[ROOM].flowWindows, [{ broken: true }], 'raw preserved');

        // after reset the quarantine is reproduced, nothing was lost
        world.nextTick();
        const reset = world.store();
        const again = reset.open(world.tick);
        assert.equal(again.value.quarantine.length, 7);

        // explicit maintenance call releases one record (raw returned for archiving); then the owner may write
        const released = reset.releaseQuarantine('strategyShadow', 'rooms.W5N8.flowWindows');
        assert.equal(released.kind, 'READY');
        assert.deepEqual(released.value.raw, [{ broken: true }]);
        assert.equal(reset.view().quarantine.length, 6);
        assert.equal(JSON.parse(world.serialize()).strategyShadow.rooms[ROOM].flowWindows, undefined);
        const rev = reset.view().strategy.revision;
        assert.equal(reset.api().forWriter('observation').apply(rev, [{ patchId: 'c4', namespace: 'strategyShadow', path: ['rooms', ROOM, 'flowWindows'], op: 'set', value: [F.sampleFlowWindow()] }]).kind, 'READY');
        assert.equal(reset.releaseQuarantine('strategyShadow', 'rooms.W5N8.flowWindows').reasonCode, 'INVALID_RECORD');
        world.nextTick();
        assert.equal(world.store().open(world.tick).value.quarantine.length, 6);
    });

    test(label + ': codec rejects Game objects, NaN, Infinity, undefined and cycles', function () {
        const shadow = layout.emptyShadowRoot();
        shadow.rooms[ROOM] = layout.emptyShadowRoom();
        shadow.rooms[ROOM].observedBindings.g = new GameLike();
        shadow.rooms[ROOM].observedBindings.n = Object.assign(F.sampleObservedBinding(), { bodyCost: NaN });
        shadow.rooms[ROOM].observedBindings.i = Object.assign(F.sampleObservedBinding(), { bodyCost: Infinity });
        shadow.rooms[ROOM].observedBindings.u = Object.assign(F.sampleObservedBinding(), { legacyRole: undefined });
        shadow.rooms[ROOM].observedBindings.ok = F.sampleObservedBinding();
        const decoded = Codec.decode('strategyShadow', shadow);
        assert.equal(decoded.status, 'OK');
        assert.deepEqual(decoded.quarantine.map(function (q) { return q.key; }).sort(), ['rooms.W5N8.observedBindings.g', 'rooms.W5N8.observedBindings.i', 'rooms.W5N8.observedBindings.n', 'rooms.W5N8.observedBindings.u']);
        assert.deepEqual(Object.keys(decoded.value.rooms[ROOM].observedBindings), ['ok']);
        const cyclic = { a: 1 };
        cyclic.self = cyclic;
        for (const bad of [cyclic, { v: undefined }, { v: NaN }, { v: new Map() }, { v: new GameLike() }]) {
            assert.throws(function () { Codec.encode('strategy', bad); }, /CanonicalError|at/);
        }
        assert.equal(Codec.encode('strategy', { b: 1, a: 2 }), '{"a":2,"b":1}');
        assert.throws(function () { Codec.decode('legacy', {}); }, TypeError);
    });

    // ------------------------------------------------------------ incompatible schema
    const incompatibleCases = [
        ['newer schemaVersion', function (m) { m.strategy = Object.assign(layout.emptyStrategyRoot(), { schemaVersion: 2, novel: { x: 1 } }); }],
        ['non-integer schemaVersion', function (m) { m.strategy = Object.assign(layout.emptyStrategyRoot(), { schemaVersion: '1' }); }],
        ['root is not an object', function (m) { m.strategy = [1, 2]; }],
        ['corrupt control record', function (m) { m.strategy = F.sampleStrategyRoot({ W5N8: F.sampleControlRecord({ effectiveOwner: 'nobody' }) }); }],
        ['control key not a room', function (m) { m.strategy = F.sampleStrategyRoot({ 'bad key': F.sampleControlRecord() }); }],
        ['corrupt meta (revision)', function (m) { m.strategy = Object.assign(F.sampleStrategyRoot(), { revision: -1 }); }],
        ['missing control', function (m) { m.strategy = F.sampleStrategyRoot(); delete m.strategy.control; }],
        ['older schema without migration', function (m) { m.strategy = v0Source(); }],
        ['newer migration format', function (m) { m.strategy = F.sampleStrategyRoot(); m.strategyMigration = { formatVersion: 2, anything: true }; }],
        ['corrupt migration record', function (m) { m.strategy = F.sampleStrategyRoot(); m.strategyMigration = { formatVersion: 1 }; }],
    ];
    for (const [name, mutate] of incompatibleCases) {
        test(label + ': incompatible (' + name + ') -> INCOMPATIBLE_SCHEMA, namespaces byte-identical, domains suspended', function () {
            const initial = JSON.parse(JSON.stringify(H.LEGACY));
            initial.strategyShadow = F.sampleShadowRoot();
            mutate(initial);
            const world = H.createWorld(initial);
            const before = world.serialize();
            const store = world.store();
            const r = store.open(TICK);
            assert.equal(r.kind, 'REJECTED');
            assert.equal(r.reasonCode, 'INCOMPATIBLE_SCHEMA');
            assert.equal(store.view(), null, 'no empty world');
            // every write path refuses
            assert.equal(store.apply(0, [Object.assign({ writer: 'state' }, F.sampleStatePatches().state)]).reasonCode, 'INCOMPATIBLE_SCHEMA');
            assert.equal(store.api().forWriter('observation').apply(0, [cursorPatch('i1')]).reasonCode, 'INCOMPATIBLE_SCHEMA');
            assert.equal(store.checkpoint('after-critical').reasonCode, 'INCOMPATIBLE_SCHEMA');
            assert.equal(store.compact(TICK).kind, 'REJECTED');
            const fs = store.faultStore();
            fs.save('plan.room', { component: 'plan.room', consecutiveFailures: 1, totalFailures: 1, lastFailureTick: TICK, lastInputFingerprint: null, lastErrorCode: 'Error', breakerUntil: null, halfOpen: false });
            assert.equal(fs.load('plan.room').consecutiveFailures, 1, 'fault status kept in heap');
            assert.equal(world.serialize(), before, 'Memory byte-identical');
            assert.deepEqual(world.journal().writes, []);
            const table = routeRooms({ state: r, roomNames: [ROOM] });
            assert.equal(table.stateSource, 'SUSPENDED');
            assert.equal(table.rooms[ROOM].effectiveOwner, 'unconfirmed');
            assert.equal(table.rooms[ROOM].newSystem, 'SUSPENDED');
            assert.equal(store.health().status, 'SUSPENDED');
            assert.ok(world.logLines.some(function (l) { return l[1] === 'STATE_INCOMPATIBLE'; }));
        });
    }

    test(label + ': incompatible shadow disables shadow only, never touched', function () {
        const initial = Object.assign({}, H.LEGACY, { strategy: F.sampleStrategyRoot(), strategyShadow: { schemaVersion: 7, rooms: 'future' } });
        const world = H.createWorld(initial);
        const store = world.store();
        const r = store.open(TICK);
        assert.equal(r.kind, 'READY');
        assert.equal(r.value.shadow, null);
        assert.deepEqual(r.value.quarantine, [{ namespace: 'strategyShadow', key: '*', reasonCode: 'INCOMPATIBLE_SCHEMA' }]);
        assert.equal(store.api().forWriter('observation').apply(3, [cursorPatch('s1')]).reasonCode, 'INCOMPATIBLE_SCHEMA');
        assert.equal(store.apply(3, [F.sampleStatePatches().state]).kind, 'READY');
        assert.equal(store.checkpoint('close').kind, 'READY');
        assert.deepEqual(JSON.parse(world.serialize()).strategyShadow, { schemaVersion: 7, rooms: 'future' });
        assert.deepEqual(roomsWritten(world), ['strategy']);
    });

    // ------------------------------------------------------------ namespace confinement
    test(label + ': StateStore never writes outside strategy, strategyShadow, strategyMigration', function () {
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: H.richStrategyRoot(), strategyShadow: F.sampleShadowRoot() }));
        const legacyBefore = JSON.stringify(Object.keys(H.LEGACY).map(function (k) { return world.raw()[k]; }));
        const store = world.store();
        for (let i = 0; i < 3; i++) {
            const view = store.open(world.tick).value;
            store.api().forWriter('observation').apply(view.strategy.revision, [cursorPatch('n' + i, 'W1N' + (i + 1), world.tick)]);
            store.api().forWriter('finance').apply(view.strategy.revision + 1, [{ patchId: 'nf' + i, namespace: 'strategyShadow', path: ['ledger', 'reservations', 'r1'], op: 'delete' }]);
            store.faultStore().save('x.y', { component: 'x.y', consecutiveFailures: i, totalFailures: i, lastFailureTick: world.tick, lastInputFingerprint: null, lastErrorCode: null, breakerUntil: null, halfOpen: false });
            store.checkpoint('t' + i);
            store.compact(world.tick + 40000);
            world.nextTick();
        }
        const mig = world.store({ registry: v0Registry() }).migrator();
        mig.start(world.tick, SAFE);
        const journal = world.journal();
        assert.deepEqual(journal.violations, []);
        assert.ok(journal.writes.length > 0);
        const roots = Array.from(new Set(journal.writes.map(function (w) { return w.where.split('.')[1]; }))).sort();
        assert.deepEqual(roots.filter(function (r) { return H.STRATEGY_KEYS.indexOf(r) === -1; }), []);
        assert.equal(JSON.stringify(Object.keys(H.LEGACY).map(function (k) { return world.raw()[k]; })), legacyBefore, 'legacy Memory untouched');
    });

    // ------------------------------------------------------------ FaultStore
    test(label + ': faultStore persists FaultStatus in strategy.faults; load returns a mutable copy; survives reset', function () {
        const world = H.createWorld();
        let store = world.store();
        let boundary = createFaultBoundary({ store: store.faultStore() });
        for (let i = 0; i < 3; i++) {
            boundary.run('plan.room', { tick: world.tick, inputFingerprint: fingerprint({ i: i }) }, function () { throw new Error('boom'); });
            world.nextTick(30);
        }
        world.nextTick();
        store = world.store();                       // global reset: heap gone
        boundary = createFaultBoundary({ store: store.faultStore() });
        const status = boundary.status('plan.room');
        assert.equal(status.consecutiveFailures, 3);
        assert.ok(status.breakerUntil > world.tick, 'breaker survives reset');
        const r = boundary.run('plan.room', { tick: world.tick }, function () { return READY(1, fingerprint(1)); });
        assert.equal(r.reasonCode, 'CIRCUIT_OPEN');
        const copy = store.faultStore().load('plan.room');
        copy.consecutiveFailures = 99;
        assert.equal(store.view().strategy.faults['plan.room'].consecutiveFailures, 3, 'stored object not mutated');
        assert.equal(store.faultStore().load('missing'), null);
        assert.deepEqual(roomsWritten(world), ['strategy']);
        assert.deepEqual(store.view().strategy.recentPatchIds, [], 'internal writes do not consume dedup slots');
    });

    test(label + ': faultStore falls back to heap during migration freeze (READ_ONLY)', function () {
        const running = { formatVersion: 1, namespace: 'strategy', fromVersion: 1, toVersion: 2, draftVersion: 1, status: 'RUNNING', startedAt: TICK, deadlineTick: TICK + 10, sourceRevision: 3, sourceFingerprint: fingerprint(1), draft: null, cancelReason: null, cancelledAt: null, notBefore: null, completedAt: null };
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: F.sampleStrategyRoot(), strategyMigration: running }));
        const before = world.serialize();
        const store = world.store();
        const r = store.open(TICK);
        assert.equal(r.value.status, 'READ_ONLY');
        const applied = store.apply(3, [F.sampleStatePatches().state]);
        assert.equal(applied.reasonCode, 'STALE_INPUT');
        assert.equal(applied.evidence.cause, 'MIGRATION_FREEZE');
        store.faultStore().save('a.b', { component: 'a.b', consecutiveFailures: 1, totalFailures: 1, lastFailureTick: TICK, lastInputFingerprint: null, lastErrorCode: 'E', breakerUntil: null, halfOpen: false });
        assert.equal(store.faultStore().load('a.b').totalFailures, 1);
        assert.equal(world.serialize(), before, 'frozen source untouched');
    });

    // ------------------------------------------------------------ limits / retention
    test(label + ': 256 KiB guard refuses optional growth, keeps disputed data, allows deletes and state writes', function () {
        const shadow = layout.emptyShadowRoot();
        const pad = 'x'.repeat(300);
        for (let i = 1; i <= 7; i++) {
            const room = 'W' + i + 'N1';
            shadow.rooms[room] = Object.assign(layout.emptyShadowRoom(), { decisionRing: decisionRing(room, TICK, 100, pad) });
        }
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: F.sampleStrategyRoot(), strategyShadow: shadow }));
        const store = world.store();
        store.open(TICK + 10);
        assert.ok(store.health().sizeBytes > R.SIZE_LIMIT_BYTES, 'fixture is above the threshold: ' + store.health().sizeBytes);
        const before = world.serialize();
        const grow = store.api().forWriter('planning').apply(3, [{ patchId: 'g1', namespace: 'strategyShadow', path: ['rooms', 'W8N1', 'decisionRing'], op: 'set', value: decisionRing('W8N1', TICK, 10, pad) }]);
        assert.equal(grow.kind, 'REJECTED');
        assert.equal(grow.reasonCode, 'BUDGET_DEFERRED');
        assert.equal(grow.evidence.degraded, true);
        assert.equal(world.serialize(), before, 'recently observed (undisputed but fresh) rooms were not dropped');
        assert.ok(store.health().degradation.some(function (d) { return d.code === 'SIZE_LIMIT'; }));
        // shrinking writes and essential state writes still pass
        assert.equal(store.api().forWriter('planning').apply(3, [{ patchId: 'g2', namespace: 'strategyShadow', path: ['rooms', 'W1N1', 'decisionRing'], op: 'set', value: [] }]).kind, 'READY');
        assert.equal(store.apply(4, [F.sampleStatePatches().state]).kind, 'READY');
    });

    test(label + ': size guard compacts stale rooms first', function () {
        const shadow = layout.emptyShadowRoot();
        const pad = 'x'.repeat(300);
        for (let i = 1; i <= 7; i++) {
            const room = 'W' + i + 'N1';
            shadow.rooms[room] = Object.assign(layout.emptyShadowRoom(), { decisionRing: decisionRing(room, i === 1 ? 10 : TICK + 4000, 100, pad) });
        }
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: F.sampleStrategyRoot(), strategyShadow: shadow }));
        const store = world.store();
        store.open(TICK + 4000);
        const grow = store.api().forWriter('planning').apply(3, [{ patchId: 'g1', namespace: 'strategyShadow', path: ['rooms', 'W8N1', 'decisionRing'], op: 'set', value: decisionRing('W8N1', TICK, 10, pad) }]);
        assert.equal(grow.kind, 'READY', JSON.stringify(grow));
        assert.equal(store.view().shadow.rooms.W1N1, undefined, 'stalest room evicted by writer state');
        assert.ok(store.view().shadow.rooms.W8N1);
    });

    test(label + ': shadow room limit: stale rooms evicted, disputed rooms never', function () {
        const shadow = layout.emptyShadowRoot();
        const names = [];
        for (let i = 0; i < 64; i++) names.push('W' + i + 'S9');
        names.forEach(function (room, i) {
            shadow.rooms[room] = Object.assign(layout.emptyShadowRoom(), { eventCursor: { roomName: room, processedThroughTick: i, lastObservedAt: i + 1, lastRawFingerprint: null } });
        });
        // the stalest room holds a disputed reservation
        shadow.ledger.reservations.r1 = Object.assign(F.sampleReservation(), { roomName: names[0], nodeId: 'spawnPool:' + names[0], state: 'ISSUED', unknownAmount: 50 });
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: F.sampleStrategyRoot(), strategyShadow: shadow }));
        const store = world.store();
        store.open(TICK + 5000);
        const r = store.api().forWriter('observation').apply(3, [cursorPatch('new', 'E1N1', TICK + 5000)]);
        assert.equal(r.kind, 'READY', JSON.stringify(r));
        const rooms = store.view().shadow.rooms;
        assert.equal(Object.keys(rooms).length, 64);
        assert.ok(rooms[names[0]], 'disputed room kept');
        assert.equal(rooms[names[1]], undefined, 'stalest undisputed room evicted');
        assert.ok(rooms.E1N1);
        // compact(): proactive headroom
        const c = store.compact(TICK + 5000);
        assert.equal(c.kind, 'READY');
        assert.equal(c.value.evicted.length, 4);
        assert.equal(c.value.evicted.indexOf(names[0]), -1);
        assert.equal(Object.keys(store.view().shadow.rooms).length, 60);
    });

    test(label + ': shadow room limit with nothing evictable -> rejected with degradation', function () {
        const shadow = layout.emptyShadowRoot();
        for (let i = 0; i < 64; i++) {
            const room = 'W' + i + 'S9';
            shadow.rooms[room] = Object.assign(layout.emptyShadowRoom(), { eventCursor: { roomName: room, processedThroughTick: TICK - 1, lastObservedAt: TICK, lastRawFingerprint: null } });
        }
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: F.sampleStrategyRoot(), strategyShadow: shadow }));
        const store = world.store();
        store.open(TICK + 1);
        const r = store.api().forWriter('observation').apply(3, [cursorPatch('new', 'E1N1', TICK + 1)]);
        assert.equal(r.reasonCode, 'INVALID_RECORD');
        assert.equal(r.evidence.errors[0].code, 'TOO_MANY_KEYS');
        assert.equal(r.evidence.degraded, true);
        assert.equal(Object.keys(store.view().shadow.rooms).length, 64);
    });

    test(label + ': retention: unfinished operations per room with critical reserve', function () {
        assert.equal(R.admitOperation(245, 'OPTIONAL').kind, 'READY');
        assert.equal(R.admitOperation(246, 'REQUIRED').reasonCode, 'BUDGET_DEFERRED');
        assert.equal(R.admitOperation(246, 'CRITICAL').kind, 'READY');
        assert.equal(R.admitOperation(255, 'CRITICAL').kind, 'READY');
        assert.equal(R.admitOperation(256, 'CRITICAL').reasonCode, 'BUDGET_DEFERRED');
        const ops = {};
        [H.operation(0, 'CONFIRMED'), H.operation(1, 'ISSUED'), H.operation(2, 'CONFIRMED')].forEach(function (o) { ops[o.operationKey] = o; });
        assert.deepEqual(R.countUnfinishedByRoom(ops, function () { return ROOM; }), { W5N8: 1 });
    });

    test(label + ': retention: occurrence compaction never skips an unclosed gap', function () {
        const ops = {};
        [H.operation(0, 'CONFIRMED'), H.operation(1, 'CONFIRMED'), H.operation(2, 'ISSUED'), H.operation(3, 'CONFIRMED'), H.operation(5, 'UNKNOWN_RETIRED')].forEach(function (o) { ops[o.operationKey] = o; });
        const oneOff = Object.assign(H.operation('boot', 'CONFIRMED'));
        ops[oneOff.operationKey] = oneOff;
        const frozenInput = JSON.stringify(ops);
        const r = R.compactOccurrences(ops, {}, {});
        assert.equal(JSON.stringify(ops), frozenInput, 'input not mutated');
        const series = H.opKey(0).slice(0, H.opKey(0).lastIndexOf('/'));
        assert.deepEqual(r.watermarks[series], { seriesKey: series, closedThrough: 1, compactedCount: 2, confirmedAmount: 300, updatedAt: TICK + 1 });
        assert.deepEqual(Object.keys(r.operations).sort(), [H.opKey(2), H.opKey(3), H.opKey(5)].sort(), 'ISSUED gap, later CONFIRMED and UNKNOWN_RETIRED stay');
        assert.ok(r.dedup[oneOff.operationKey]);
        // gap closes later: watermark advances monotonically through 3, stops at missing 4
        const ops2 = Object.assign({}, r.operations);
        ops2[H.opKey(2)] = H.operation(2, 'CONFIRMED');
        const r2 = R.compactOccurrences(ops2, r.watermarks, r.dedup);
        assert.equal(r2.watermarks[series].closedThrough, 3);
        assert.deepEqual(Object.keys(r2.operations), [H.opKey(5)]);
        // a stale record below the watermark is reported, not silently merged
        const ops3 = { [H.opKey(1)]: H.operation(1, 'CONFIRMED') };
        assert.deepEqual(R.compactOccurrences(ops3, r2.watermarks, {}).belowWatermark, [H.opKey(1)]);
    });

    // ------------------------------------------------------------ migration
    test(label + ': registry plans vN->vN+1 chains only', function () {
        const reg = v0Registry();
        assert.deepEqual(reg.plan(0, 1).value.steps, [{ from: 0, to: 1 }]);
        assert.equal(reg.plan(0, 2).reasonCode, 'INCOMPATIBLE_SCHEMA');
        assert.equal(reg.plan(0, 2).evidence.missing, 1);
        assert.throws(function () { reg.register(0, function (d) { return d; }); }, TypeError);
        assert.equal(M.createMigrationRegistry().plan(0, 1).kind, 'REJECTED');
    });

    function migrationWorld(extra) {
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: v0Source() }, extra || {}));
        return { world: world, store: world.store({ registry: v0Registry() }) };
    }

    test(label + ': synthetic v0->v1 migration: freeze, one step per call, swap', function () {
        const { world, store } = migrationWorld();
        const source = world.serialize();
        assert.equal(store.open(TICK).evidence.migration, 'REQUIRED');
        const mig = store.migrator();
        const started = mig.start(TICK, SAFE);
        assert.equal(started.kind, 'READY', JSON.stringify(started));
        assert.equal(started.value.sourceRevision, 5);
        assert.equal(started.value.sourceFingerprint, fingerprint(v0Source()));
        assert.equal(started.value.deadlineTick, TICK + 10);
        world.nextTick();
        assert.equal(store.open(world.tick).evidence.migration, 'RUNNING');
        assert.equal(JSON.parse(world.serialize()).strategy.schemaVersion, 0, 'source frozen');
        assert.equal(mig.step(world.tick, SAFE).value.draftVersion, 1);
        world.nextTick();
        assert.equal(mig.step(world.tick, Object.assign({}, SAFE, { snapshotFresh: false })).kind, 'DEFERRED', 'swap needs a fresh world snapshot');
        const done = mig.step(world.tick, SAFE);
        assert.equal(done.value.status, 'DONE');
        assert.notEqual(world.serialize(), source);
        const opened = store.open(world.tick);
        assert.equal(opened.kind, 'READY', JSON.stringify(opened));
        assert.equal(opened.value.strategy.control.rooms.W5N8.requestedMode, 'shadow');
        assert.equal(opened.value.strategy.revision, 5);
        assert.deepEqual(JSON.parse(JSON.stringify(opened.value.strategy.migrations)), { version: 1, cursor: null, sourceRevision: 5, status: 'DONE' });
        assert.equal(JSON.parse(world.serialize()).strategyMigration.draft, null);
    });

    function expectCancelled(world, mig, result, reason, code, sourceText) {
        assert.equal(result.kind, 'REJECTED');
        assert.equal(result.reasonCode, code);
        assert.equal(result.evidence.cancelReason, reason);
        const mem = JSON.parse(world.serialize());
        assert.equal(mem.strategyMigration.status, 'CANCELLED');
        assert.equal(mem.strategyMigration.draft, null, 'draft dropped');
        assert.equal(JSON.stringify(mem.strategy), sourceText, 'source intact');
        assert.equal(mig.status().value.status, 'CANCELLED');
    }

    test(label + ': migration cancelled when the source revision changes; restart only after 100 ticks', function () {
        const { world, store } = migrationWorld();
        const mig = store.migrator();
        mig.start(TICK, SAFE);
        world.edit(function (m) { m.strategy.revision = 6; });
        const src = JSON.stringify(JSON.parse(world.serialize()).strategy);
        world.nextTick();
        expectCancelled(world, mig, mig.step(world.tick, SAFE), 'SOURCE_CHANGED', 'STALE_INPUT', src);
        assert.equal(mig.start(world.tick + 50, SAFE).reasonCode, 'RETRY_COOLDOWN');
        assert.equal(mig.start(world.tick + 100, SAFE).kind, 'READY');
    });

    test(label + ': migration cancelled when the source fingerprint changes at the same revision', function () {
        const { world, store } = migrationWorld();
        const mig = store.migrator();
        mig.start(TICK, SAFE);
        world.nextTick();
        assert.equal(mig.step(world.tick, SAFE).kind, 'READY');
        world.edit(function (m) { m.strategy.rooms.W5N8.epoch = 4; });
        const src = JSON.stringify(JSON.parse(world.serialize()).strategy);
        world.nextTick();
        expectCancelled(world, mig, mig.step(world.tick, SAFE), 'SOURCE_CHANGED', 'STALE_INPUT', src);
    });

    test(label + ': migration window is 10 ticks: the 11th tick cancels', function () {
        const { world, store } = migrationWorld();
        const src = JSON.stringify(v0Source());
        const mig = store.migrator();
        mig.start(TICK, SAFE);
        world.nextTick(9);
        assert.equal(world.tick, TICK + 9);
        assert.equal(mig.step(world.tick, SAFE).kind, 'READY', 'tick 10 of the window still runs');
        world.nextTick();
        expectCancelled(world, mig, mig.step(world.tick, SAFE), 'WINDOW_EXPIRED', 'BUDGET_DEFERRED', src);
    });

    test(label + ': migration cancelled by a threat or a close critical deadline; not started without preconditions', function () {
        for (const [safety, reason] of [[{ threat: true }, 'THREAT'], [{ ticksToCriticalDeadline: 99 }, 'DEADLINE'], [{ ticksToCriticalDeadline: null }, 'DEADLINE']]) {
            const { world, store } = migrationWorld();
            const mig = store.migrator();
            mig.start(TICK, SAFE);
            world.nextTick();
            expectCancelled(world, mig, mig.step(world.tick, Object.assign({}, SAFE, safety)), reason, 'CRITICAL_DEADLINE', JSON.stringify(v0Source()));
        }
        const { world, store } = migrationWorld();
        const before = world.serialize();
        const mig = store.migrator();
        assert.equal(mig.start(TICK, Object.assign({}, SAFE, { unresolvedOperations: 1 })).reasonCode, 'AMBIGUOUS_EFFECT');
        assert.equal(mig.start(TICK, Object.assign({}, SAFE, { threat: true })).reasonCode, 'CRITICAL_DEADLINE');
        assert.equal(mig.start(TICK, Object.assign({}, SAFE, { ticksToCriticalDeadline: 50 })).reasonCode, 'CRITICAL_DEADLINE');
        assert.equal(world.serialize(), before, 'refused start writes nothing');
    });

    test(label + ': reset continues only a draft with the same source fingerprint', function () {
        const first = migrationWorld();
        first.store.migrator().start(TICK, SAFE);
        first.world.nextTick();
        assert.equal(first.store.migrator().step(first.world.tick, SAFE).value.draftVersion, 1);
        first.world.nextTick();
        const afterReset = first.world.store({ registry: v0Registry() }).migrator();   // new heap
        assert.equal(afterReset.step(first.world.tick, SAFE).value.status, 'DONE');

        const second = migrationWorld();
        second.store.migrator().start(TICK, SAFE);
        second.world.edit(function (m) { m.strategy.rooms.W6N8.mode = 'shadow'; });
        const src = JSON.stringify(JSON.parse(second.world.serialize()).strategy);
        second.world.nextTick();
        const resumed = second.world.store({ registry: v0Registry() }).migrator();
        expectCancelled(second.world, resumed, resumed.step(second.world.tick, SAFE), 'SOURCE_CHANGED', 'STALE_INPUT', src);
    });

    test(label + ': a failing or invalid migration step cancels without touching the source', function () {
        const registry = M.createMigrationRegistry();
        registry.register(0, function () { throw new Error('bad step'); });
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: v0Source() }));
        const mig = world.store({ registry: registry }).migrator();
        mig.start(TICK, SAFE);
        expectCancelled(world, mig, mig.step(TICK + 1, SAFE), 'MIGRATE_FAULT', 'COMPONENT_FAULT', JSON.stringify(v0Source()));

        const registry2 = M.createMigrationRegistry();
        registry2.register(0, function (d) { return { schemaVersion: 1, revision: d.revision }; }); // not a valid schema1 root
        const world2 = H.createWorld(Object.assign({}, H.LEGACY, { strategy: v0Source() }));
        const mig2 = world2.store({ registry: registry2 }).migrator();
        mig2.start(TICK, SAFE);
        assert.equal(mig2.step(TICK + 1, SAFE).kind, 'READY');
        expectCancelled(world2, mig2, mig2.step(TICK + 2, SAFE), 'DRAFT_INVALID', 'INVALID_RECORD', JSON.stringify(v0Source()));
    });

    // ------------------------------------------------------------ review fixes
    test(label + ': Memory never holds frozen objects; operator edits after the loop are seen next tick', function () {
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: F.sampleStrategyRoot(), strategyShadow: F.sampleShadowRoot() }));
        const store = world.store();
        store.open(TICK);
        assert.equal(store.api().forWriter('planning').apply(3, [{ patchId: 'm1', namespace: 'strategyShadow', path: ['rooms', ROOM, 'decisionRing'], op: 'set', value: decisionRing(ROOM, TICK, 2) }]).kind, 'READY');
        store.faultStore().save('a.b', { component: 'a.b', consecutiveFailures: 1, totalFailures: 1, lastFailureTick: TICK, lastInputFingerprint: null, lastErrorCode: 'E', breakerUntil: null, halfOpen: false });
        assert.equal(anyFrozen(world.raw().strategy), false);
        assert.equal(anyFrozen(world.raw().strategyShadow), false);
        assert.ok(deepFrozen(store.view()), 'view stays frozen');
        // operator console edit in the same tick, after the loop
        world.raw().strategy.control.rooms[ROOM].requestedMode = 'legacy';
        world.raw().strategyShadow.rooms[ROOM].decisionRing.pop();
        assert.equal(world.raw().strategy.control.rooms[ROOM].requestedMode, 'legacy', 'edit not silently ignored');
        assert.equal(store.view().strategy.control.rooms[ROOM].requestedMode, 'shadow', 'view unaffected');
        world.nextTick();
        const v = store.open(world.tick).value;
        assert.equal(v.strategy.control.rooms[ROOM].requestedMode, 'legacy', 'same heap re-decodes the edited namespace');
        assert.equal(v.shadow.rooms[ROOM].decisionRing.length, 1);
        assert.equal(v.strategy.faults['a.b'].totalFailures, 1);
    });

    test(label + ': unchanged namespaces reuse the decoded view (with and without writes)', function () {
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: H.richStrategyRoot(), strategyShadow: F.sampleShadowRoot() }));
        const store = world.store();
        const a = store.open(TICK);
        world.nextTick();
        const b = store.open(world.tick);
        assert.equal(b.value.strategy, a.value.strategy, 'read-only heap: cached decode reused');
        assert.equal(b.value.shadow, a.value.shadow);
        assert.equal(b.inputFingerprint, a.inputFingerprint, 'unchanged content -> same fingerprint');
        assert.equal(store.api().forWriter('observation').apply(3, [cursorPatch('w1', 'W1N1', world.tick)]).kind, 'READY');
        const afterWrite = store.view();
        world.nextTick();
        const c = store.open(world.tick);
        assert.equal(c.value.strategy, afterWrite.strategy, 'written state reused next tick (mirror text matches)');
        assert.notEqual(c.inputFingerprint, a.inputFingerprint);
        world.edit(function (m) { m.strategy.revision = 77; });
        world.nextTick();
        const d = store.open(world.tick);
        assert.equal(d.value.strategy.revision, 77, 'external change detected');
        assert.notEqual(d.inputFingerprint, c.inputFingerprint);
    });

    test(label + ': internal writes (faults, compaction) do not make sibling components stale', function () {
        const shadow = layout.emptyShadowRoot();
        shadow.rooms.W9N9 = Object.assign(layout.emptyShadowRoom(), { eventCursor: { roomName: 'W9N9', processedThroughTick: 1, lastObservedAt: 2, lastRawFingerprint: null } });
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: F.sampleStrategyRoot(), strategyShadow: shadow }));
        const store = world.store();
        world.setTick(TICK + 40000);
        store.open(world.tick);
        const seen = store.view().strategy.revision;                 // component A reads
        createFaultBoundary({ store: store.faultStore() }).run('b.fail', { tick: world.tick }, function () { throw new Error('x'); });
        assert.equal(store.compact().value.evicted.length, 1);
        assert.equal(store.view().strategy.faults['b.fail'].consecutiveFailures, 1);
        assert.equal(store.view().strategy.revision, seen, 'revision unchanged by internal writes');
        assert.equal(store.api().forWriter('observation').apply(seen, [cursorPatch('a1', ROOM, world.tick)]).kind, 'READY', 'sibling not stale');
    });

    test(label + ': a RUNNING migration past its window is cancelled on open; the store reopens', function () {
        const running = { formatVersion: 1, namespace: 'strategy', fromVersion: 1, toVersion: 2, draftVersion: 1, status: 'RUNNING', startedAt: TICK - 20, deadlineTick: TICK - 10, sourceRevision: 3, sourceFingerprint: fingerprint(1), draft: { schemaVersion: 1 }, cancelReason: null, cancelledAt: null, notBefore: null, completedAt: null };
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: F.sampleStrategyRoot(), strategyMigration: running }));
        const source = JSON.stringify(world.raw().strategy);
        const store = world.store();
        const r = store.open(TICK);
        assert.equal(r.value.status, 'OPEN');
        const mem = JSON.parse(world.serialize());
        assert.equal(mem.strategyMigration.status, 'CANCELLED');
        assert.equal(mem.strategyMigration.cancelReason, 'WINDOW_EXPIRED');
        assert.equal(mem.strategyMigration.draft, null);
        assert.equal(mem.strategyMigration.notBefore, TICK + 100);
        assert.equal(JSON.stringify(mem.strategy), source, 'source intact');
        assert.equal(store.apply(3, [F.sampleStatePatches().state]).kind, 'READY');
        // an abandoned v0 migration: cancelled, store stays SUSPENDED with migration REQUIRED
        const w2 = H.createWorld(Object.assign({}, H.LEGACY, { strategy: v0Source() }));
        const s2 = w2.store({ registry: v0Registry() });
        s2.migrator().start(TICK, SAFE);
        w2.nextTick(10);
        const r2 = s2.open(w2.tick);
        assert.equal(r2.evidence.migration, 'REQUIRED');
        assert.equal(JSON.parse(w2.serialize()).strategyMigration.status, 'CANCELLED');
    });

    test(label + ': swap written but DONE not recorded is recovered, not cancelled', function () {
        const { world, store } = migrationWorld();
        const mig = store.migrator();
        mig.start(TICK, SAFE);
        world.nextTick();
        mig.step(world.tick, SAFE);
        // simulate the interrupted swap: source replaced, record still RUNNING
        const rec = JSON.parse(world.serialize()).strategyMigration;
        const draft = M.finalizeSchema1(JSON.parse(JSON.stringify(rec.draft)), rec);
        world.edit(function (m) { m.strategy = draft; });
        world.nextTick();
        const r = world.store({ registry: v0Registry() }).migrator().step(world.tick, SAFE);
        assert.equal(r.kind, 'READY');
        assert.equal(r.value.status, 'DONE');
    });

    test(label + ': boot.router fingerprint uses the state identity, not the whole view', function () {
        const { createStrategyApp } = require('../../../../src/bot/app/StrategyApp');
        const { createLegacyAdapter } = require('../../../../src/bot/integration/LegacyAdapter');
        const { createFakeLegacy } = require('../../support/fakeLegacy');
        const world = H.createWorld(Object.assign({}, H.LEGACY, { strategy: H.richStrategyRoot(), strategyShadow: F.sampleShadowRoot() }));
        const store = world.store();
        const fake = createFakeLegacy();
        const legacy = createLegacyAdapter({ loadModules: fake.loadModules, prepareEnvironment: fake.prepareEnvironment, getGame: function () { return { creeps: {} }; } });
        const ports = { clock: world.clock, cpu: { read: function () { return { used: 1, limit: 20, tickLimit: 500, bucket: 10000, missingFields: [] }; } }, log: Object.assign({ beginTick: function () {} }, world.log) };
        const app = createStrategyApp({ ports: ports, legacy: legacy, listRoomNames: function () { return [ROOM]; }, openState: function (frame) { return store.open(frame.tick); }, stateApi: store.readOnlyApi(), faultStore: store.faultStore() });
        const r1 = app.tick().results['boot.router'];
        world.nextTick();
        const r2 = app.tick().results['boot.router'];
        assert.equal(r1.value.stateSource, 'OPEN');
        assert.equal(r2.inputFingerprint, r1.inputFingerprint, 'unchanged state -> same router input');
        assert.equal(r1.inputFingerprint, fingerprint({ state: store.open(world.tick).inputFingerprint, roomNames: [ROOM] }));
    });

    // ------------------------------------------------------------ composition root
    test(label + ': stageA wiring hands out openState, a read-only services handle and the fault store', function () {
        const { wireStageA } = require('../../../../src/bot/stageA');
        const { createRuntimePorts } = require('../../../../src/bot/app/ports');
        const { createTrapMemory, createTrapGame } = require('../../support/trapRuntime');
        const mem = createTrapMemory(H.LEGACY, { allowedRootKeys: H.STRATEGY_KEYS });
        const game = createTrapGame({ time: TICK });
        const ports = createRuntimePorts({ getGame: function () { return game.Game; }, getMemory: function () { return mem.Memory; }, sink: function () {} });
        const wiring = wireStageA(ports, { buildId: 'b-test', contractVersion: 'A.2', schemaVersion: 1 });
        assert.deepEqual(mem.journal.reads, [], 'wiring reads nothing');
        assert.deepEqual(Object.keys(wiring.stateApi).sort(), ['apply', 'view']);
        assert.equal(wiring.stateApi.apply(0, []).reasonCode, 'INVALID_RECORD');
        const r = wiring.openState({ tick: TICK });
        assert.equal(r.kind, 'READY');
        assert.equal(wiring.stateApi.view().sessionTick, TICK);
        assert.equal(typeof wiring.faultStore.load, 'function');
        assert.deepEqual(mem.journal.writes, []);
    });
}

module.exports = { defineStateTests };
