// EffectMatcher tests on synthetic Operations/CallReceipts (A3; serves stage B).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { normalizeRoomEvents, creepBodiesById, isCompleteLog } = require('../../../../src/bot/observation/EventNormalizer');
const M = require('../../../../src/bot/observation/EffectMatcher');
const D = require('../../../../src/bot/domain/dtos');
const { shortCreepName } = require('../../../../src/bot/domain/keys');

const R = H.ROOM;

function eventsOf(snap) {
    const out = [];
    for (const r in snap.rooms) {
        const res = normalizeRoomEvents(snap.rooms[r], null, { creepBodies: creepBodiesById(snap) });
        if (res.kind === 'READY') out.push.apply(out, res.value.events);
    }
    return out;
}

/** (room, effectTick) whose complete event list is passed (what Reconciler supplies). */
function coverageOf() {
    const out = [];
    for (let a = 0; a < arguments.length; a++) {
        const snap = arguments[a];
        for (const r in snap.rooms) if (isCompleteLog(snap.rooms[r])) out.push({ roomName: r, effectTick: snap.tick - 1 });
    }
    return out;
}

function match(ops, prev, cur, extra) {
    const results = M.matchEffects(Object.assign({ operations: ops, receipts: [], events: eventsOf(cur), coverage: coverageOf(cur), previous: prev, current: cur }, extra || {}));
    results.forEach(function (r) { assert.deepEqual(D.validateEffectResult(r), { ok: true }, JSON.stringify(r)); });
    return results;
}

function transferRaw(i, amount, from, to) {
    return { i: i, event: H.EV.TRANSFER, objectId: from || 'id_c1', data: { targetId: to || 'spawn1', resourceType: 'energy', amount: amount } };
}

const prevWorld = function (creeps) { return H.snapshot(1000, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200)] } }, creeps || [H.creep('c1', { energy: 50 })]); };

