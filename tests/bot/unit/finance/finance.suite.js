// A4 finance tests (BudgetLedger, ReplacementForecast, ForecastCalendar,
// EconomyModel). Shared by finance.test.js (native) and
// finance-mappatch.test.js (dist2/mapPatch.js active).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const F = require('../../support/fixtures');
const { measured, unknownMeasure, snapshotFingerprint, validateSnapshot, validateLedgerView, validateReplacementPlan, validateCalendar, validateForecastSummary, validateReservation } = require('../../../../src/bot/domain/dtos');
const { spawnPoolNodeId, buildOperationKey, parseOperationKey } = require('../../../../src/bot/domain/keys');
const { validateStatePatch } = require('../../../../src/bot/domain/stateLayout');
const Ledger = require('../../../../src/bot/scheduling/BudgetLedger');
const Replacement = require('../../../../src/bot/models/ReplacementForecast');
const Calendar = require('../../../../src/bot/models/ForecastCalendar');
const Economy = require('../../../../src/bot/models/EconomyModel');

const ROOM = F.ROOM;
const POOL = spawnPoolNodeId(ROOM);
const CALC = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../docs/strategy/calculations.json'), 'utf8'));

function pos(x, y) { return { roomName: ROOM, x: x, y: y }; }
function part(type) { return { type: type, boost: null, hits: 100 }; }
function est(v) { return measured(v, 'ESTIMATED'); }

function node(nodeId, nodeClass, objectType, amount) {
    return { nodeId: nodeId, nodeClass: nodeClass, objectType: objectType, roomName: ROOM, pos: pos(1, 1), amount: typeof amount === 'number' ? measured(amount) : amount, capacity: measured(5000) };
}

function creep(name, body, ttl, extra) {
    return Object.assign({
        name: name, id: 'id-' + name, roomName: ROOM, pos: pos(10, 10), spawning: false,
        body: body.map(part), ticksToLive: typeof ttl === 'number' ? measured(ttl) : ttl,
        store: { energy: measured(0), capacity: measured(50) }, legacyRole: null, strategyEnvelope: null,
    }, extra || {});
}

/**
 * Valid Snapshot of one room.
 * @param {{tick?:number, energyAvailable?:object|number, capacity?:number, nodes?:object[], creeps?:object[], spawning?:object|null, sources?:object[]}} o
 */
function snap(o) {
    const s = F.sampleSnapshot();
    const tick = o.tick === undefined ? F.TICK : o.tick;
    const room = s.rooms[ROOM];
    s.tick = tick;
    room.tick = tick;
    room.eventLog = { effectTick: tick - 1, observedAt: tick, status: 'NOT_VISIBLE', rawLength: null, rawFingerprint: null, entries: null };
    room.energyAvailable = o.energyAvailable === undefined ? measured(300) : typeof o.energyAvailable === 'number' ? measured(o.energyAvailable) : o.energyAvailable;
    room.energyCapacityAvailable = measured(o.capacity === undefined ? 800 : o.capacity);
    const nodes = o.nodes || [node('spawn1id', 'SPAWN_EXTENSION', 'spawn', room.energyAvailable)];
    room.energyNodes = nodes.slice().sort(function (a, b) { return a.nodeId < b.nodeId ? -1 : 1; });
    room.spawns = [{ id: 'spawn1id', name: 'Spawn1', roomName: ROOM, pos: pos(20, 20), spawning: o.spawning === undefined ? null : o.spawning }];
    if (o.sources) room.sources = o.sources;
    s.ownCreeps = {};
    for (const c of o.creeps || []) s.ownCreeps[c.name] = c;
    s.fingerprint = snapshotFingerprint(s);
    const v = validateSnapshot(s, { checkFingerprint: true });
    assert.deepEqual(v, { ok: true }, 'test snapshot must be valid: ' + JSON.stringify(v.errors));
    return s;
}

function reservation(o) {
    const r = Object.assign(F.sampleReservation(), { reservationId: 'r1', operationKey: null, amount: 200, dueAt: null }, o || {});
    assert.deepEqual(validateReservation(r), { ok: true }, JSON.stringify(validateReservation(r).errors));
    return r;
}

function proposal(requests, overrides) {
    const d = Object.assign(F.sampleDemand(), { criticality: 'REQUIRED' });
    return Object.assign(F.sampleProposal(), { proposalId: 'p1', expectedRevision: null, demands: [d], reservationRequests: requests }, overrides || {});
}

function nodeOf(view, id) {
    return view.nodes.filter(function (n) { return n.nodeId === id; })[0];
}

function demand(o) {
    return Object.assign(F.sampleDemand(), { stableKey: ROOM + '/pay/one', generation: 0, requiredBy: 200, earliestStart: null, criticality: 'CRITICAL', createdAt: 0,
        options: [{ body: ['claim'], cost: 600, spawnTime: 0, provides: 1, travelTime: measured(0) }] }, o || {});
}

function window(start, harvest, extra) {
    const w = F.sampleFlowWindow();
    w.windowStart = start;
    w.windowEnd = start + 100;
    for (const k of Object.keys(w.flows)) w.flows[k] = measured(0);
    w.flows.harvest = measured(harvest);
    Object.assign(w, extra || {});
    return w;
}

