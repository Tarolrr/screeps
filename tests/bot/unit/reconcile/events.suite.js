// EventNormalizer + FlowAccounting tests (A3).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { normalizeRoomEvents } = require('../../../../src/bot/observation/EventNormalizer');
const FA = require('../../../../src/bot/models/FlowAccounting');
const D = require('../../../../src/bot/domain/dtos');

const R = H.ROOM;

function norm(snap, cursor) {
    const { creepBodiesById } = require('../../../../src/bot/observation/EventNormalizer');
    return normalizeRoomEvents(snap.rooms[R], cursor || null, { creepBodies: creepBodiesById(snap) });
}

function assertValidEvents(events) {
    events.forEach(function (e) { assert.deepEqual(D.validateNormalizedEvent(e), { ok: true }, JSON.stringify(e)); });
}

function defineEventTests(label) {
    test(label + ': transfer and withdraw normalize to source -> target with identity keys', function () {
        const snap = H.snapshot(1001, { W5N8: { raw: [
            { i: 0, event: H.EV.TRANSFER, objectId: 'id_c1', data: { targetId: 'spawn1', resourceType: 'energy', amount: 50 } },   // creep.transfer
            { i: 1, event: H.EV.TRANSFER, objectId: 'cont1', data: { targetId: 'id_c1', resourceType: 'energy', amount: 30 } },    // creep.withdraw
        ] } });
        const res = norm(snap);
        assert.equal(res.kind, 'READY');
        const ev = res.value.events;
        assertValidEvents(ev);
        assert.deepEqual(ev.map(function (e) { return [e.eventKey, e.sourceId, e.targetId, e.actorId, e.energyAmount.value]; }), [
            ['ev:W5N8:1000:0', 'id_c1', 'spawn1', null, 50],
            ['ev:W5N8:1000:1', 'cont1', 'id_c1', null, 30],
        ]);
        assert.deepEqual(res.value.cursor, { roomName: R, processedThroughTick: 1000, lastObservedAt: 1001, lastRawFingerprint: snap.rooms[R].eventLog.rawFingerprint });
        assert.deepEqual(D.validateEventCursor(res.value.cursor), { ok: true });
    });

    test(label + ': identical transfers at different indices are not collapsed; filtering keeps indices', function () {
        const t = { event: H.EV.TRANSFER, objectId: 'id_c1', data: { targetId: 'spawn1', resourceType: 'energy', amount: 10 } };
        const snap = H.snapshot(1001, { W5N8: { raw: [Object.assign({ i: 1 }, t), Object.assign({ i: 4 }, t)], rawLength: 6 } });
        const ev = norm(snap).value.events;
        assert.equal(ev.length, 2);
        assert.deepEqual(ev.map(function (e) { return e.originalArrayIndex; }), [1, 4]);
        assert.notEqual(ev[0].eventKey, ev[1].eventKey);
    });

    test(label + ': reordered capture gives the same events; duplicated index is rejected', function () {
        const a = { i: 0, event: H.EV.HARVEST, objectId: 'id_c1', data: { targetId: 'src1', amount: 4 } };
        const b = { i: 1, event: H.EV.HARVEST, objectId: 'id_c2', data: { targetId: 'src1', amount: 6 } };
        const sorted = H.snapshot(1001, { W5N8: { raw: [a, b] } });
        const reordered = JSON.parse(JSON.stringify(sorted));
        reordered.rooms[R].eventLog.entries.reverse();
        assert.deepEqual(normalizeRoomEvents(reordered.rooms[R], null).value.events, normalizeRoomEvents(sorted.rooms[R], null).value.events);
        const dup = JSON.parse(JSON.stringify(sorted));
        dup.rooms[R].eventLog.entries[1].originalArrayIndex = 0;
        const res = normalizeRoomEvents(dup.rooms[R], null);
        assert.equal(res.kind, 'REJECTED');
        assert.equal(res.reasonCode, 'INVALID_RECORD');
    });

    test(label + ': re-processing the same tick is a no-op; a conflicting re-capture is UNKNOWN', function () {
        const snap = H.snapshot(1001, { W5N8: { raw: [{ i: 0, event: H.EV.HARVEST, objectId: 'id_c1', data: { targetId: 'src1', amount: 4 } }] } });
        const first = norm(snap);
        const again = norm(snap, first.value.cursor);
        assert.equal(again.kind, 'READY');
        assert.deepEqual(again.value.events, []);
        assert.deepEqual(again.value.gaps, []);
        assert.deepEqual(again.value.cursor, first.value.cursor);
        const other = H.snapshot(1001, { W5N8: { raw: [{ i: 0, event: H.EV.HARVEST, objectId: 'id_c1', data: { targetId: 'src1', amount: 5 } }] } });
        const conflict = norm(other, first.value.cursor);
        assert.equal(conflict.kind, 'UNKNOWN');
        assert.equal(conflict.reason, 'AMBIGUOUS_EFFECT');
    });

    test(label + ': missing ticks and lost visibility become gaps, never zero events', function () {
        const cursor = { roomName: R, processedThroughTick: 1000, lastObservedAt: 1001, lastRawFingerprint: null };
        const skipped = norm(H.snapshot(1005, { W5N8: {} }), cursor);
        assert.deepEqual(skipped.value.gaps, [{ roomName: R, fromTick: 1001, toTick: 1003, reasonCode: 'EVENT_GAP' }]);
        assert.equal(skipped.value.cursor.processedThroughTick, 1004);
        const hidden = norm(H.snapshot(1002, { W5N8: { visibility: 'NOT_VISIBLE' } }), cursor);
        assert.deepEqual(hidden.value.events, []);
        assert.deepEqual(hidden.value.gaps, [{ roomName: R, fromTick: 1001, toTick: 1001, reasonCode: 'NO_VISIBILITY' }]);
        hidden.value.gaps.forEach(function (g) { assert.deepEqual(D.validateEventGap(g), { ok: true }); });
        assert.equal(hidden.value.cursor.lastRawFingerprint, null);
        const unavailable = norm(H.snapshot(1002, { W5N8: { status: 'UNAVAILABLE' } }), cursor);
        assert.deepEqual(unavailable.value.gaps, [{ roomName: R, fromTick: 1001, toTick: 1001, reasonCode: 'EVENT_GAP' }]);
    });

    test(label + ': energyAmount table (harvest, mineral, build boosted/unboosted, repair, upgrade)', function () {
        const boosted = H.creep('b1', { id: 'id_b1', body: [{ type: 'work', boost: 'LH', hits: 100 }, 'carry', 'move'] });
        const plain = H.creep('p1', { id: 'id_p1', body: ['work', 'work', 'carry', 'move'] });
        const snap = H.snapshot(1001, { W5N8: { raw: [
            { i: 0, event: H.EV.HARVEST, objectId: 'id_p1', data: { targetId: 'src1', amount: 4 } },
            { i: 1, event: H.EV.HARVEST, objectId: 'id_p1', data: { targetId: 'mineral1', amount: 1 } },
            { i: 2, event: H.EV.BUILD, objectId: 'id_p1', data: { targetId: 'site1', amount: 10 } },
            { i: 3, event: H.EV.BUILD, objectId: 'id_b1', data: { targetId: 'site1', amount: 7 } },
            { i: 4, event: H.EV.REPAIR, objectId: 'id_p1', data: { targetId: 'road1', amount: 200, energySpent: 2 } },
            { i: 5, event: H.EV.UPGRADE, objectId: 'id_p1', data: { amount: 2, energySpent: 2 } },
            { i: 6, event: H.EV.BUILD, objectId: 'stranger', data: { targetId: 'site1', amount: 5 } },
            { i: 7, event: 99, objectId: 'x', data: null },
        ] } }, [boosted, plain]);
        const ev = norm(snap).value.events;
        assertValidEvents(ev);
        const e = ev.map(function (x) { return [x.type, x.amount.value, x.energyAmount.value, x.energyAmount.quality]; });
        assert.deepEqual(e, [
            ['HARVEST', 4, 4, 'OBSERVED'],
            ['HARVEST', 1, 0, 'DERIVED'],
            ['BUILD', 10, 10, 'DERIVED'],
            ['BUILD', 7, null, 'UNKNOWN'],
            ['REPAIR', 200, 2, 'OBSERVED'],
            ['UPGRADE_CONTROLLER', 2, 2, 'OBSERVED'],
            ['BUILD', 5, null, 'UNKNOWN'],
            ['OTHER', null, 0, 'DERIVED'],
        ]);
    });
}