function defineMatcherTests(label) {
    test(label + ': unique transfer event confirms its amount; a receipt alone never confirms', function () {
        const op = H.operation('transfer');
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 250)], raw: [transferRaw(0, 50)] } }, [H.creep('c1')]);
        const [r] = match([op], prevWorld(), cur, { receipts: [H.receipt(op)] });
        assert.equal(r.kind, 'CONFIRMED');
        assert.equal(r.confirmedAmount, 50);
        assert.deepEqual(r.eventKeys, ['ev:W5N8:1000:0']);
        // OK receipt, filtered (incomplete) log without the event -> UNKNOWN, not CONFIRMED/NO_EFFECT
        const filtered = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200)], raw: [], rawLength: 3 } }, [H.creep('c1')]);
        const [u] = match([op], prevWorld(), filtered, { receipts: [H.receipt(op)] });
        assert.equal(u.kind, 'UNKNOWN');
        assert.equal(u.reason, 'EVENT_GAP');
    });

    test(label + ': absence on a complete log with a living actor is NO_EFFECT; an error receipt is NO_EFFECT', function () {
        const op = H.operation('transfer');
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200)], raw: [] } }, [H.creep('c1', { energy: 50 })]);
        const [r] = match([op], prevWorld(), cur);
        assert.equal(r.kind, 'NO_EFFECT');
        assert.equal(r.evidence.absent, true);
        const [e] = match([op], null, H.snapshot(1003, { W5N8: {} }, []), { receipts: [H.receipt(op, { code: -6 })] });
        assert.equal(e.kind, 'NO_EFFECT');
        assert.equal(e.evidence.receiptCode, -6);
        // THREW receipt is not evidence either way
        const [t] = match([op], null, H.snapshot(1003, { W5N8: {} }, []), { receipts: [H.receipt(op, { kind: 'THREW' })] });
        assert.equal(t.kind, 'UNKNOWN');
    });

    test(label + ': error receipt but a matching event is a conflict -> UNKNOWN', function () {
        const op = H.operation('transfer');
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 250)], raw: [transferRaw(0, 50)] } }, [H.creep('c1')]);
        const [r] = match([op], prevWorld(), cur, { receipts: [H.receipt(op, { code: -1 })] });
        assert.equal(r.kind, 'UNKNOWN');
        assert.equal(r.reason, 'AMBIGUOUS_EFFECT');
    });

    test(label + ': two identical transfers at different indices -> UNKNOWN(AMBIGUOUS_EFFECT), not collapsed', function () {
        const op = H.operation('transfer', { requested: 100 });
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 300)], raw: [transferRaw(0, 50), { i: 1, event: H.EV.HARVEST, objectId: 'id_c9', data: { targetId: 'src1', amount: 2 } }, transferRaw(2, 50)] } }, [H.creep('c1')]);
        const [r] = match([op], prevWorld(), cur);
        assert.equal(r.kind, 'UNKNOWN');
        assert.equal(r.reason, 'AMBIGUOUS_EFFECT');
        assert.deepEqual(r.eventKeys, ['ev:W5N8:1000:0', 'ev:W5N8:1000:2']);
    });

    test(label + ': competing candidates (two operations, one event) -> both UNKNOWN', function () {
        const a = H.operation('transfer', { occurrence: 'a#1' });
        const b = H.operation('transfer', { occurrence: 'b#1', commandId: 'cmd-2' });
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 250)], raw: [transferRaw(0, 50)] } }, [H.creep('c1')]);
        const res = match([a, b], prevWorld(), cur);
        assert.deepEqual(res.map(function (r) { return [r.kind, r.reason]; }), [['UNKNOWN', 'AMBIGUOUS_EFFECT'], ['UNKNOWN', 'AMBIGUOUS_EFFECT']]);
    });

    test(label + ': missing / duplicated / reordered events never produce a false verdict', function () {
        const op = H.operation('transfer');
        // missing: the tick of the effect was never captured (snapshot two ticks later)
        const late = H.snapshot(1002, { W5N8: { nodes: [H.node('spawn1', 'spawn', 250)], raw: [] } }, [H.creep('c1')]);
        assert.equal(match([op], null, late)[0].kind, 'UNKNOWN');
        // duplicated delivery of the same event object (same key twice in the input) stays one candidate
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 250)], raw: [transferRaw(0, 50)] } }, [H.creep('c1')]);
        const ev = eventsOf(cur);
        const dup = M.matchEffects({ operations: [op], events: ev.concat(ev), coverage: coverageOf(cur), previous: prevWorld(), current: cur });
        assert.equal(dup[0].kind, 'CONFIRMED');
        assert.equal(dup[0].confirmedAmount, 50);
        // reordered input -> same result
        const two = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 250)], raw: [transferRaw(0, 50), { i: 1, event: H.EV.HARVEST, objectId: 'id_c2', data: { targetId: 'src1', amount: 2 } }] } }, [H.creep('c1'), H.creep('c2')]);
        const e2 = eventsOf(two);
        assert.deepEqual(M.matchEffects({ operations: [op], events: e2.slice().reverse(), coverage: coverageOf(two), previous: prevWorld(), current: two }), M.matchEffects({ operations: [op], events: e2, coverage: coverageOf(two), previous: prevWorld(), current: two }));
    });

    test(label + ': lost visibility -> UNKNOWN(NO_VISIBILITY)', function () {
        const op = H.operation('transfer');
        const cur = H.snapshot(1001, { W5N8: { visibility: 'NOT_VISIBLE' } }, [H.creep('c1')]);
        const [r] = match([op], prevWorld(), cur);
        assert.equal(r.kind, 'UNKNOWN');
        assert.equal(r.reason, 'NO_VISIBILITY');
    });

    test(label + ': carrier death on the delivery tick does not release the delivery', function () {
        const op = H.operation('transfer');
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200), H.node('tomb1', 'tombstone', 50)], raw: [] } }, []);
        const [r] = match([op], prevWorld(), cur);
        assert.equal(r.kind, 'UNKNOWN', 'death tick + no event is not proof of non-delivery');
        assert.equal(r.reason, 'AMBIGUOUS_EFFECT');
        const delivered = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 250)], raw: [transferRaw(0, 50)] } }, []);
        assert.equal(match([op], prevWorld(), delivered)[0].kind, 'CONFIRMED');
    });

    test(label + ': partial transfer accumulates confirmedAmount under the same key; rerun is idempotent', function () {
        let op = H.operation('transfer', { requested: 100 });
        const cur1 = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 240)], raw: [transferRaw(0, 40)] } }, [H.creep('c1', { energy: 10 })]);
        const [r1] = match([op], prevWorld(), cur1);
        assert.equal(r1.kind, 'CONFIRMED');
        assert.equal(r1.confirmedAmount, 40);
        assert.equal(r1.effect.partial, true);
        const a1 = M.applyEffect(op, r1);
        assert.equal(a1.value.state, 'ISSUED');
        assert.equal(a1.value.confirmedAmount, 40);
        assert.deepEqual(D.validateOperation(a1.value), { ok: true });
        assert.deepEqual(M.applyEffect(a1.value, r1).value, a1.value, 'applying the same effect twice is a no-op');
        // the same snapshot again does not count the event twice or invent NO_EFFECT
        const [again] = match([a1.value], prevWorld(), cur1);
        assert.deepEqual(again, r1);
        // retry: same operationKey, new commandId, next tick
        op = Object.assign({}, a1.value, { lastCommandId: 'cmd-2', issuedAt: 1001, updatedAt: 1001 });
        const cur2 = H.snapshot(1002, { W5N8: { nodes: [H.node('spawn1', 'spawn', 300)], raw: [transferRaw(0, 60)] } }, [H.creep('c1', { energy: 0 })]);
        const events = eventsOf(cur1).concat(eventsOf(cur2));
        const [r2] = M.matchEffects({ operations: [op], events: events, coverage: coverageOf(cur1, cur2), previous: cur1, current: cur2 });
        assert.equal(r2.kind, 'CONFIRMED');
        assert.equal(r2.confirmedAmount, 100);
        assert.equal(r2.effect.partial, false);
        assert.equal(r2.operationKey, op.operationKey);
        assert.equal(M.applyEffect(op, r2).value.state, 'CONFIRMED');
    });

    test(label + ': spawn confirmed by observed spawning creep with matching name/body/home (no EVENT_SPAWN)', function () {
        const op = H.operation('spawn', { actorRef: 'spawn1', targetRef: null, requested: 150 });
        const name = shortCreepName(op.operationKey);
        const exp = {}; exp[op.operationKey] = { body: ['carry', 'carry', 'move'], homeRoom: R };
        const env = { operationKey: op.operationKey, homeRoom: R, ownerEpoch: 1 };
        const kid = H.creep(name, { spawning: true, body: ['carry', 'carry', 'move'], envelope: env, role: null });
        const cur = H.snapshot(1001, { W5N8: { spawns: [H.spawnObj('spawn1', name)] } }, [kid]);
        const [r] = match([op], prevWorld([]), cur, { expectations: exp });
        assert.equal(r.kind, 'CONFIRMED');
        assert.equal(r.confirmedAmount, 150);
        assert.equal(r.effect.spawnId, 'spawn1');
        // body mismatch -> name collision; missing envelope -> orphan, UNKNOWN
        const wrong = H.snapshot(1001, { W5N8: {} }, [H.creep(name, { body: ['work', 'carry', 'move'], envelope: env })]);
        assert.equal(match([op], null, wrong, { expectations: exp })[0].reason, 'NAME_COLLISION');
        const orphan = H.snapshot(1001, { W5N8: {} }, [H.creep(name, { body: ['carry', 'carry', 'move'] })]);
        assert.equal(match([op], null, orphan, { expectations: exp })[0].reason, 'AMBIGUOUS_EFFECT');
        // absent on T+1 with complete creep list -> NO_EFFECT
        const absent = H.snapshot(1001, { W5N8: { spawns: [H.spawnObj('spawn1', null)] } }, []);
        assert.equal(match([op], prevWorld([]), absent, { expectations: exp })[0].kind, 'NO_EFFECT');
        // incomplete creep list -> UNKNOWN
        const partial = H.snapshot(1001, { W5N8: {} }, [], ['ownCreeps']);
        assert.equal(match([op], prevWorld([]), partial, { expectations: exp })[0].kind, 'UNKNOWN');
    });

    test(label + ': reset between ISSUED and observation -> no false verdicts', function () {
        const transfer = H.operation('transfer');
        const spawn = H.operation('spawn', { actorRef: 'spawn1', targetRef: null, requested: 150 });
        const exp = {}; exp[spawn.operationKey] = { body: ['carry', 'carry', 'move'], homeRoom: R };
        const later = H.snapshot(1004, { W5N8: { nodes: [H.node('spawn1', 'spawn', 250)] } }, [H.creep('c1')]);
        const res = match([spawn, transfer], null, later, { expectations: exp });
        const byKey = {}; res.forEach(function (r) { byKey[r.operationKey] = r; });
        assert.equal(byKey[transfer.operationKey].kind, 'UNKNOWN');
        assert.equal(byKey[transfer.operationKey].reason, 'EVENT_GAP');
        assert.equal(byKey[spawn.operationKey].kind, 'UNKNOWN', 'absent after a missed window: may have been born and died');
        // the creep exists later: durable evidence confirms the spawn
        const name = shortCreepName(spawn.operationKey);
        const born = H.snapshot(1004, { W5N8: {} }, [H.creep(name, { body: ['carry', 'carry', 'move'], envelope: { operationKey: spawn.operationKey, homeRoom: R, ownerEpoch: 1 } })]);
        assert.equal(match([spawn], null, born, { expectations: exp })[0].kind, 'CONFIRMED');
        // PREPARED without receipt (reset between intent and API call) -> UNKNOWN
        const prepared = Object.assign(H.operation('transfer', { occurrence: 'p#1' }), { state: 'PREPARED', issuedAt: null });
        assert.equal(match([prepared], null, later)[0].kind, 'UNKNOWN');
    });

    test(label + ': applyEffect respects the operation transitions', function () {
        const op = Object.assign(H.operation('transfer'), { state: 'UNKNOWN', reasonCode: 'EVENT_GAP' });
        const noEffect = { kind: 'NO_EFFECT', operationKey: op.operationKey, commandId: 'cmd-1', evaluatedAt: 1005, confirmedAmount: null, effect: null, evidence: { x: 1 }, reason: null, eventKeys: [] };
        assert.equal(M.applyEffect(op, noEffect).value.state, 'NO_EFFECT');
        const unknown = Object.assign({}, noEffect, { kind: 'UNKNOWN', evidence: null, reason: 'AMBIGUOUS_EFFECT' });
        const u = M.applyEffect(op, unknown).value;
        assert.equal(u.state, 'UNKNOWN');
        assert.equal(u.reasonCode, 'EVENT_GAP');
        const confirmedTerminal = Object.assign({}, op, { state: 'CONFIRMED' });
        assert.equal(M.applyEffect(confirmedTerminal, unknown).kind, 'REJECTED');
    });

    test(label + ': UNKNOWN_RETIRED only under ARCHITECTURE §5 conditions', function () {
        const spawn = Object.assign(H.operation('spawn', { actorRef: 'spawn1', targetRef: null }), { state: 'UNKNOWN', reasonCode: 'EVENT_GAP' });
        const exp = { body: ['carry', 'carry', 'move'], homeRoom: R };
        const clear = H.snapshot(1010, { W5N8: {} }, [H.creep('legacy1', { body: ['carry', 'carry', 'move'], role: 'hauler' })]);
        assert.deepEqual(M.retirementCheck(spawn, { current: clear, expectation: exp }), { retire: true, blockers: [] });
        const latent = H.snapshot(1001, { W5N8: {} }, []);
        assert.ok(M.retirementCheck(spawn, { current: latent, expectation: exp }).blockers.indexOf('LATENT_EFFECT') !== -1);
        const orphan = H.snapshot(1010, { W5N8: {} }, [H.creep('x1', { body: ['carry', 'carry', 'move'], role: null })]);
        assert.deepEqual(M.retirementCheck(spawn, { current: orphan, expectation: exp }).blockers, ['UNRESOLVED_CANDIDATE']);
        const hidden = H.snapshot(1010, { W5N8: { visibility: 'NOT_VISIBLE' } }, []);
        assert.equal(M.retirementCheck(spawn, { current: hidden, expectation: exp }).retire, false);
        const incomplete = H.snapshot(1010, { W5N8: {} }, [], ['ownCreeps']);
        assert.equal(M.retirementCheck(spawn, { current: incomplete, expectation: exp }).retire, false);
        const issued = Object.assign({}, spawn, { state: 'ISSUED', reasonCode: null });
        assert.equal(M.retirementCheck(issued, { current: clear, expectation: exp }).retire, false);
        const transfer = Object.assign(H.operation('transfer'), { state: 'UNKNOWN', reasonCode: 'EVENT_GAP' });
        const visible = H.snapshot(1010, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200)] } }, [H.creep('c1')]);
        assert.equal(M.retirementCheck(transfer, { current: visible }).retire, true);
        const noTarget = H.snapshot(1010, { W5N8: { nodes: [H.node('spawn1', 'spawn', null)] } }, [H.creep('c1')]);
        assert.deepEqual(M.retirementCheck(transfer, { current: noTarget }).blockers, ['NODE_BALANCE_UNKNOWN']);
    });

    test(label + ': observeOperations: legacy events, spawning start once, derived pickup', function () {
        const s0 = H.snapshot(1000, { W5N8: { nodes: [H.node('pile1', 'resource', 100, 11, 10)], spawns: [H.spawnObj('spawn1', null)] } }, [H.creep('c1')]);
        const kid = H.creep('kid', { spawning: true, body: ['work', 'carry', 'move'], role: 'harvester' });
        const s1 = H.snapshot(1001, { W5N8: { nodes: [H.node('pile1', 'resource', 49, 11, 10)], spawns: [H.spawnObj('spawn1', 'kid')], raw: [{ i: 0, event: H.EV.HARVEST, objectId: 'id_x', data: { targetId: 'src1', amount: 2 } }] } }, [H.creep('c1', { energy: 50 }), kid]);
        const obs = M.observeOperations({ events: eventsOf(s1), previous: s0, current: s1 });
        obs.forEach(function (o) { assert.deepEqual(D.validateObservedOperation(o), { ok: true }, JSON.stringify(o)); });
        assert.deepEqual(obs.map(function (o) { return [o.kind, o.effect, o.amount.value]; }), [['HARVEST', 'CONFIRMED', 2], ['PICKUP', 'CONFIRMED', 50], ['SPAWN', 'CONFIRMED', 200]]);
        const s2 = H.snapshot(1002, { W5N8: { nodes: [H.node('pile1', 'resource', 48, 11, 10)], spawns: [H.spawnObj('spawn1', 'kid', 9, 7)] } }, [H.creep('c1', { energy: 50 }), kid]);
        const next = M.observeOperations({ events: eventsOf(s2), previous: s1, current: s2 });
        assert.equal(next.filter(function (o) { return o.kind === 'SPAWN'; }).length, 0);
    });

    test(label + ': actorRef as a creep name is resolved to its id (no false NO_EFFECT); unresolvable -> UNKNOWN', function () {
        const byName = H.operation('transfer', { actorRef: 'c1' });
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 250)], raw: [transferRaw(0, 50)] } }, [H.creep('c1')]);
        const [r] = match([byName], prevWorld(), cur);
        assert.equal(r.kind, 'CONFIRMED');
        assert.equal(r.confirmedAmount, 50);
        const ghost = H.operation('transfer', { actorRef: 'nobody' });
        assert.deepEqual([match([ghost], prevWorld(), cur)[0].kind, match([ghost], prevWorld(), cur)[0].reason], ['UNKNOWN', 'MISSING_FIELD']);
        const noTarget = H.operation('transfer', { actorRef: 'c1', targetRef: 'nowhere' });
        assert.equal(match([noTarget], prevWorld(), cur)[0].reason, 'MISSING_FIELD');
    });

    test(label + ': absence needs coverage actually passed in: events [] against a complete log -> UNKNOWN', function () {
        const op = H.operation('transfer');
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200)], raw: [] } }, [H.creep('c1', { energy: 50 })]);
        const noCoverage = M.matchEffects({ operations: [op], events: [], previous: prevWorld(), current: cur });
        assert.equal(noCoverage[0].kind, 'UNKNOWN');
        assert.equal(noCoverage[0].reason, 'EVENT_GAP');
        const covered = M.matchEffects({ operations: [op], events: [], coverage: coverageOf(cur), previous: prevWorld(), current: cur });
        assert.equal(covered[0].kind, 'NO_EFFECT');
        // the event is present but its tick is not covered (e.g. room already processed/rejected) -> never CONFIRMED
        const withEvent = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 250)], raw: [transferRaw(0, 50)] } }, [H.creep('c1')]);
        const uncovered = M.matchEffects({ operations: [op], events: eventsOf(withEvent), previous: prevWorld(), current: withEvent });
        assert.equal(uncovered[0].kind, 'UNKNOWN');
    });

    test(label + ': a candidate window intersecting an event gap is UNKNOWN, never CONFIRMED', function () {
        const op = H.operation('transfer');
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 250)], raw: [transferRaw(0, 50)] } }, [H.creep('c1')]);
        const [r] = match([op], prevWorld(), cur, { gaps: [{ roomName: R, fromTick: 1000, toTick: 1000, reasonCode: 'EVENT_GAP' }] });
        assert.equal(r.kind, 'UNKNOWN');
        assert.equal(r.reason, 'EVENT_GAP');
        // an UNKNOWN op with a multi-tick window where only the last tick is covered
        const old = Object.assign(H.operation('transfer', { issuedAt: 999 }), { state: 'UNKNOWN', reasonCode: 'EVENT_GAP' });
        const [w] = match([old], prevWorld(), cur);
        assert.equal(w.kind, 'UNKNOWN');
    });

    test(label + ': move NO_EFFECT only between adjacent snapshots', function () {
        const op = H.operation('move', { actorRef: 'c1', targetRef: null, requested: null });
        const exp = {}; exp[op.operationKey] = { targetPos: H.pos(11, 10) };
        const cur = H.snapshot(1001, { W5N8: {} }, [H.creep('c1')]);
        assert.equal(match([op], H.snapshot(1000, { W5N8: {} }, [H.creep('c1')]), cur, { expectations: exp })[0].kind, 'NO_EFFECT');
        assert.equal(match([op], H.snapshot(998, { W5N8: {} }, [H.creep('c1')]), cur, { expectations: exp })[0].kind, 'UNKNOWN');
        assert.equal(match([op], null, cur, { expectations: exp })[0].kind, 'UNKNOWN');
        const moved = H.snapshot(1001, { W5N8: {} }, [H.creep('c1', { x: 11 })]);
        assert.equal(match([op], null, moved, { expectations: exp })[0].kind, 'CONFIRMED');
    });

    test(label + ': transfer retirement requires both nodes, known capacity and no continuation', function () {
        const transfer = Object.assign(H.operation('transfer', { actorRef: 'c1' }), { state: 'UNKNOWN', reasonCode: 'EVENT_GAP' });
        const far = H.snapshot(1010, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200, 20, 20)] } }, [H.creep('c1', { energy: 50, x: 10, y: 10 })]);
        assert.deepEqual(M.retirementCheck(transfer, { current: far }), { retire: true, blockers: [] });
        const adjacent = H.snapshot(1010, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200, 11, 10)] } }, [H.creep('c1', { energy: 50, x: 10, y: 10 })]);
        assert.deepEqual(M.retirementCheck(transfer, { current: adjacent }).blockers, ['CONTINUATION_POSSIBLE']);
        const emptyCarrier = H.snapshot(1010, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200, 11, 10)] } }, [H.creep('c1', { energy: 0, x: 10, y: 10 })]);
        assert.equal(M.retirementCheck(transfer, { current: emptyCarrier }).retire, true);
        const gone = H.snapshot(1010, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200)] } }, []);
        assert.equal(M.retirementCheck(transfer, { current: gone }).retire, false, 'actor name not resolvable: not provable');
        const capUnknown = H.snapshot(1010, { W5N8: { nodes: [Object.assign(H.node('spawn1', 'spawn', 200), { capacity: { value: null, quality: 'UNKNOWN', reason: 'MISSING_FIELD' } })] } }, [H.creep('c1')]);
        assert.deepEqual(M.retirementCheck(transfer, { current: capUnknown }).blockers, ['CAPACITY_UNKNOWN']);
    });

    test(label + ': stale previous: actor moved to another room and transferred there -> no false NO_EFFECT', function () {
        const op = H.operation('transfer', { actorRef: 'c1', targetRef: 'spawn9' });
        const stale = H.snapshot(995, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200)] } }, [H.creep('c1', { energy: 50 })]);
        // tick 1001: c1 is in W5N9 where it transferred at 1000; only W5N8 is covered
        const cur = H.snapshot(1001, {
            W5N8: { nodes: [H.node('spawn1', 'spawn', 200)], raw: [] },
            W5N9: { nodes: [H.node('spawn9', 'spawn', 250, 20, 20, 'W5N9')], spawns: [], sources: [], raw: [transferRaw(0, 50, 'id_c1', 'spawn9')] },
        }, [H.creep('c1', { room: 'W5N9', energy: 0 })]);
        const onlyW5N8 = [{ roomName: 'W5N8', effectTick: 1000 }];
        const r = M.matchEffects({ operations: [op], events: [], coverage: onlyW5N8, previous: stale, current: cur });
        assert.equal(r[0].kind, 'UNKNOWN');
        // adjacent previous but the actor's current room is not covered -> still UNKNOWN
        const adjacent = H.snapshot(1000, { W5N8: { nodes: [H.node('spawn1', 'spawn', 200)] } }, [H.creep('c1', { energy: 50 })]);
        const r2 = M.matchEffects({ operations: [op], events: [], coverage: onlyW5N8, previous: adjacent, current: cur });
        assert.equal(r2[0].kind, 'UNKNOWN');
        // with W5N9 covered and its events passed the transfer is CONFIRMED, never NO_EFFECT
        const full = M.matchEffects({ operations: [op], events: eventsOf(cur), coverage: coverageOf(cur), previous: adjacent, current: cur });
        assert.equal(full[0].kind, 'CONFIRMED');
    });
}

module.exports = { defineMatcherTests };