function defineFinanceTests(label) {
    // ------------------------------------------------------------ BudgetLedger

    test(label + ': ledger free = observed − active reservations of the node, incl. spawnPool', function () {
        const s = snap({ energyAvailable: 300, nodes: [node('spawn1id', 'SPAWN_EXTENSION', 'spawn', 300), node('storage1', 'STORAGE_CONTAINER', 'storage', 1000)] });
        const view = Ledger.createLedgerView(s, [reservation({ nodeId: POOL, amount: 200 }), reservation({ reservationId: 'r2', nodeId: 'storage1', amount: 100, roomName: ROOM })]);
        assert.deepEqual(validateLedgerView(view), { ok: true });
        assert.equal(nodeOf(view, POOL).observed.value, 300);
        assert.equal(nodeOf(view, POOL).free.value, 100);
        assert.equal(nodeOf(view, 'storage1').free.value, 900);
        assert.equal(nodeOf(view, 'spawn1id').free.value, 300, 'pool reservation does not touch the individual node');
    });

    test(label + ': MOVE holds its source and never creates energy at the target', function () {
        const s = snap({ nodes: [node('spawn1id', 'SPAWN_EXTENSION', 'spawn', 300), node('storage1', 'STORAGE_CONTAINER', 'storage', 1000)] });
        const move = reservation({ kind: 'MOVE', nodeId: 'storage1', targetNodeId: POOL, amount: 400 });
        const view = Ledger.createLedgerView(s, [move]);
        assert.equal(nodeOf(view, 'storage1').free.value, 600);
        assert.equal(nodeOf(view, POOL).free.value, 300, 'target pool not increased by a promise');
        const liq = Ledger.liquidity(s, view);
        assert.equal(liq.observed.value, 1300, 'spawn pool + storage, the individual spawn node is inside the pool');
    });

    test(label + ': confirmed spawn removes the promise without subtracting from the snapshot again', function () {
        const before = snap({ energyAvailable: 300 });
        let r = reservation({ nodeId: POOL, amount: 200 });
        assert.equal(nodeOf(Ledger.createLedgerView(before, [r]), POOL).free.value, 100);
        r = Ledger.issue(r, F.TICK).value;
        const after = snap({ tick: F.TICK + 1, energyAvailable: 100 });
        const settled = Ledger.applySettlement(r, { tick: F.TICK + 1, actor: 'Spawn1', action: 'spawn', target: null, amount: 200 }, [], F.TICK + 1);
        assert.equal(settled.kind, 'READY');
        assert.equal(settled.value.reservation.state, 'SETTLED');
        assert.equal(nodeOf(Ledger.createLedgerView(after, [settled.value.reservation]), POOL).free.value, 100, 'not 100 − 200');
    });

    test(label + ': repeated confirmation of the same (tick, actor, action, target) never double-charges', function () {
        let r = Ledger.issue(reservation({ nodeId: POOL, amount: 200 }), F.TICK).value;
        const c = { tick: F.TICK + 1, actor: 'mule1', action: 'transfer', target: 'spawn1id', amount: 50 };
        const first = Ledger.applySettlement(r, c, [], F.TICK + 1).value;
        assert.equal(first.charged, 50);
        assert.equal(first.reservation.state, 'PARTIAL');
        const again = Ledger.applySettlement(first.reservation, c, first.appliedKeys, F.TICK + 2).value;
        assert.equal(again.charged, 0);
        assert.equal(again.reservation.settledAmount, 50);
        const other = Ledger.applySettlement(again.reservation, Object.assign({}, c, { tick: F.TICK + 2, amount: 150 }), again.appliedKeys, F.TICK + 2).value;
        assert.equal(other.reservation.state, 'SETTLED');
        assert.equal(other.reservation.settledAmount, 200);
        assert.equal(validateReservation(other.reservation).ok, true);
    });

    test(label + ': future income never grants spending now', function () {
        const s = snap({ energyAvailable: 100 });
        const view = Ledger.createLedgerView(s, []);
        const ctx = { tick: F.TICK, revision: 3, expectedIncome: 100000 };
        const r = Ledger.admit(ctx, proposal([{ kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 150, dueAt: F.TICK + 500 }]), view);
        assert.equal(r.kind, 'REJECTED');
        assert.equal(r.reasonCode, 'INSUFFICIENT_LIQUIDITY');
        // Sequential: two requests of 60 on 100 free -> the second fails.
        const two = Ledger.admit(ctx, proposal([
            { kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 60, dueAt: null },
            { kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 60, dueAt: null },
        ]), view);
        assert.equal(two.reasonCode, 'INSUFFICIENT_LIQUIDITY');
        const ok = Ledger.admit(ctx, proposal([{ kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 100, dueAt: null }]), view);
        assert.equal(ok.kind, 'READY');
        assert.equal(ok.value.reservations[0].state, 'RESERVED');
        assert.equal(ok.value.expectedRevision, 3);
    });

    test(label + ': disputed reservation blocks optional spend of the node, not emergency', function () {
        const s = snap({ energyAvailable: 1000 });
        let r = Ledger.issue(reservation({ nodeId: POOL, amount: 200 }), F.TICK).value;
        r = Ledger.markUnknown(r, 200, F.TICK + 1).value;
        const view = Ledger.createLedgerView(s, [r]);
        assert.equal(nodeOf(view, POOL).disputed, 200);
        assert.equal(nodeOf(view, POOL).free.value, 800);
        const req = [{ kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 100, dueAt: null }];
        const opt = Ledger.admit({ tick: F.TICK }, proposal(req), view);
        assert.equal(opt.reasonCode, 'UNCERTAIN_FUNDING');
        assert.equal(Ledger.admit({ tick: F.TICK, emergency: true }, proposal(req), view).kind, 'READY');
        assert.equal(Ledger.admit({ tick: F.TICK }, proposal(req, { demands: [F.sampleDemand()] }), view).kind, 'READY', 'CRITICAL demand passes');
        assert.equal(Ledger.release(r, F.TICK + 2).reasonCode, 'UNCERTAIN_FUNDING', 'disputed part is not silently released');
        assert.equal(Ledger.admit({ tick: F.TICK, domainStatus: 'UNCERTAIN_FUNDING' }, proposal(req), Ledger.createLedgerView(s, [])).reasonCode, 'UNCERTAIN_FUNDING');
    });

    test(label + ': RETIRED stops holding the node but its upper bound still counts against the mission limit', function () {
        const s = snap({ energyAvailable: 1000 });
        let r = Ledger.issue(reservation({ nodeId: POOL, amount: 300, missionId: 'm1' }), F.TICK).value;
        r = Ledger.markUnknown(r, 300, F.TICK + 1).value;
        r = Ledger.retire(r, F.TICK + 2).value;
        assert.equal(r.state, 'RETIRED');
        assert.equal(validateReservation(r).ok, true);
        const view = Ledger.createLedgerView(s, [r]);
        assert.equal(nodeOf(view, POOL).free.value, 1000);
        assert.equal(Ledger.missionExposure([r], 'm1'), 300);
        const req = [{ kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 300, dueAt: null }];
        const rej = Ledger.admit({ tick: F.TICK, existingReservations: [r], missionLimits: { m1: 500 } }, proposal(req, { missionId: 'm1' }), view);
        assert.equal(rej.reasonCode, 'INSUFFICIENT_LIQUIDITY');
        assert.equal(rej.evidence.reason, 'MISSION_LIMIT');
    });

    test(label + ': stale revision rejected; re-admission of the same proposal charges nothing', function () {
        const s = snap({ energyAvailable: 300 });
        const req = [{ kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 200, dueAt: null }];
        assert.equal(Ledger.admit({ tick: F.TICK, revision: 4 }, proposal(req, { expectedRevision: 3 }), Ledger.createLedgerView(s, [])).reasonCode, 'STALE_INPUT');
        const first = Ledger.admit({ tick: F.TICK }, proposal(req), Ledger.createLedgerView(s, []));
        const held = first.value.reservations;
        const again = Ledger.admit({ tick: F.TICK, existingReservations: held }, proposal(req), Ledger.createLedgerView(s, held));
        assert.equal(again.kind, 'READY');
        assert.deepEqual(again.value.reservations, held);
    });

    test(label + ': unknown or vanished node gives UNKNOWN free, not 0', function () {
        const s = snap({ energyAvailable: unknownMeasure('NO_VISIBILITY'), nodes: [node('creep:h1', 'CARGO', 'creep', 50)] });
        const view = Ledger.createLedgerView(s, [reservation({ reservationId: 'r9', nodeId: 'gone', kind: 'SPEND', amount: 10 })]);
        assert.equal(nodeOf(view, POOL).free.value, null);
        assert.equal(nodeOf(view, 'gone').free.quality, 'UNKNOWN');
        assert.equal(validateLedgerView(view).ok, true);
        assert.equal(Ledger.liquidity(s, view).free.value, null);
    });

    test(label + ': finance patches pass the path-owner validator', function () {
        assert.deepEqual(validateStatePatch(Ledger.reservationPatch(reservation(), 'pt-a')), { ok: true });
        assert.deepEqual(validateStatePatch(Economy.forecastPatch(F.sampleForecastSummary(), 'pt-b')), { ok: true });
    });

    // ------------------------------------------------------------ ReplacementForecast

    test(label + ': replacement deadline, cost, 3×body spawn time, travel and 25-tick margin', function () {
        const s = snap({ creeps: [creep('h1', ['work', 'carry', 'move'], 1200, { legacyRole: 'harvester' })] });
        const r = Replacement.forecastReplacements({ snapshot: s, horizon: 1500, travelEstimates: { harvester: est(20) } });
        assert.equal(r.kind, 'READY');
        assert.deepEqual(validateReplacementPlan(r.value), { ok: true });
        const e = r.value.entries[0];
        assert.equal(e.stableKey, ROOM + '/legacy/harvester/h1#g1');
        assert.equal(e.bodyCost, 200);
        assert.equal(e.spawnTime, 9);
        assert.equal(e.deadline, F.TICK + 1200);
        assert.equal(e.startBy, F.TICK + 1200 - 20 - 9 - 25);
        assert.equal(e.criticality, 'CRITICAL');
        assert.equal(r.value.entries.length, 1, 'next generation starts after the horizon');
    });

    test(label + ': body cost and spawn time agree with calculations.json', function () {
        const miner = ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'];
        assert.equal(Replacement.bodyCost(miner), CALC.miner_5work_1carry_3move.cost);
        assert.equal(Math.round(CALC.miner_5work_1carry_3move.spawn_fraction * (1500 - CALC.miner_5work_1carry_3move.travel_ticks)), Replacement.spawnTimeOf(miner));
        const hauler = ['carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move', 'move'];
        assert.equal(Replacement.bodyCost(hauler), CALC.hauler_10carry_5move.road_distance_20.cost);
        assert.equal(Math.round(CALC.hauler_10carry_5move.road_distance_20.spawn_fraction * 1480), Replacement.spawnTimeOf(hauler));
        assert.equal(Replacement.bodyCost(['work', 'carry', 'move']), CALC.emergency_policy.starter);
        assert.equal(Replacement.bodyCost(['claim', 'claim', 'move', 'move']), CALC.remote_reserver_2claim_2move.cost);
    });

    test(label + ': UNKNOWN TTL or travel stays UNKNOWN, never 0; legacy expiryTime is ignored', function () {
        const s = snap({ creeps: [
            creep('a', ['work', 'carry', 'move'], unknownMeasure('MISSING_FIELD'), { legacyRole: 'harvester' }),
            creep('b', ['carry', 'move'], 500, { legacyRole: 'mule' }),
        ] });
        const bindings = { a: Object.assign(F.sampleObservedBinding(), { expiryTime: F.TICK + 50 }) };
        const r = Replacement.forecastReplacements({ snapshot: s, horizon: 1500, observedBindings: bindings });
        assert.equal(r.kind, 'READY');
        const byKey = {};
        for (const e of r.value.entries) byKey[e.stableKey] = e;
        const a = byKey[ROOM + '/legacy/harvester/a#g1'];
        assert.equal(a.quality, 'UNKNOWN');
        assert.equal(a.deadline, null, 'expiryTime is not used as TTL');
        assert.equal(a.startBy, null);
        assert.equal(a.reasonCode, 'MISSING_FIELD');
        const b = byKey[ROOM + '/legacy/mule/b#g1'];
        assert.equal(b.deadline, F.TICK + 500);
        assert.equal(b.travelTime.quality, 'UNKNOWN');
        assert.equal(b.startBy, null);
        assert.equal(b.quality, 'UNKNOWN');
    });

    test(label + ': a spawning successor prevents a duplicate replacement (legacy role)', function () {
        const s = snap({
            creeps: [
                creep('h1', ['work', 'carry', 'move'], 30, { legacyRole: 'harvester' }),
                creep('h2', ['work', 'carry', 'move'], unknownMeasure('MISSING_FIELD'), { legacyRole: 'harvester', spawning: true }),
            ],
            spawning: { name: 'h2', needTime: 9, remainingTime: 4 },
        });
        const r = Replacement.forecastReplacements({ snapshot: s, horizon: 1500, travelEstimates: { harvester: est(10) } });
        const keys = r.value.entries.map(function (e) { return e.stableKey; });
        assert.deepEqual(keys, [ROOM + '/legacy/harvester/h2#g1']);
        assert.equal(r.value.entries[0].deadline, F.TICK + 4 + 1500);
        assert.equal(r.value.entries[0].ticksToLive.quality, 'DERIVED');
    });

    test(label + ': generation (successor) is distinct from occurrence; higher generation covers the older one', function () {
        const key = ROOM + '/feeding/spawn1';
        const env = function (g) { return { operationKey: buildOperationKey({ domain: ROOM, ownerEpoch: 7, demandStableKey: key, generation: g, action: 'spawn', occurrence: '0' }), homeRoom: ROOM, ownerEpoch: 7 }; };
        const s = snap({
            creeps: [
                creep('old', ['carry', 'carry', 'move'], 20, { strategyEnvelope: env(2) }),
                creep('new', ['carry', 'carry', 'move'], unknownMeasure('MISSING_FIELD'), { strategyEnvelope: env(3), spawning: true }),
            ],
            spawning: { name: 'new', needTime: 9, remainingTime: 2 },
        });
        const d = Object.assign(F.sampleDemand(), { generation: 3 });
        const r = Replacement.analyzeReplacements({ snapshot: s, horizon: 1500, demands: [d] });
        const keys = r.value.plan.entries.map(function (e) { return e.stableKey; });
        assert.deepEqual(keys, [key + '#g4'], 'no second order for generation 3');
        const op = parseOperationKey(r.value.meta[key + '#g4'].operationKey);
        assert.equal(op.generation, 4);
        assert.equal(op.occurrence, '0');
        assert.equal(r.value.plan.entries[0].bodyCost, 150, 'demand option body');
    });

    test(label + ': short-lived bodies get several generations; overdue start is CRITICAL_DEADLINE', function () {
        const s = snap({ creeps: [
            creep('r1', ['claim', 'move'], 100, { legacyRole: 'reserver' }),
            creep('h1', ['work', 'carry', 'move'], 20, { legacyRole: 'harvester' }),
        ] });
        const r = Replacement.forecastReplacements({ snapshot: s, horizon: 1500, travelEstimates: { reserver: est(50), harvester: est(10) } });
        const keys = r.value.entries.map(function (e) { return e.stableKey; });
        assert.ok(keys.indexOf(ROOM + '/legacy/reserver/r1#g2') !== -1 && keys.indexOf(ROOM + '/legacy/reserver/r1#g3') !== -1, keys.join(','));
        const h = r.value.entries.filter(function (e) { return e.stableKey === ROOM + '/legacy/harvester/h1#g1'; })[0];
        assert.equal(h.reasonCode, 'CRITICAL_DEADLINE');
    });

    // ------------------------------------------------------------ ForecastCalendar

    const T0 = 100;
    function regressionInput(reservations, extra) {
        return Object.assign({ snapshot: snap({ tick: T0, energyAvailable: 0, capacity: 800 }), horizon: 1500, incomeStreams: [], demands: [demand()], reservations: reservations || [] }, extra || {});
    }

    test(label + ': DESIGN §13 — one payment 600 at tick 200, zero income, no remote → lower = target = 600 for any Reservation status', function () {
        const opKey = buildOperationKey({ domain: ROOM, ownerEpoch: 1, demandStableKey: ROOM + '/pay/one', generation: 0, action: 'spawn', occurrence: '0' });
        const base = { nodeId: POOL, amount: 600, operationKey: opKey, dueAt: 200, createdAt: T0, updatedAt: T0 };
        const variants = {
            none: [],
            RESERVED: [reservation(base)],
            ISSUED: [reservation(Object.assign({}, base, { state: 'ISSUED' }))],
            DISPUTED: [reservation(Object.assign({}, base, { state: 'ISSUED', unknownAmount: 600 }))],
        };
        for (const name of Object.keys(variants)) {
            const r = Calendar.computeReserves(regressionInput(variants[name]));
            assert.equal(r.kind, 'READY', name);
            assert.equal(r.value.lower, 600, name + ' lower');
            assert.equal(r.value.target, 600, name + ' target (not 600+600)');
            const cal = Calendar.buildCalendar(regressionInput(variants[name])).value;
            assert.deepEqual(validateCalendar(cal), { ok: true });
            const pays = cal.entries.filter(function (e) { return e.kind === 'PAYMENT'; });
            assert.equal(pays.length, 1, name + ': payment exactly once');
            assert.equal(pays[0].tick, 200);
        }
        // Reservation-only obligation (no demand) is the same payment.
        const only = Calendar.computeReserves(regressionInput(variants.RESERVED, { demands: [] }));
        assert.equal(only.value.lower, 600);
        assert.equal(only.value.target, 600);
    });

    test(label + ': remote off for the first 300 ticks raises only the target, without re-adding payments', function () {
        const input = regressionInput([], { incomeStreams: [{ stableKey: ROOM + '/income/remote:W6N8', ratePerTick: est(2), remote: true, functions: [] }] });
        const r = Calendar.computeReserves(input).value;
        assert.equal(r.lower, 400, '600 − 2×100 ticks of remote income');
        assert.equal(r.target, 600, 'remote income is 0 until tick 400 > 200; payment counted once');
    });

    test(label + ': loss of the last harvester / feeder / both — emergency package replaces, never adds to, the lost replacement', function () {
        const s = snap({ tick: T0, energyAvailable: 300, capacity: 800, creeps: [
            creep('h1', ['work', 'carry', 'move'], 400, { legacyRole: 'harvester' }),
            creep('m1', ['carry', 'carry', 'move'], 1400, { legacyRole: 'mule' }),
        ] });
        const travel = { harvester: est(10), mule: est(10), harvest: est(10), feed: est(10) };
        const input = { snapshot: s, horizon: 1500, incomeStreams: [{ stableKey: ROOM + '/income/local', ratePerTick: est(5), remote: false, functions: ['feed', 'harvest'] }], travelEstimates: travel };
        const r = Calendar.computeReserves(input);
        assert.equal(r.kind, 'READY');
        const by = {};
        for (const row of r.value.scenarios) if (!row.remoteOff) by[row.name + '@' + row.failTick] = row.deficit;
        assert.equal(by['normal@null'], 0);
        assert.equal(by['loss:harvest@' + T0], 200, 'emergency harvester now, its own replacement not double counted');
        assert.equal(by['loss:feed@' + T0], 150);
        assert.equal(by['loss:feed+harvest@' + T0], 350);
        assert.equal(r.value.lower, 350);
        assert.equal(r.value.target, 350, 'no remote: target equals lower');
        const cals = Calendar.buildScenarioCalendars(input).value;
        for (const c of cals) {
            assert.deepEqual(validateCalendar(c.calendar), { ok: true }, c.name);
            const keys = c.calendar.entries.filter(function (e) { return e.kind === 'PAYMENT'; }).map(function (e) { return e.stableKey; });
            assert.equal(new Set(keys).size, keys.length, c.name + ': payments unique by stableKey');
            if (c.name === 'loss:harvest' && c.failTick === T0) assert.equal(keys.indexOf(ROOM + '/legacy/harvester/h1#g1'), -1, 'lost creep replacement removed');
        }
    });

    test(label + ': replacement and demand of the same generation are one payment', function () {
        const key = ROOM + '/feeding/spawn1';
        const envKey = buildOperationKey({ domain: ROOM, ownerEpoch: 7, demandStableKey: key, generation: 2, action: 'spawn', occurrence: '0' });
        const s = snap({ tick: T0, creeps: [creep('f1', ['carry', 'carry', 'move'], 300, { strategyEnvelope: { operationKey: envKey, homeRoom: ROOM, ownerEpoch: 7 } })] });
        const d = Object.assign(F.sampleDemand(), { generation: 3, requiredBy: T0 + 300, createdAt: T0 });
        const cal = Calendar.buildCalendar({ snapshot: s, horizon: 1500, incomeStreams: [], demands: [d] }).value;
        const pays = cal.entries.filter(function (e) { return e.kind === 'PAYMENT'; });
        assert.deepEqual(pays.map(function (e) { return e.stableKey; }), [key + '#g3']);
        assert.ok(cal.entries.some(function (e) { return e.kind === 'DEADLINE'; }));
    });

    test(label + ': UNKNOWN propagates — no flow history, unknown travel', function () {
        const s = snap({ tick: T0, creeps: [creep('h1', ['work', 'carry', 'move'], 400, { legacyRole: 'harvester' })] });
        const noHistory = Calendar.computeReserves({ snapshot: s, horizon: 1500, flowWindows: [], travelEstimates: { harvester: est(10), harvest: est(10) } });
        assert.equal(noHistory.kind, 'UNKNOWN');
        assert.equal(noHistory.reason, 'NO_HISTORY');
        const noTravel = Calendar.computeReserves({ snapshot: s, horizon: 1500, incomeStreams: [{ stableKey: 'x', ratePerTick: est(5), remote: false, functions: ['harvest'] }] });
        assert.equal(noTravel.kind, 'UNKNOWN');
        assert.equal(noTravel.reason, 'MISSING_FIELD');
        const cal = Calendar.buildCalendar({ snapshot: s, horizon: 1500, flowWindows: [] }).value;
        assert.equal(cal.quality, 'UNKNOWN');
        assert.deepEqual(validateCalendar(cal), { ok: true });
    });

    test(label + ': one rebuild after a detected delay, otherwise UNKNOWN', function () {
        const s = snap({ tick: T0, energyAvailable: 0 });
        const d = demand({ requiredBy: 200, options: [{ body: ['claim'], cost: 600, spawnTime: 0, provides: 1, travelTime: measured(0) }] });
        const income = [{ stableKey: 'local', ratePerTick: est(5), remote: false, functions: [] }];
        // 5/tick from 100: 600 is funded at 220 > latest 200 -> UNKNOWN
        assert.equal(Calendar.checkSchedule({ snapshot: s, horizon: 1500, incomeStreams: income, demands: [d] }, 0).reason, 'CRITICAL_DEADLINE');
        // stock 100: at 200 balance 600 -> feasible with no rebuild
        assert.equal(Calendar.checkSchedule({ snapshot: s, horizon: 1500, incomeStreams: income, demands: [d] }, 100).value.rebuilds, 0);
        // replacement started by startBy (margin 25): 200 at 130 unfunded, delayed once to 140 <= latest 155
        const h = function (ttl) { return snap({ tick: T0, energyAvailable: 0, creeps: [creep('h1', ['work', 'carry', 'move'], ttl, { legacyRole: 'harvester' })] }); };
        const inp = function (ttl) { return { snapshot: h(ttl), horizon: 1500, incomeStreams: income, travelEstimates: { harvester: est(10) } }; };
        const r = Calendar.checkSchedule(inp(74), 0);
        assert.equal(r.kind, 'READY');
        assert.equal(r.value.rebuilds, 1);
        assert.deepEqual(r.value.delayed, [{ stableKey: ROOM + '/legacy/harvester/h1#g1', from: 130, to: 140 }]);
        // latest start 135 < 140: no second rebuild, UNKNOWN
        assert.equal(Calendar.checkSchedule(inp(54), 0).reason, 'CRITICAL_DEADLINE');
    });

    test(label + ': calendar horizon defaults to 1500 and entries stay inside it', function () {
        const cal = Calendar.buildCalendar({ snapshot: snap({ tick: T0 }), incomeStreams: [], demands: [demand({ requiredBy: T0 + 5000 })] }).value;
        assert.equal(cal.horizon, 1500);
        assert.equal(cal.entries.filter(function (e) { return e.kind === 'PAYMENT'; }).length, 0);
    });

    // ------------------------------------------------------------ EconomyModel

    test(label + ': flow lower bound = min of last three consecutive complete windows ending at the last closed one; transfer is not income', function () {
        const v = { topologyVersion: 'v1' };
        const ws = [window(0, 600, v), window(100, 500, Object.assign({ flows: Object.assign(window(100, 500).flows, { internalTransfer: measured(99999) }) }, v)), window(200, 700, v)];
        const r = Economy.incomeLowerBound(ws, { currentTick: 350 });
        assert.equal(r.rate.value, 5);
        assert.equal(r.rate.quality, 'DERIVED');
        assert.deepEqual(r.windows, [200, 100, 0]);
        assert.equal(Economy.incomeLowerBound(ws, {}).rate.value, 5, 'without currentTick the newest window is the last closed one');
        // the last closed window (300..400) is missing/incomplete -> no history
        assert.equal(Economy.incomeLowerBound(ws, { currentTick: 450 }).rate.quality, 'UNKNOWN');
        assert.equal(Economy.incomeLowerBound(ws.concat([window(300, 50, { complete: false, ticksCovered: 50, topologyVersion: 'v1' })]), {}).rate.quality, 'UNKNOWN');
        // not consecutive: 0, 100, 300
        const gap = [window(0, 600, v), window(100, 500, v), window(300, 700, v)];
        assert.equal(Economy.incomeLowerBound(gap, { currentTick: 450, analyticIncomePerTick: 10 }).rate.value, 8);
        // changed topology -> 0.8 analytic, or UNKNOWN
        const changed = ws.slice();
        changed[2] = window(200, 700, { topologyVersion: 'v2' });
        assert.equal(Economy.incomeLowerBound(changed, { analyticIncomePerTick: 10 }).rate.value, 8, '0.8 × analytic');
        assert.equal(Economy.incomeLowerBound(changed, {}).rate.quality, 'UNKNOWN');
        assert.equal(Economy.incomeLowerBound(changed, {}).reasonCode, 'NO_HISTORY');
        // null topology is unproven: analytic fallback, else ESTIMATED window minimum with NO_HISTORY
        const unproven = [window(0, 600), window(100, 500), window(200, 700)];
        assert.equal(Economy.incomeLowerBound(unproven, { analyticIncomePerTick: 10 }).rate.value, 8);
        const est = Economy.incomeLowerBound(unproven, {});
        assert.equal(est.rate.value, 5);
        assert.equal(est.rate.quality, 'ESTIMATED');
        assert.equal(est.reasonCode, 'NO_HISTORY');
        assert.equal(Economy.incomeLowerBound(ws, { knownFailure: true }).rate.value, 0);
        assert.equal(Economy.incomeLowerBound([], {}).rate.value, null, 'no data -> UNKNOWN, not 0');
    });

    test(label + ': analytic limiter = min(source regeneration, 2 × harvester WORK)', function () {
        const s = snap({ creeps: [creep('h1', ['work', 'work', 'carry', 'move'], 1000, { legacyRole: 'harvester' })] });
        assert.equal(Economy.analyticIncome(s, ROOM).value, 4);
        const empty = snap({});
        assert.equal(Economy.analyticIncome(empty, ROOM).value, 0, 'no harvester = known failure of the flow');
    });

    test(label + ': 50/50 quota — odd unit to the reserve; below lower all to reserve; at target none', function () {
        assert.deepEqual(Economy.allocateQuota({ reserve: 0, milestone: 0 }, 25, { reserveLevel: 500, lower: 100, target: 1000 }), { reserve: 13, milestone: 12, toReserve: 13, toMilestone: 12 });
        assert.equal(Economy.allocateQuota({ reserve: 0, milestone: 0 }, 25, { reserveLevel: 50, lower: 100, target: 1000 }).toReserve, 25);
        assert.equal(Economy.allocateQuota({ reserve: 0, milestone: 0 }, 25, { reserveLevel: 1000, lower: 100, target: 1000 }).toMilestone, 25);
        assert.equal(Economy.allocateQuota({ reserve: 0, milestone: 0 }, 25, { reserveLevel: null, lower: 100, target: 1000 }).toReserve, 25, 'unknown reserve level funds the reserve');
    });

    test(label + ': SAVING F=3500/Q=4000 keeps deadline and amount across a JSON reset', function () {
        let fund = { fundId: 'f1', target: 4000, balance: 3500, deadline: 3000, status: 'SAVING' };
        let accounts = { reserve: 0, milestone: 0 };
        const step = function () {
            const q = Economy.allocateQuota(accounts, 10 * Economy.QUOTA_PERIOD, { reserveLevel: 500, lower: 100, target: 100000 });
            accounts = { reserve: q.reserve, milestone: 0 };
            fund = Economy.advanceFund(fund, q.toMilestone).fund;
        };
        for (let t = 0; t < 100; t += Economy.QUOTA_PERIOD) step();
        assert.equal(fund.balance, 4000);
        assert.equal(fund.status, 'READY');
        // reset at the intermediate tick 100: JSON round trip, same continuation
        fund = { fundId: 'f1', target: 4000, balance: 3500, deadline: 3000, status: 'SAVING' };
        accounts = { reserve: 0, milestone: 0 };
        step(); step();
        fund = JSON.parse(JSON.stringify(fund));
        accounts = JSON.parse(JSON.stringify(accounts));
        assert.equal(fund.balance, 3750);
        step(); step();
        assert.deepEqual(fund, { fundId: 'f1', target: 4000, balance: 4000, deadline: 3000, status: 'READY' });
        // DESIGN §13: F=3000, g=10 reaches 4000 in 200 ticks; capital not doubled
        fund = { fundId: 'f2', target: 4000, balance: 3000, deadline: 5000, status: 'SAVING' };
        accounts = { reserve: 0, milestone: 0 };
        for (let t = 0; t < 200; t += Economy.QUOTA_PERIOD) step();
        assert.equal(fund.balance, 4000);
        assert.equal(accounts.reserve + (fund.balance - 3000), 10 * 200);
    });

    test(label + ': ForecastSummary — cargo/pile/stock counted once, reserved payment not double counted', function () {
        const nodes = [
            node('spawn1id', 'SPAWN_EXTENSION', 'spawn', 300), node('storage1', 'STORAGE_CONTAINER', 'storage', 1000),
            node('creep:m1', 'CARGO', 'creep', 50), node('pile1', 'PILE', 'resource', 20), node('remote:W6N8:s1', 'REMOTE', 'remote', 400),
        ];
        const t = 350;
        const s = snap({ tick: t, energyAvailable: 300, nodes: nodes });
        const view = F.sampleStateView();
        view.strategy.demands = {};
        view.shadow.rooms[ROOM].flowWindows = [window(0, 500, { topologyVersion: 'v1' }), window(100, 500, { topologyVersion: 'v1' }), window(200, 500, { topologyVersion: 'v1' })];
        view.shadow.rooms[ROOM].observedBindings = {};
        view.shadow.ledger.reservations = { r1: reservation({ nodeId: POOL, amount: 200, dueAt: t + 10, createdAt: t, updatedAt: t }) };
        const r = Economy.evaluate(s, view, 1500, {});
        assert.equal(r.kind, 'READY');
        assert.deepEqual(validateForecastSummary(r.value), { ok: true });
        assert.equal(r.value.freeEnergyNow.value, 300 + 1000 + 50 + 20 - 200, 'pool once, no remote, reservation once');
        assert.equal(r.value.incomeLowerPerTick.value, 5);
        assert.equal(r.value.committedPayments.value, 0, 'the reserved payment is already inside freeEnergyNow');
        assert.equal(r.value.nextDeficitTick, null);
        const reserves = Calendar.computeReserves({ snapshot: s, horizon: 1500, reservations: view.shadow.ledger.reservations, flowWindows: view.shadow.rooms[ROOM].flowWindows });
        assert.equal(reserves.value.lower, 150, 'payment 200 at +10 minus 10 ticks × 5 income; compared with gross liquidity 1370, not with free');
    });

    test(label + ': evaluate is UNKNOWN-honest without history', function () {
        const s = snap({ tick: T0 });
        const view = F.sampleStateView();
        view.shadow.rooms[ROOM].flowWindows = [];
        view.shadow.ledger.reservations = {};
        const r = Economy.evaluate(s, view, 1500, {});
        assert.equal(r.value.incomeLowerPerTick.quality, 'UNKNOWN');
        assert.equal(r.value.quality, 'UNKNOWN');
        assert.ok(r.value.reasonCodes.indexOf('NO_HISTORY') !== -1);
    });

    test(label + ': mode inputs RECOVER / STABILIZE / GROW by function (role), not by body parts', function () {
        const empty = snap({});
        assert.equal(Economy.modeSignals({ snapshot: empty, roomName: ROOM, liquidObserved: measured(5000), lowerReserve: 0, forecastQuality: 'DERIVED' }).mode, 'RECOVER');
        const upgr = snap({ creeps: [creep('u1', ['work', 'carry', 'move'], 1000, { legacyRole: 'upgrader' })] });
        const ru = Economy.modeSignals({ snapshot: upgr, roomName: ROOM, liquidObserved: measured(5000), lowerReserve: 0, forecastQuality: 'DERIVED' });
        assert.equal(ru.mode, 'RECOVER', 'an upgrader with WORK+CARRY+MOVE is not a harvest/feed chain');
        assert.deepEqual(ru.reasons.slice(0, 2), ['NO_HARVEST_CHAIN', 'NO_FEED_CHAIN']);
        const s = snap({ creeps: [creep('h1', ['work', 'carry', 'move'], 1000, { legacyRole: 'harvester' }), creep('m1', ['carry', 'move'], 1000, { legacyRole: 'mule' })] });
        assert.equal(Economy.modeSignals({ snapshot: s, roomName: ROOM, liquidObserved: measured(100), lowerReserve: 350, forecastQuality: 'DERIVED' }).mode, 'STABILIZE');
        assert.equal(Economy.modeSignals({ snapshot: s, roomName: ROOM, liquidObserved: measured(1000), lowerReserve: null, forecastQuality: 'DERIVED' }).mode, 'STABILIZE');
        assert.equal(Economy.modeSignals({ snapshot: s, roomName: ROOM, liquidObserved: measured(1000), lowerReserve: 350, forecastQuality: 'DERIVED' }).mode, 'GROW');
        const env = { operationKey: buildOperationKey({ domain: ROOM, ownerEpoch: 7, demandStableKey: ROOM + '/feeding/spawn1', generation: 1, action: 'spawn', occurrence: '0' }), homeRoom: ROOM, ownerEpoch: 7 };
        const byEnv = snap({ creeps: [creep('h1', ['work', 'carry', 'move'], 1000, { legacyRole: 'harvester' }), creep('f1', ['carry', 'move'], 1000, { strategyEnvelope: env })] });
        assert.equal(Economy.modeSignals({ snapshot: byEnv, roomName: ROOM, liquidObserved: measured(1000), lowerReserve: 350, forecastQuality: 'DERIVED' }).mode, 'GROW', 'feed function from the envelope demand');
    });

    // ------------------------------------------------------------ review fixes

    test(label + ': admitted reservation carries the demand operationKey; reserves are the same with and without it', function () {
        const t = 350;
        const v = { topologyVersion: 'v1' };
        const windows = [window(0, 500, v), window(100, 500, v), window(200, 500, v)];
        const d = Object.assign(F.sampleDemand(), { stableKey: ROOM + '/feed/x', generation: 1, requiredBy: t + 100, createdAt: t, criticality: 'REQUIRED',
            options: [{ body: ['carry', 'carry', 'move'], cost: 150, spawnTime: 9, provides: 5, travelTime: measured(20, 'ESTIMATED') }] });
        const s = snap({ tick: t, energyAvailable: 300 });
        const base = { snapshot: s, horizon: 1500, flowWindows: windows, demands: [d] };
        const without = Calendar.computeReserves(base);
        assert.equal(without.kind, 'READY');
        const prop = proposal([{ kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 150, dueAt: t + 71 }], { demands: [d] });
        const adm = Ledger.admit({ tick: t, ownerEpoch: 7 }, prop, Ledger.createLedgerView(s, []));
        assert.equal(adm.kind, 'READY');
        const res = adm.value.reservations[0];
        assert.equal(Ledger.paymentKeyOfReservation(res), ROOM + '/feed/x#g1');
        const withRes = Calendar.computeReserves(Object.assign({}, base, { reservations: [res] }));
        assert.equal(withRes.value.lower, without.value.lower);
        assert.equal(withRes.value.target, without.value.target);
        const cal = Calendar.buildCalendar(Object.assign({}, base, { reservations: [res] })).value;
        assert.equal(cal.entries.filter(function (e) { return e.kind === 'PAYMENT'; }).length, 1);
        // evaluate: the held payment is inside freeEnergyNow, not in committedPayments
        const view = F.sampleStateView();
        view.strategy.demands = {};
        view.strategy.demands[d.stableKey] = d;
        view.shadow.rooms[ROOM].flowWindows = windows;
        view.shadow.rooms[ROOM].observedBindings = {};
        view.shadow.ledger.reservations = {};
        const e0 = Economy.evaluate(s, view, 1500, {}).value;
        view.shadow.ledger.reservations[res.reservationId] = res;
        const e1 = Economy.evaluate(s, view, 1500, {}).value;
        assert.equal(e0.committedPayments.value, 150);
        assert.equal(e1.committedPayments.value, 0);
        assert.equal(e0.freeEnergyNow.value - e1.freeEnergyNow.value, 150);
        assert.equal(e0.freeEnergyNow.value - e0.committedPayments.value, e1.freeEnergyNow.value - e1.committedPayments.value, 'net position unchanged by the reservation');
        // no demand identity -> rejected, never a free-floating payment
        const two = proposal([{ kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 10, dueAt: null }], { demands: [] });
        const rej = Ledger.admit({ tick: t }, two, Ledger.createLedgerView(s, []));
        assert.equal(rej.reasonCode, 'INVALID_RECORD');
        assert.equal(rej.evidence.reason, 'NO_DEMAND_IDENTITY');
    });

    test(label + ': a demand generation already covered by a live/spawning executor is not owed again', function () {
        const key = ROOM + '/feeding/spawn1';
        const envKey = buildOperationKey({ domain: ROOM, ownerEpoch: 7, demandStableKey: key, generation: 3, action: 'spawn', occurrence: '0' });
        const s = snap({ tick: T0, creeps: [creep('f1', ['carry', 'carry', 'move'], unknownMeasure('MISSING_FIELD'), { spawning: true, strategyEnvelope: { operationKey: envKey, homeRoom: ROOM, ownerEpoch: 7 } })] });
        for (const g of [2, 3]) {
            const d = Object.assign(F.sampleDemand(), { generation: g, requiredBy: T0 + 50, createdAt: T0 });
            const cal = Calendar.buildCalendar({ snapshot: s, horizon: 1500, incomeStreams: [], demands: [d] }).value;
            assert.equal(cal.entries.filter(function (e) { return e.kind === 'PAYMENT' && e.stableKey === key + '#g' + g; }).length, 0, 'g' + g);
        }
        const next = Object.assign(F.sampleDemand(), { generation: 4, requiredBy: T0 + 50, createdAt: T0 });
        const cal = Calendar.buildCalendar({ snapshot: s, horizon: 1500, incomeStreams: [], demands: [next] }).value;
        assert.equal(cal.entries.filter(function (e) { return e.kind === 'PAYMENT' && e.stableKey === key + '#g4'; }).length, 1);
    });

    test(label + ': missionLimits without existing reservations is not exposure 0', function () {
        const s = snap({ energyAvailable: 1000 });
        const req = [{ kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 100, dueAt: null }];
        const r = Ledger.admit({ tick: F.TICK, missionLimits: { m1: 500 } }, proposal(req, { missionId: 'm1' }), Ledger.createLedgerView(s, []));
        assert.equal(r.kind, 'REJECTED');
        assert.equal(r.reasonCode, 'UNCERTAIN_FUNDING');
        assert.equal(r.evidence.reason, 'EXPOSURE_UNKNOWN');
        assert.equal(Ledger.admit({ tick: F.TICK, missionLimits: { m1: 500 }, existingReservations: [] }, proposal(req, { missionId: 'm1' }), Ledger.createLedgerView(s, [])).kind, 'READY');
    });

    test(label + ': spawn/extension requests are cross-checked against the spawn pool in one admit', function () {
        const s = snap({ energyAvailable: 300, nodes: [node('ext1', 'SPAWN_EXTENSION', 'extension', 50), node('spawn1id', 'SPAWN_EXTENSION', 'spawn', 250)] });
        const view = Ledger.createLedgerView(s, []);
        const classes = Ledger.ledgerNodeClasses(s, ROOM);
        const d1 = Object.assign(F.sampleDemand(), { stableKey: 'a', criticality: 'REQUIRED' });
        const d2 = Object.assign(F.sampleDemand(), { stableKey: 'b', criticality: 'REQUIRED' });
        const reqs = [
            { kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 200, dueAt: null },
            { kind: 'SPEND', nodeId: 'spawn1id', targetNodeId: null, resourceType: 'energy', amount: 150, dueAt: null },
        ];
        const r = Ledger.admit({ tick: F.TICK, nodeClasses: classes }, proposal(reqs, { demands: [d1, d2] }), view);
        assert.equal(r.reasonCode, 'INSUFFICIENT_LIQUIDITY', 'pool has only 100 left');
        assert.equal(r.evidence.nodeId, POOL);
        assert.equal(Ledger.admit({ tick: F.TICK, nodeClasses: classes }, proposal([reqs[0], Object.assign({}, reqs[1], { amount: 100 })], { demands: [d1, d2] }), view).kind, 'READY');
    });

    test(label + ': re-admission ignores nothing — released or changed priors are STALE_INPUT', function () {
        const s = snap({ energyAvailable: 300 });
        const req = [{ kind: 'SPEND', nodeId: POOL, targetNodeId: null, resourceType: 'energy', amount: 200, dueAt: null }];
        const held = Ledger.admit({ tick: F.TICK }, proposal(req), Ledger.createLedgerView(s, [])).value.reservations;
        const changed = Ledger.admit({ tick: F.TICK, existingReservations: held }, proposal([Object.assign({}, req[0], { amount: 250 })]), Ledger.createLedgerView(s, held));
        assert.equal(changed.reasonCode, 'STALE_INPUT');
        assert.equal(changed.evidence.reason, 'READMISSION_MISMATCH');
        const released = Ledger.release(held[0], F.TICK + 1).value;
        const again = Ledger.admit({ tick: F.TICK, existingReservations: [released] }, proposal(req), Ledger.createLedgerView(s, [released]));
        assert.equal(again.reasonCode, 'STALE_INPUT');
        assert.equal(again.evidence.reason, 'PRIOR_RELEASED');
    });

    test(label + ': loss at the nearest replacement deadline (zero income): paid successor + emergency, once each', function () {
        const s = snap({ tick: T0, energyAvailable: 0, capacity: 800, creeps: [
            creep('h1', ['work', 'carry', 'move'], 400, { legacyRole: 'harvester' }),
            creep('m1', ['carry', 'carry', 'move'], 1400, { legacyRole: 'mule' }),
        ] });
        const input = { snapshot: s, horizon: 1500, incomeStreams: [{ stableKey: 'local', ratePerTick: est(0), remote: false, functions: ['feed', 'harvest'] }],
            travelEstimates: { harvester: est(10), mule: est(10), harvest: est(10), feed: est(10) } };
        const r = Calendar.computeReserves(input).value;
        const by = {};
        for (const row of r.scenarios) if (!row.remoteOff) by[row.name + '@' + row.failTick] = row.deficit;
        assert.equal(by['normal@null'], 350, 'h1#g1 200 + m1#g1 150');
        // h1 deadline 500: its successor was paid at 456 (kept), emergency 200 at 500, m1 replacement 150; no second h1#g1
        assert.equal(by['loss:harvest@500'], 550);
        // loss now: h1#g1 replaced by emergency 200 + its next generation 200 (start 1565 <= 1600), m1 150
        assert.equal(by['loss:harvest@' + T0], 550);
    });

    test(label + ': tower energy (contract A.3 objectType) is not liquidity', function () {
        const s = snap({ energyAvailable: 300, nodes: [node('spawn1id', 'SPAWN_EXTENSION', 'spawn', 300), node('storage1', 'STORAGE_CONTAINER', 'storage', 1000)] });
        // contract A.2 validator does not know 'tower' yet: add the A.3 node after validation
        s.rooms[ROOM].energyNodes.push(node('tower1', 'STORAGE_CONTAINER', 'tower', 700));
        const view = Ledger.createLedgerView(s, []);
        assert.equal(Ledger.liquidity(s, view).observed.value, 1300);
    });
}

module.exports = { defineFinanceTests };