// ------------------------------------------------------------------ flows

function events(snap, cursor) { return norm(snap, cursor).value.events; }

function flowsOf(prev, cur, gaps) {
    const res = FA.accountFlows({ previous: prev, current: cur, events: events(cur), gaps: gaps || [] });
    assert.equal(res.kind, 'READY');
    res.value.forEach(function (d) { assert.deepEqual(D.validateFlowDelta(d), { ok: true }, JSON.stringify(d)); });
    return res.value[0];
}

function v(delta, field) { return delta.flows[field].value; }

function defineFlowTests(label) {
    test(label + ': harvest is income and balances', function () {
        const prev = H.snapshot(1000, { W5N8: { nodes: [H.node('spawn1', 'spawn', 300)] } }, [H.creep('c1', { energy: 0 })]);
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 300)], raw: [{ i: 0, event: H.EV.HARVEST, objectId: 'id_c1', data: { targetId: 'src1', amount: 4 } }] } }, [H.creep('c1', { energy: 4 })]);
        const d = flowsOf(prev, cur);
        assert.equal(v(d, 'harvest'), 4);
        assert.equal(v(d, 'unexplained'), 0);
        assert.equal(d.quality, 'OBSERVED');
        assert.deepEqual(d.reasonCodes, []);
    });

    test(label + ': internal transfer and withdraw are not income; every unit counted once', function () {
        const prev = H.snapshot(1000, { W5N8: { energyAvailable: 250, nodes: [H.node('spawn1', 'spawn', 250), H.node('cont1', 'container', 100)] } }, [H.creep('c1', { energy: 50 }), H.creep('c2', { energy: 0 })]);
        const cur = H.snapshot(1001, { W5N8: { energyAvailable: 300, nodes: [H.node('spawn1', 'spawn', 300), H.node('cont1', 'container', 70)], raw: [
            { i: 0, event: H.EV.TRANSFER, objectId: 'id_c1', data: { targetId: 'spawn1', resourceType: 'energy', amount: 50 } },
            { i: 1, event: H.EV.TRANSFER, objectId: 'cont1', data: { targetId: 'id_c2', resourceType: 'energy', amount: 30 } },
        ] } }, [H.creep('c1', { energy: 0 }), H.creep('c2', { energy: 30 })]);
        const d = flowsOf(prev, cur);
        assert.equal(v(d, 'harvest'), 0);
        assert.equal(v(d, 'externalIn'), 0);
        assert.equal(v(d, 'internalTransfer'), 80);
        assert.equal(v(d, 'unexplained'), 0, 'spawnPool/energyAvailable is not a second balance');
    });

    test(label + ': transfer to a foreign creep is external outflow', function () {
        const prev = H.snapshot(1000, { W5N8: { nodes: [H.node('cont1', 'container', 100)] } }, []);
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('cont1', 'container', 60)], raw: [{ i: 0, event: H.EV.TRANSFER, objectId: 'cont1', data: { targetId: 'hostile1', resourceType: 'energy', amount: 40 } }] } }, []);
        const d = flowsOf(prev, cur);
        assert.equal(v(d, 'externalOut'), 40);
        assert.equal(v(d, 'internalTransfer'), 0);
        assert.equal(v(d, 'unexplained'), 0);
    });

    test(label + ': spawn cost is charged exactly once at the observed spawning start', function () {
        const nodes = function (a) { return [H.node('spawn1', 'spawn', a)]; };
        const s0 = H.snapshot(1000, { W5N8: { nodes: nodes(300), spawns: [H.spawnObj('spawn1', null)] } }, []);
        const kid = H.creep('kid', { spawning: true, body: ['carry', 'carry', 'move'], x: 20, y: 20 });
        const s1 = H.snapshot(1001, { W5N8: { nodes: nodes(150), spawns: [H.spawnObj('spawn1', 'kid', 9, 8)] } }, [kid]);
        const s2 = H.snapshot(1002, { W5N8: { nodes: nodes(150), spawns: [H.spawnObj('spawn1', 'kid', 9, 7)] } }, [kid]);
        const d1 = flowsOf(s0, s1);
        const d2 = flowsOf(s1, s2);
        assert.equal(v(d1, 'spawnSpend'), 150);
        assert.equal(v(d1, 'unexplained'), 0);
        assert.equal(v(d2, 'spawnSpend'), 0);
        assert.equal(v(d1, 'spawnSpend') + v(d2, 'spawnSpend'), 150);
    });

    test(label + ': build/repair/upgrade use energyAmount; unknown energy stays UNKNOWN', function () {
        const prev = H.snapshot(1000, { W5N8: {} }, [H.creep('c1', { energy: 50, body: ['work', 'work', 'carry', 'move'] })]);
        const cur = H.snapshot(1001, { W5N8: { raw: [{ i: 0, event: H.EV.BUILD, objectId: 'id_c1', data: { targetId: 's', amount: 10 } }] } }, [H.creep('c1', { energy: 40, body: ['work', 'work', 'carry', 'move'] })]);
        const d = flowsOf(prev, cur);
        assert.equal(v(d, 'build'), 10);
        assert.equal(d.flows.build.quality, 'DERIVED');
        assert.equal(v(d, 'unexplained'), 0);
        const boostedBody = [{ type: 'work', boost: 'LH', hits: 100 }, 'carry', 'move'];
        const p2 = H.snapshot(1000, { W5N8: {} }, [H.creep('c1', { energy: 50, body: boostedBody })]);
        const c2 = H.snapshot(1001, { W5N8: { raw: [{ i: 0, event: H.EV.BUILD, objectId: 'id_c1', data: { targetId: 's', amount: 7 } }] } }, [H.creep('c1', { energy: 45, body: boostedBody })]);
        const d2 = flowsOf(p2, c2);
        assert.equal(d2.flows.build.value, null);
        assert.equal(d2.flows.unexplained.value, null);
        assert.notEqual(d2.quality, 'OBSERVED');
    });

    test(label + ': unexplained balance is reported with low quality', function () {
        const prev = H.snapshot(1000, { W5N8: { nodes: [H.node('cont1', 'container', 100)] } }, []);
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('cont1', 'container', 80)] } }, []);
        const d = flowsOf(prev, cur);
        assert.equal(v(d, 'unexplained'), -20);
        assert.deepEqual(d.reasonCodes, ['UNEXPLAINED_BALANCE']);
        assert.equal(d.quality, 'ESTIMATED');
    });

    test(label + ': derived pickup is internal; dropped resource decay is a loss', function () {
        const prev = H.snapshot(1000, { W5N8: { nodes: [H.node('pile1', 'resource', 100, 11, 10)] } }, [H.creep('c1', { energy: 0 })]);
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('pile1', 'resource', 49, 11, 10)] } }, [H.creep('c1', { energy: 50 })]);
        const d = flowsOf(prev, cur);
        assert.equal(v(d, 'internalTransfer'), 50);
        assert.equal(d.flows.internalTransfer.quality, 'DERIVED');
        assert.equal(v(d, 'decayLoss'), 1);
        assert.equal(v(d, 'harvest'), 0);
        assert.equal(v(d, 'unexplained'), 0);
    });

    test(label + ': gap, lost visibility and non-consecutive snapshots give UNKNOWN flows', function () {
        const prev = H.snapshot(1000, { W5N8: {} }, []);
        const gap = flowsOf(prev, H.snapshot(1001, { W5N8: {} }, []), [{ roomName: R, fromTick: 1000, toTick: 1000, reasonCode: 'EVENT_GAP' }]);
        assert.equal(gap.quality, 'UNKNOWN');
        D.FLOW_FIELDS.forEach(function (f) { assert.equal(gap.flows[f].value, null); });
        const hidden = flowsOf(prev, H.snapshot(1001, { W5N8: { visibility: 'NOT_VISIBLE' } }, []));
        assert.equal(hidden.flows.harvest.value, null);
        assert.deepEqual(hidden.reasonCodes, ['NO_VISIBILITY']);
        const jump = flowsOf(prev, H.snapshot(1003, { W5N8: {} }, []));
        assert.equal(jump.flows.harvest.value, null);
        assert.equal(jump.fromTick, 1000);
        assert.equal(jump.toTick, 1003);
    });

    test(label + ': windows: 100 observed ticks are complete; a gap makes the window UNKNOWN', function () {
        const deltas = [];
        for (let t = 1000; t < 1100; t++) {
            const flows = {};
            D.FLOW_FIELDS.forEach(function (f) { flows[f] = D.measured(f === 'harvest' ? 2 : 0); });
            deltas.push({ roomName: R, fromTick: t, toTick: t + 1, flows: flows, quality: 'OBSERVED', reasonCodes: [] });
        }
        const w = FA.closeWindow(1000, deltas);
        assert.deepEqual(D.validateFlowWindow(w), { ok: true });
        assert.equal(w.complete, true);
        assert.equal(w.flows.harvest.value, 200);
        const withGap = deltas.slice(0, 50).concat([FA.unknownDelta(R, 1050, 1060, 'EVENT_GAP')], deltas.slice(60));
        const g = FA.closeWindow(1000, withGap);
        assert.deepEqual(D.validateFlowWindow(g), { ok: true });
        assert.equal(g.complete, false);
        assert.equal(g.ticksCovered, 90);
        assert.equal(g.quality, 'UNKNOWN');
        assert.equal(g.flows.harvest.value, null, 'never zeros or a partial sum for a gapped window');
        assert.deepEqual(g.reasonCodes, ['EVENT_GAP']);
    });

    test(label + ': remote source energy is not stock: remote harvest balances, regeneration is not income', function () {
        const RM = 'W6N8';
        const remote = function (amount) { return [H.node('src9', 'remote', amount, 5, 5, RM)]; };
        const src = [{ id: 'src9', pos: H.pos(5, 5, RM), energy: D.measured(3000), energyCapacity: D.measured(3000), ticksToRegeneration: D.measured(100) }];
        const prev = H.snapshot(1000, { W6N8: { nodes: remote(3000), sources: src } }, [H.creep('r1', { room: RM, energy: 0 })]);
        const cur = H.snapshot(1001, { W6N8: { nodes: remote(2990), sources: src, raw: [{ i: 0, event: H.EV.HARVEST, objectId: 'id_r1', data: { targetId: 'src9', amount: 10 } }] } }, [H.creep('r1', { room: RM, energy: 10 })]);
        const d = FA.accountFlows({ previous: prev, current: cur, events: normalizeRoomEvents(cur.rooms[RM], null).value.events, gaps: [] }).value[0];
        assert.equal(d.flows.harvest.value, 10);
        assert.equal(d.flows.unexplained.value, 0);
        assert.deepEqual(d.reasonCodes, []);
        // regeneration 0 -> 3000 with no harvest: no income, nothing unexplained
        const empty = H.snapshot(1001, { W6N8: { nodes: remote(0), sources: src } }, [H.creep('r1', { room: RM, energy: 10 })]);
        const regen = H.snapshot(1002, { W6N8: { nodes: remote(3000), sources: src } }, [H.creep('r1', { room: RM, energy: 10 })]);
        const r = FA.accountFlows({ previous: empty, current: regen, events: [], gaps: [] }).value[0];
        assert.equal(r.flows.harvest.value, 0);
        assert.equal(r.flows.externalIn.value, 0);
        assert.equal(r.flows.unexplained.value, 0);
    });

    test(label + ': spawn start after a gap is not dated; pile rounding tolerance is bounded', function () {
        const kid = H.creep('kid', { spawning: true, body: ['carry', 'carry', 'move'] });
        const s0 = H.snapshot(1000, { W5N8: { spawns: [H.spawnObj('spawn1', null)] } }, []);
        const s3 = H.snapshot(1003, { W5N8: { spawns: [H.spawnObj('spawn1', 'kid')] } }, [kid]);
        assert.deepEqual(FA.spawnStarts(s0, s3), []);
        assert.equal(FA.MAX_PILE_ROUNDING, 3);
    });

    test(label + ': harvest from a source dropped from the snapshot is UNKNOWN, not 0', function () {
        const snap = H.snapshot(1001, { W5N8: { sources: [], raw: [{ i: 0, event: H.EV.HARVEST, objectId: 'id_c1', data: { targetId: 'srcX', amount: 10 } }] } }, [H.creep('c1')]);
        snap.rooms[R].missingFields = ['sources.srcX.pos'];
        const e = normalizeRoomEvents(snap.rooms[R], null).value.events[0];
        assert.equal(e.energyAmount.value, null);
        const mineral = H.snapshot(1001, { W5N8: { raw: [{ i: 0, event: H.EV.HARVEST, objectId: 'id_c1', data: { targetId: 'min1', amount: 1 } }] } }, [H.creep('c1')]);
        assert.equal(normalizeRoomEvents(mineral.rooms[R], null).value.events[0].energyAmount.value, 0);
    });

    test(label + ': topologyVersion: stable for the same layout, changes with structures or creep composition', function () {
        const base = H.snapshot(1000, { W5N8: { nodes: [H.node('spawn1', 'spawn', 300), H.node('ext1', 'extension', 50, 21, 20)] } }, [H.creep('c1'), H.creep('c2', { role: 'hauler', body: ['carry', 'move'] })]);
        const sameLayout = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 120), H.node('ext1', 'extension', 0, 21, 20)] } }, [H.creep('c1', { energy: 30, x: 15 }), H.creep('c2', { role: 'hauler', body: ['carry', 'move'] })]);
        const t0 = FA.topologyVersion(base, R);
        assert.match(t0, /^fnv1a64:/);
        assert.equal(FA.topologyVersion(sameLayout, R), t0, 'amounts/positions of creeps do not change topology');
        const newExt = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 300), H.node('ext1', 'extension', 50, 21, 20), H.node('ext2', 'extension', 0, 22, 20)] } }, [H.creep('c1'), H.creep('c2', { role: 'hauler', body: ['carry', 'move'] })]);
        assert.notEqual(FA.topologyVersion(newExt, R), t0);
        const lostHauler = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 300), H.node('ext1', 'extension', 50, 21, 20)] } }, [H.creep('c1')]);
        assert.notEqual(FA.topologyVersion(lostHauler, R), t0);
        assert.equal(FA.topologyVersion(H.snapshot(1001, { W5N8: { visibility: 'NOT_VISIBLE' } }, []), R), null);
        // windows keep the version only while it does not change
        const flows = {}; D.FLOW_FIELDS.forEach(function (f) { flows[f] = D.measured(0); });
        const deltas = [{ roomName: R, fromTick: 1000, toTick: 1001, flows: flows, quality: 'OBSERVED', reasonCodes: [] }, { roomName: R, fromTick: 1001, toTick: 1002, flows: flows, quality: 'OBSERVED', reasonCodes: [] }];
        assert.equal(FA.closeWindow(1000, deltas, [t0, t0]).topologyVersion, t0);
        assert.equal(FA.closeWindow(1000, deltas, [t0, FA.topologyVersion(newExt, R)]).topologyVersion, null);
        assert.deepEqual(D.validateFlowWindow(FA.closeWindow(1000, deltas, [t0, t0])), { ok: true });
    });
}

module.exports = { defineEventTests, defineFlowTests };
