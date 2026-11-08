// Contract A.2 domain tests. Defined once, executed natively
// (contracts.test.js) and with dist2/mapPatch.js active (contracts-mappatch.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const D = require('../../../../src/bot/domain');
const F = require('../../support/fixtures');

function shuffledCopy(value, seed) {
    // Deterministic key-order permutation of every plain object.
    if (Array.isArray(value)) return value.map(function (v, i) { return shuffledCopy(v, seed + i + 1); });
    if (value === null || typeof value !== 'object') return value;
    const keys = Object.keys(value);
    const rotated = keys.slice(seed % Math.max(keys.length, 1)).concat(keys.slice(0, seed % Math.max(keys.length, 1))).reverse();
    const out = {};
    for (const key of rotated) out[key] = shuffledCopy(value[key], seed * 7 + key.length);
    return out;
}

class GameLike {
    constructor() { this.id = 'x'; this.energy = 5; }
}

function defineContractTests(label) {
    test(label + ': canonical JSON is stable under key permutation', function () {
        const snap = F.sampleSnapshot();
        const a = D.canonicalJson(snap);
        for (let seed = 1; seed < 6; seed++) {
            const permuted = shuffledCopy(snap, seed);
            assert.notDeepEqual(Object.keys(permuted), Object.keys(snap), 'key order really differs');
            assert.equal(D.canonicalJson(permuted), a);
        }
        assert.equal(D.canonicalJson({ b: 1, a: [3, { d: null, c: true }] }), '{"a":[3,{"c":true,"d":null}],"b":1}');
        assert.equal(D.canonicalJson(-0), '0');
        assert.equal(D.canonicalJson(Object.create(null)), '{}');
    });

    test(label + ': canonical JSON rejects non JSON-safe values', function () {
        const cyclic = { a: 1 };
        cyclic.self = cyclic;
        const cases = [
            [undefined, 'UNDEFINED'], [{ a: undefined }, 'UNDEFINED'], [NaN, 'NAN'], [{ x: Infinity }, 'INFINITY'],
            [[-Infinity], 'INFINITY'], [function () {}, 'FUNCTION'], [{ f: function () {} }, 'FUNCTION'],
            [Symbol('s'), 'SYMBOL'], [BigInt(1), 'BIGINT'], [cyclic, 'CYCLE'], [new Map(), 'NON_PLAIN_PROTOTYPE'],
            [new Date(0), 'NON_PLAIN_PROTOTYPE'], [new GameLike(), 'NON_PLAIN_PROTOTYPE'], [[1, , 3], 'ARRAY_HOLE'], // eslint-disable-line no-sparse-arrays
        ];
        for (const [value, code] of cases) {
            assert.throws(function () { D.canonicalJson(value); }, function (error) { return error instanceof D.CanonicalError && error.code === code; }, code);
            assert.equal(D.isJsonSafe(value), false);
        }
        const shared = { k: 1 };
        assert.equal(D.canonicalJson({ a: shared, b: shared }), '{"a":{"k":1},"b":{"k":1}}', 'shared (non-cyclic) references are fine');
    });

    test(label + ': fingerprint is FNV-1a 64 and stable', function () {
        assert.equal(D.fnv1a64Hex(''), 'cbf29ce484222325');
        assert.equal(D.fnv1a64Hex('a'), 'af63dc4c8601ec8c');
        assert.equal(D.fnv1a64Hex('foobar'), '85944171f73967e8');
        const snap = F.sampleSnapshot();
        const fp = D.fingerprint(snap);
        assert.match(fp, D.FINGERPRINT_PATTERN);
        assert.equal(D.fingerprint(shuffledCopy(snap, 3)), fp);
        assert.equal(D.fingerprint(JSON.parse(JSON.stringify(snap))), fp);
        assert.notEqual(D.fingerprint({ a: 1 }), D.fingerprint({ a: 2 }));
        assert.equal(D.fingerprint({ s: 'жук😀' }), D.fingerprint({ s: 'жук😀' }));
        // Known value pins the algorithm: changing it is a contract change.
        assert.equal(D.fingerprint({ b: [1, 2], a: 'x' }), 'fnv1a64:' + D.fnv1a64Hex('{"a":"x","b":[1,2]}'));
    });

    test(label + ': operationKey round-trip including separators', function () {
        const parts = { domain: 'W1N1', ownerEpoch: 7, demandStableKey: 'W1N1/feeding/spawn%1', generation: 2, action: 'spawn', occurrence: '0' };
        const key = D.buildOperationKey(parts);
        assert.equal(key, 'W1N1/7/W1N1%2Ffeeding%2Fspawn%251/2/spawn/0');
        assert.deepEqual(D.parseOperationKey(key), parts);
        const tricky = { domain: 'empire', ownerEpoch: 0, demandStableKey: '%2F/%25//', generation: 0, action: 'transfer', occurrence: 'asg/1#4' };
        const trickyKey = D.buildOperationKey(tricky);
        assert.equal(trickyKey.split('/').length, 6);
        assert.deepEqual(D.parseOperationKey(trickyKey), tricky);
        assert.equal(D.buildOperationKey(D.parseOperationKey(trickyKey)), trickyKey);
        assert.deepEqual(D.parseOperationKey(D.buildOperationKey(Object.assign({}, parts, { occurrence: 3 }))).occurrence, '3');
        for (const bad of ['a/b', 'W1N1/x/k/2/spawn/0', 'W1N1/07/k/2/spawn/0', 'W1N1/7/k/2/spawn/', 'W1N1/7/%zz/2/spawn/0', 'W1N1/-1/k/2/spawn/0']) {
            assert.throws(function () { D.parseOperationKey(bad); }, TypeError, bad);
            assert.equal(D.isOperationKey(bad), false);
        }
        assert.throws(function () { D.buildOperationKey(Object.assign({}, parts, { generation: 1.5 })); }, TypeError);
        assert.throws(function () { D.buildOperationKey(Object.assign({}, parts, { action: '' })); }, TypeError);
    });

    test(label + ': eventKey, short names and positions', function () {
        const key = D.eventKey('W5N8', 999, 3);
        assert.equal(key, 'ev:W5N8:999:3');
        assert.deepEqual(D.parseEventKey(key), { roomName: 'W5N8', effectTick: 999, originalArrayIndex: 3 });
        assert.notEqual(D.eventKey('W5N8', 999, 3), D.eventKey('W5N8', 999, 4), 'same content on another index is another event');
        assert.throws(function () { D.eventKey('nowhere', 1, 0); }, TypeError);
        assert.throws(function () { D.parseEventKey('ev:W5N8:01:0'); }, TypeError);

        const opKey = F.sampleOperationKey();
        const name = D.shortCreepName(opKey);
        assert.match(name, /^s_[0-9a-f]{12}$/);
        assert.equal(D.shortCreepName(opKey), name, 'deterministic');
        assert.notEqual(D.shortCreepName(opKey.replace('/2/', '/3/')), name);
        assert.match(D.shortCreepName(opKey, 'fd'), /^fd_[0-9a-f]{12}$/);
        assert.throws(function () { D.shortCreepName(opKey, 'Bad!'); }, TypeError);

        const p = D.makePosition('W5N8', 0, 49);
        assert.deepEqual(p, { roomName: 'W5N8', x: 0, y: 49 });
        assert.equal(D.isPosition(p), true);
        assert.equal(D.positionKey(p), 'W5N8:0:49');
        assert.throws(function () { D.makePosition('W5N8', 50, 0); }, TypeError);
        function RoomPosition(x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; }
        assert.equal(D.isPosition(new RoomPosition(1, 1, 'W5N8')), false, 'RoomPosition prototype is not a plain position');
        assert.equal(D.isPosition({ roomName: 'W5N8', x: 1, y: 1, extra: 1 }), false);
    });

    test(label + ': results are plain, validated and distinguishable after JSON round-trip', function () {
        const fp = D.fingerprint({ input: 1 });
        const ready = D.READY({ amount: 0 }, fp);
        const unknown = D.UNKNOWN('MISSING_FIELD', ['b', 'a', 'b']);
        const deferred = D.DEFERRED({ room: 'W5N8' }, 'BUDGET_DEFERRED');
        const rejected = D.REJECTED('UNSUPPORTED_CAPABILITY', { requestedMode: 'adaptive-v1' });
        assert.deepEqual(unknown.missingFields, ['a', 'b']);
        for (const r of [ready, unknown, deferred, rejected]) {
            const copy = JSON.parse(JSON.stringify(r));
            assert.deepEqual(copy, JSON.parse(D.canonicalJson(r)));
            assert.deepEqual(D.validateResult(copy), { ok: true });
            assert.equal(D.isResult(copy), true);
        }
        const readyCopy = JSON.parse(JSON.stringify(ready));
        const unknownCopy = JSON.parse(JSON.stringify(unknown));
        assert.equal(D.isReady(readyCopy), true);
        assert.equal(D.isUnknown(readyCopy), false);
        assert.equal(D.isUnknown(unknownCopy), true);
        assert.equal(D.isReady(unknownCopy), false);
        assert.equal(readyCopy.value.amount, 0, 'READY zero stays a value');
        assert.equal(Object.prototype.hasOwnProperty.call(unknownCopy, 'value'), false, 'UNKNOWN has no value field to mistake for 0');

        assert.throws(function () { D.READY(undefined, fp); }, TypeError);
        assert.throws(function () { D.READY(1, 'not-a-fingerprint'); }, TypeError);
        assert.throws(function () { D.DEFERRED(null, 'NOT_A_CODE'); }, TypeError);
        assert.throws(function () { D.REJECTED('STALE_OWNER', { x: NaN }); }, TypeError);
        assert.throws(function () { D.REJECTED('STALE_OWNER', new GameLike()); }, TypeError);
        assert.throws(function () { D.UNKNOWN('MISSING_FIELD', [1]); }, TypeError);
        assert.equal(D.validateResult({ kind: 'READY', value: 1 }).ok, false);
        assert.equal(D.validateResult({ kind: 'MAYBE' }).ok, false);
    });

    test(label + ': reason codes and enums are frozen', function () {
        for (const code of ['STALE_OWNER', 'STALE_INPUT', 'NO_VISIBILITY', 'INSUFFICIENT_LIQUIDITY', 'CRITICAL_DEADLINE', 'BUDGET_DEFERRED', 'AMBIGUOUS_EFFECT', 'INCOMPATIBLE_SCHEMA', 'UNSUPPORTED_CAPABILITY', 'LEGACY_BINDING_CONFLICT', 'EVENT_GAP', 'UNEXPLAINED_BALANCE', 'UNCERTAIN_FUNDING', 'SHADOW_ONLY', 'NO_HISTORY']) {
            assert.equal(D.isReasonCode(code), true, code);
        }
        assert.equal(Object.isFrozen(D.ReasonCode), true);
        assert.equal(Object.isFrozen(D.OperationState), true);
        assert.equal(D.canTransition(D.OPERATION_TRANSITIONS, 'ISSUED', 'CONFIRMED'), true);
        assert.equal(D.canTransition(D.OPERATION_TRANSITIONS, 'UNKNOWN', 'UNKNOWN_RETIRED'), true);
        assert.equal(D.canTransition(D.OPERATION_TRANSITIONS, 'ISSUED', 'UNKNOWN_RETIRED'), false, 'retire only from UNKNOWN');
        assert.equal(D.canTransition(D.OPERATION_TRANSITIONS, 'CONFIRMED', 'ISSUED'), false);
        assert.equal(D.canTransition(D.RESERVATION_TRANSITIONS, 'ISSUED', 'PARTIAL'), true);
        assert.equal(D.canTransition(D.RESERVATION_TRANSITIONS, 'SETTLED', 'RELEASED'), false);
    });

    test(label + ': every sample DTO validates', function () {
        const pairs = [
            ['validateSnapshot', F.sampleSnapshot], ['validateRoomSnapshot', F.sampleRoomSnapshot], ['validateCreepSnapshot', F.sampleCreep],
            ['validateNormalizedEvent', F.sampleNormalizedEvent], ['validateCallReceipt', F.sampleCallReceipt], ['validateEffectResult', F.sampleEffectResult],
            ['validateOperation', F.sampleOperation], ['validateReservation', F.sampleReservation], ['validateDemand', F.sampleDemand],
            ['validateProposal', F.sampleProposal], ['validateDecisionRecord', F.sampleDecisionRecord], ['validateControlRecord', F.sampleControlRecord],
            ['validateStateView', F.sampleStateView], ['validateReplayFixtureHeader', F.sampleReplayFixtureHeader],
            ['validateDemandOption', F.sampleDemandOption], ['validateEventCursor', F.sampleEventCursor], ['validateFlowDelta', F.sampleFlowDelta],
            ['validateFlowWindow', F.sampleFlowWindow], ['validateBinding', F.sampleBinding], ['validateObservedBinding', F.sampleObservedBinding],
            ['validateObservedOperation', F.sampleObservedOperation], ['validateCalendar', F.sampleCalendar], ['validateLedgerView', F.sampleLedgerView],
            ['validateReplacementPlan', F.sampleReplacementPlan], ['validateForecastSummary', F.sampleForecastSummary],
            ['validateReconciliationPatch', F.sampleReconciliationPatch], ['validateReplayFixture', F.sampleReplayFixture],
            ['validateShadowRoot', F.sampleShadowRoot], ['validateStrategyRoot', F.sampleStrategyRoot],
        ];
        for (const [name, make] of pairs) {
            assert.deepEqual(D[name](make()), { ok: true }, name);
            assert.deepEqual(D[name](JSON.parse(JSON.stringify(make()))), { ok: true }, name + ' after JSON round-trip');
        }
        assert.deepEqual(D.validateSnapshot(F.sampleSnapshot(), { checkFingerprint: true }), { ok: true });
    });

    test(label + ': validators reject Game-like objects, NaN and undefined in required fields', function () {
        function codes(result) { return result.ok ? [] : result.errors.map(function (e) { return e.code; }); }

        const snap = F.sampleSnapshot();
        snap.rooms.W5N8.controller = Object.assign(new GameLike(), snap.rooms.W5N8.controller);
        assert.ok(codes(D.validateSnapshot(snap)).indexOf('NON_PLAIN_PROTOTYPE') !== -1);

        const creep = F.sampleCreep();
        function RoomPosition(x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; }
        creep.pos = new RoomPosition(1, 1, 'W5N8');
        assert.ok(codes(D.validateCreepSnapshot(creep)).indexOf('BAD_POSITION') !== -1);

        const room = F.sampleRoomSnapshot();
        room.energyNodes = new Map();
        assert.ok(codes(D.validateRoomSnapshot(room)).indexOf('NON_PLAIN_PROTOTYPE') !== -1);

        const op = F.sampleOperation();
        op.confirmedAmount = NaN;
        assert.ok(codes(D.validateOperation(op)).indexOf('NAN') !== -1);

        const res = F.sampleReservation();
        res.amount = undefined;
        assert.ok(codes(D.validateReservation(res)).indexOf('REQUIRED') !== -1);

        const res2 = F.sampleReservation();
        delete res2.kind;
        assert.ok(codes(D.validateReservation(res2)).indexOf('REQUIRED') !== -1);

        const demand = F.sampleDemand();
        demand.amount = Infinity;
        assert.ok(codes(D.validateDemand(demand)).indexOf('INFINITY') !== -1);

        const ev = F.sampleNormalizedEvent();
        ev.amount = { value: 0, quality: 'UNKNOWN', reason: 'MISSING_FIELD' };
        assert.ok(codes(D.validateNormalizedEvent(ev)).indexOf('UNKNOWN_WITH_VALUE') !== -1, 'unknown cannot carry a zero');
        const ev2 = F.sampleNormalizedEvent();
        ev2.amount = { value: null, quality: 'OBSERVED', reason: null };
        assert.ok(codes(D.validateNormalizedEvent(ev2)).indexOf('NULL_VALUE_NOT_UNKNOWN') !== -1);
        const ev3 = F.sampleNormalizedEvent();
        ev3.eventKey = D.eventKey('W5N8', 999, 1);
        assert.ok(codes(D.validateNormalizedEvent(ev3)).indexOf('KEY_MISMATCH') !== -1);

        const extra = F.sampleDemand();
        extra.surprise = 1;
        assert.ok(codes(D.validateDemand(extra)).indexOf('UNKNOWN_FIELD') !== -1);

        const decision = F.sampleDecisionRecord();
        decision.executed = true;
        assert.ok(codes(D.validateDecisionRecord(decision)).indexOf('SHADOW_EXECUTED') !== -1);

        const receipt = F.sampleCallReceipt();
        receipt.kind = 'OK';
        assert.ok(codes(D.validateCallReceipt(receipt)).indexOf('BAD_ENUM') !== -1, 'receipts are RETURNED/THREW only');

        const confirmed = F.sampleOperation();
        confirmed.state = 'CONFIRMED';
        assert.ok(codes(D.validateOperation(confirmed)).indexOf('CONFIRMED_WITHOUT_EFFECT') !== -1, 'OK is not an effect');

        const move = F.sampleReservation();
        move.kind = 'MOVE';
        assert.ok(codes(D.validateReservation(move)).indexOf('MOVE_WITHOUT_TARGET') !== -1);

        const unsorted = F.sampleRoomSnapshot();
        unsorted.energyNodes.reverse();
        assert.ok(codes(D.validateRoomSnapshot(unsorted)).indexOf('NOT_SORTED_UNIQUE') !== -1);

        const wrongClass = F.sampleRoomSnapshot();
        wrongClass.energyNodes[0].objectType = 'storage';
        assert.ok(codes(D.validateRoomSnapshot(wrongClass)).indexOf('OBJECT_TYPE_NOT_IN_CLASS') !== -1);

        const dup = F.sampleSnapshot();
        dup.rooms.W5N9 = Object.assign(F.sampleRoomSnapshot(), { roomName: 'W5N9' });
        assert.ok(codes(D.validateSnapshot(dup)).indexOf('DUPLICATE_ENERGY_NODE') !== -1, 'each energy unit counted once');

        const tampered = F.sampleSnapshot();
        tampered.rooms.W5N8.energyAvailable = D.measured(299);
        assert.ok(codes(D.validateSnapshot(tampered, { checkFingerprint: true })).indexOf('FINGERPRINT_MISMATCH') !== -1);

        const extraProp = F.sampleRoomSnapshot();
        extraProp.spawns.note = 'x';
        assert.ok(codes(D.validateRoomSnapshot(extraProp)).indexOf('ARRAY_EXTRA_PROPERTY') !== -1);
    });

    test(label + ': snapshot fingerprint ignores volatile cpu readings', function () {
        const a = F.sampleSnapshot();
        const b = F.sampleSnapshot();
        b.cpu.used = D.measured(17.25);
        b.cpu.bucket = D.measured(42);
        assert.deepEqual(D.SNAPSHOT_FINGERPRINT_EXCLUDED, ['fingerprint', 'cpu']);
        assert.equal(D.snapshotFingerprint(a), D.snapshotFingerprint(b));
        assert.deepEqual(D.validateSnapshot(b, { checkFingerprint: true }), { ok: true });
    });

    test(label + ': A.2 transitions, disputed reservations and spawn pool', function () {
        const T = D.OPERATION_TRANSITIONS;
        assert.equal(D.canTransition(T, 'NO_EFFECT', 'ISSUED'), true, 'retry same key, new commandId');
        assert.equal(D.canTransition(T, 'UNKNOWN', 'UNKNOWN'), true, 'partial confirmedAmount update');
        assert.equal(D.canTransition(T, 'UNKNOWN', 'ISSUED'), false, 'no blind repeat');
        assert.deepEqual(T.CONFIRMED, []);
        assert.deepEqual(T.UNKNOWN_RETIRED, []);
        assert.equal(D.canTransition(D.RESERVATION_TRANSITIONS, 'ISSUED', 'RETIRED'), true);

        const r = F.sampleReservation();
        assert.equal(r.nodeId, 'spawnPool:W5N8');
        assert.equal(D.spawnPoolRoom(r.nodeId), 'W5N8');
        assert.equal(D.spawnPoolRoom('creep:h1'), null);
        r.state = 'ISSUED';
        r.unknownAmount = 150;
        assert.deepEqual(D.validateReservation(r), { ok: true });
        assert.equal(D.isDisputedReservation(r), true);
        r.state = 'RETIRED';
        assert.deepEqual(D.validateReservation(r), { ok: true }, 'retired: unknown upper bound stays recorded');
        assert.equal(D.isDisputedReservation(r), false);
        r.state = 'SETTLED';
        assert.ok(codes(D.validateReservation(r)).indexOf('CLOSED_WITH_DISPUTE') !== -1);
        r.state = 'RETIRED'; r.unknownAmount = 0; r.releasedAmount = 150;
        assert.ok(codes(D.validateReservation(r)).indexOf('RETIRED_WITHOUT_UNKNOWN') !== -1);
        function codes(result) { return result.ok ? [] : result.errors.map(function (e) { return e.code; }); }
    });

    test(label + ': cross-worker DTO invariants', function () {
        function codes(result) { return result.ok ? [] : result.errors.map(function (e) { return e.code; }); }
        const ev = F.sampleNormalizedEvent();
        ev.energyAmount = D.measured(49);
        assert.ok(codes(D.validateNormalizedEvent(ev)).indexOf('ENERGY_AMOUNT_MISMATCH') !== -1);
        const build = F.sampleNormalizedEvent();
        build.type = 'BUILD'; build.amount = D.measured(10); build.energyAmount = D.unknownMeasure('MISSING_FIELD');
        assert.deepEqual(D.validateNormalizedEvent(build), { ok: true }, 'BUILD progress and energy are separate');

        const w = F.sampleFlowWindow();
        w.ticksCovered = 99;
        assert.ok(codes(D.validateFlowWindow(w)).indexOf('COMPLETE_WITH_GAPS') !== -1);
        const w2 = F.sampleFlowWindow();
        w2.windowStart = 950; w2.windowEnd = 1050;
        assert.ok(codes(D.validateFlowWindow(w2)).indexOf('NOT_WINDOW_ALIGNED') !== -1);
        const d = F.sampleFlowDelta();
        delete d.flows.internalTransfer;
        assert.ok(codes(D.validateFlowDelta(d)).indexOf('REQUIRED') !== -1);

        const ob = F.sampleObservedBinding();
        ob.homeRoom = null;
        assert.ok(codes(D.validateObservedBinding(ob)).indexOf('HOME_SOURCE_MISMATCH') !== -1);

        const cal = F.sampleCalendar();
        cal.entries.reverse();
        assert.ok(codes(D.validateCalendar(cal)).indexOf('NOT_SORTED_UNIQUE') !== -1);

        const lv = F.sampleLedgerView();
        lv.nodes[0].free = D.measured(300);
        assert.ok(codes(D.validateLedgerView(lv)).indexOf('FREE_NOT_BALANCED') !== -1);

        const prop = F.sampleProposal();
        prop.missionPatches = [{}];
        assert.ok(codes(D.validateProposal(prop)).indexOf('TOO_LONG') !== -1, 'missionPatches empty in stage A');
        const dem = F.sampleDemand();
        dem.options = [{ body: ['carry'] }];
        assert.ok(codes(D.validateDemand(dem)).indexOf('REQUIRED') !== -1, 'options are DemandOption');

        const fx = F.sampleReplayFixture();
        fx.body.expectedReasonCodes = ['NO_HISTORY'];
        assert.ok(codes(D.validateReplayFixture(fx)).indexOf('FINGERPRINT_MISMATCH') !== -1);
    });

    test(label + ': state layout, patch ownership and stage-A emptiness', function () {
        function codes(result) { return result.ok ? [] : result.errors.map(function (e) { return e.code; }); }
        const patches = F.sampleStatePatches();
        for (const writer of Object.keys(patches)) assert.deepEqual(D.validateStatePatch(patches[writer]), { ok: true }, writer);
        assert.equal(D.patchOwner('strategyShadow', ['rooms', 'W5N8', 'flowWindows']), 'observation');
        assert.equal(D.patchOwner('strategyShadow', ['rooms', 'W5N8', 'observedBindings', 'h1']), 'observation');
        assert.equal(D.patchOwner('strategyShadow', ['observedOperations', 'k']), 'observation');
        assert.equal(D.patchOwner('strategyShadow', ['rooms', 'W5N8', 'forecast']), 'finance');
        assert.equal(D.patchOwner('strategyShadow', ['ledger', 'reservations', 'r1']), 'finance');
        assert.equal(D.patchOwner('strategyShadow', ['rooms', 'W5N8', 'decisionRing']), 'planning');
        assert.equal(D.patchOwner('strategyShadow', ['proposals', 'p']), 'planning');
        assert.equal(D.patchOwner('strategy', ['faults', 'x']), 'state');
        assert.equal(D.patchOwner('strategy', ['revision']), null, 'meta is StateStore-internal');
        assert.equal(D.patchOwner('strategy', ['operations', 'k']), null, 'adaptive keys not patchable in stage A');
        assert.equal(D.patchOwner('strategyShadow', ['rooms', 'bogus', 'forecast']), null);

        const stolen = Object.assign({}, patches.finance, { writer: 'planning' });
        assert.ok(codes(D.validateStatePatch(stolen)).indexOf('NOT_PATH_OWNER') !== -1);
        const wrongRoom = JSON.parse(JSON.stringify(patches.observation));
        wrongRoom.path[1] = 'W1N1';
        assert.ok(codes(D.validateStatePatch(wrongRoom)).indexOf('ROOM_MISMATCH') !== -1);
        const del = { patchId: 'd', writer: 'observation', namespace: 'strategyShadow', path: ['rooms', 'W5N8', 'eventCursor'], op: 'delete' };
        assert.ok(codes(D.validateStatePatch(del)).indexOf('NOT_DELETABLE') !== -1);
        const badValue = Object.assign({}, patches.finance, { value: { roomName: 'W5N8' } });
        assert.ok(codes(D.validateStatePatch(badValue)).indexOf('REQUIRED') !== -1);
        const rp = F.sampleReconciliationPatch();
        rp.patches.push(patches.finance);
        assert.ok(codes(D.validateReconciliationPatch(rp)).indexOf('NOT_PATH_OWNER') !== -1);

        const root = F.sampleStrategyRoot();
        root.operations[F.sampleOperationKey()] = F.sampleOperation();
        assert.deepEqual(D.validateStrategyRoot(root), { ok: true });
        assert.ok(codes(D.validateStrategyRoot(root, { stage: 'A' })).indexOf('STAGE_A_NOT_EMPTY') !== -1);
        assert.deepEqual(D.validateShadowRoot(D.emptyShadowRoot()), { ok: true });
        const big = F.sampleShadowRoot();
        for (let i = 0; i < 31; i++) big.rooms.W5N8.flowWindows.push(F.sampleFlowWindow());
        assert.ok(codes(D.validateShadowRoot(big)).indexOf('TOO_LONG') !== -1);
    });

    test(label + ': deepFreeze validates the whole graph before freezing anything', function () {
        const mixed = { a: { b: 1 }, z: new GameLike() };
        assert.throws(function () { D.deepFreeze(mixed); }, TypeError);
        assert.equal(Object.isFrozen(mixed), false);
        assert.equal(Object.isFrozen(mixed.a), false, 'no partial freeze');
    });

    test(label + ': canonical JSON rejects arrays with extra properties', function () {
        const arr = [1, 2];
        arr.extra = true;
        assert.throws(function () { D.canonicalJson(arr); }, function (e) { return e.code === 'ARRAY_EXTRA_PROPERTY'; });
    });

    test(label + ': deepFreeze freezes plain data and refuses Game-like objects', function () {
        const snap = D.deepFreeze(F.sampleSnapshot());
        assert.equal(Object.isFrozen(snap.rooms.W5N8.energyNodes[0].amount), true);
        assert.throws(function () { 'use strict'; snap.rooms.W5N8.tick = 1; }, TypeError);
        assert.throws(function () { D.deepFreeze({ a: new GameLike() }); }, TypeError);
        const cyclic = { a: {} };
        cyclic.a.back = cyclic;
        assert.equal(Object.isFrozen(D.deepFreeze(cyclic).a), true);
    });
}

module.exports = { defineContractTests };
