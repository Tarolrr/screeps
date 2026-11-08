// Reconciler.reduce tests (A3): stage-A observation pipeline and patch idempotency.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { reduce } = require('../../../../src/bot/app/Reconciler');
const layout = require('../../../../src/bot/domain/stateLayout');
const { shortCreepName } = require('../../../../src/bot/domain/keys');

const R = H.ROOM;

function run(snap, shadow, opts, pending) {
    const res = reduce(snap, H.stateView(shadow, opts), pending || null);
    assert.equal(res.kind, 'READY', JSON.stringify(res));
    assert.deepEqual(layout.validateReconciliationPatch(res.value), { ok: true });
    return res.value;
}

function step(snap, shadow, previous, opts) {
    const patch = run(snap, shadow, opts, { previous: previous });
    const next = H.applyPatches(shadow, patch.patches);
    assert.deepEqual(layout.validateShadowRoot(next), { ok: true });
    return { patch: patch, shadow: next };
}

function world(tick, o) {
    o = o || {};
    return H.snapshot(tick, { W5N8: { nodes: [H.node('spawn1', 'spawn', o.spawn === undefined ? 300 : o.spawn)], spawns: [H.spawnObj('spawn1', o.spawning || null)], raw: o.raw || [] } }, o.creeps || [H.creep('c1', { energy: o.c1 || 0 })]);
}

function defineReconcilerTests(label) {
    test(label + ': stage-A pipeline writes cursor, bindings and flow windows; reduce and apply are idempotent', function () {
        const s0 = world(1000);
        const a = step(s0, null, null);
        assert.equal(a.shadow.rooms[R].eventCursor.processedThroughTick, 999);
        assert.equal(a.shadow.rooms[R].observedBindings.c1.lifeState, 'ALIVE');
        assert.deepEqual(a.shadow.rooms[R].flowWindows, [], 'first observation: no invented history');
        assert.deepEqual(a.patch.domainStatus, { W5N8: 'OK' });

        const s1 = world(1001, { c1: 4, raw: [{ i: 0, event: H.EV.HARVEST, objectId: 'id_c1', data: { targetId: 'src1', amount: 4 } }] });
        const b = step(s1, a.shadow, s0);
        const w = b.shadow.rooms[R].flowWindows;
        assert.equal(w.length, 1);
        assert.equal(w[0].windowStart, 1000);
        assert.equal(w[0].ticksCovered, 1);
        assert.equal(w[0].flows.harvest.value, 4);

        // same patch applied twice -> same state
        assert.deepEqual(H.applyPatches(b.shadow, b.patch.patches), b.shadow);
        // reduce again on the resulting state with the same inputs -> nothing to write, no double count
        const again = run(s1, b.shadow, {}, { previous: s0 });
        assert.deepEqual(again.patches, []);
        // patch ids are deterministic
        assert.deepEqual(run(s1, a.shadow, {}, { previous: s0 }).patches.map(function (p) { return p.patchId; }), b.patch.patches.map(function (p) { return p.patchId; }));
    });

    test(label + ': internal transfer does not increase income across the pipeline', function () {
        const s0 = world(1000, { c1: 50, spawn: 250 });
        const a = step(s0, null, null);
        const s1 = world(1001, { c1: 0, spawn: 300, raw: [{ i: 0, event: H.EV.TRANSFER, objectId: 'id_c1', data: { targetId: 'spawn1', resourceType: 'energy', amount: 50 } }] });
        const b = step(s1, a.shadow, s0);
        const f = b.shadow.rooms[R].flowWindows[0].flows;
        assert.equal(f.harvest.value, 0);
        assert.equal(f.externalIn.value, 0);
        assert.equal(f.internalTransfer.value, 50);
        assert.equal(f.unexplained.value, 0);
    });

    test(label + ': spawning start: cost once, SPAWN observed once, binding SPAWNING with SPAWN_ROOM home', function () {
        const s0 = world(1000);
        let st = step(s0, null, null);
        const kid = H.creep('kid', { spawning: true, body: ['carry', 'carry', 'move'], role: 'hauler', x: 20, y: 20 });
        const s1 = world(1001, { spawn: 150, spawning: 'kid', creeps: [H.creep('c1'), kid] });
        st = step(s1, st.shadow, s0);
        const spawnObs = Object.keys(st.shadow.observedOperations).filter(function (k) { return k.indexOf('obs:SPAWN:') === 0; });
        assert.equal(spawnObs.length, 1);
        const kb = st.shadow.rooms[R].observedBindings.kid;
        assert.equal(kb.lifeState, 'SPAWNING');
        assert.equal(kb.homeSource, 'SPAWN_ROOM');
        assert.equal(kb.bodyCost, 150);
        const s2 = world(1002, { spawn: 150, spawning: 'kid', creeps: [H.creep('c1'), kid] });
        st = step(s2, st.shadow, s1);
        assert.equal(Object.keys(st.shadow.observedOperations).length, 1);
        assert.equal(st.shadow.rooms[R].flowWindows[0].flows.spawnSpend.value, 150, 'spawn cost counted exactly once');
        assert.equal(st.shadow.rooms[R].flowWindows[0].flows.unexplained.value, 0);
    });

    test(label + ': death of a creep marks its binding DEAD; orphan home stays UNKNOWN', function () {
        const s0 = world(1000, { creeps: [H.creep('c1'), H.creep('c2', { role: null })] });
        let st = step(s0, null, null);
        assert.equal(st.shadow.rooms[R].observedBindings.c2.homeSource, 'UNKNOWN');
        assert.equal(st.shadow.rooms[R].observedBindings.c2.homeRoom, null);
        const s1 = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 300), H.node('tomb', 'tombstone', 0)], spawns: [H.spawnObj('spawn1', null)] } }, [H.creep('c1')]);
        st = step(s1, st.shadow, s0);
        assert.equal(st.shadow.rooms[R].observedBindings.c2.lifeState, 'DEAD');
        // incomplete creep list: not DEAD, UNKNOWN
        const s0b = world(1000, { creeps: [H.creep('c1'), H.creep('c2')] });
        const base = step(s0b, null, null).shadow;
        const partial = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 300)] } }, [H.creep('c1')], ['ownCreeps.c2']);
        assert.equal(step(partial, base, s0b).shadow.rooms[R].observedBindings.c2.lifeState, 'UNKNOWN');
    });

    test(label + ': UNCERTAIN_FUNDING on lastClosedTick gap, unexplained balance and missing operation', function () {
        const s0 = world(1000);
        const gap = run(world(1001), null, { lastClosedTick: 990 }, { previous: s0 });
        assert.equal(gap.domainStatus[R], 'UNCERTAIN_FUNDING');
        assert.ok(gap.reasonCodes.indexOf('UNCERTAIN_FUNDING') !== -1);
        assert.equal(run(world(1001), null, { lastClosedTick: 1000 }, { previous: s0 }).domainStatus[R], 'OK');

        const a = step(s0, null, null);
        const leak = run(world(1001, { spawn: 280 }), a.shadow, {}, { previous: s0 });
        assert.equal(leak.domainStatus[R], 'UNCERTAIN_FUNDING');
        assert.ok(leak.reasonCodes.indexOf('UNEXPLAINED_BALANCE') !== -1);

        const key = H.opKey('spawn');
        const env = { operationKey: key, homeRoom: R, ownerEpoch: 1 };
        const found = run(world(1001, { creeps: [H.creep('c1'), H.creep(shortCreepName(key), { envelope: env })] }), a.shadow, {}, { previous: s0 });
        assert.equal(found.domainStatus[R], 'UNCERTAIN_FUNDING', 'new creep with an envelope but no operation record');
        assert.equal(found.patches.filter(function (p) { return p.path[3] === shortCreepName(key); })[0].value.homeSource, 'CREEP_MEMORY');
    });

    test(label + ': missed ticks / reset without T-1 snapshot / visibility loss -> UNKNOWN windows, never zeros', function () {
        const s0 = world(1000);
        let st = step(s0, null, null);
        st = step(world(1001), st.shadow, s0);
        // skipped 1002..1004, next snapshot 1005 with no previous in heap (reset)
        const g = step(world(1005), st.shadow, null);
        assert.deepEqual(g.patch.gaps, [{ roomName: R, fromTick: 1001, toTick: 1003, reasonCode: 'EVENT_GAP' }]);
        const w = g.shadow.rooms[R].flowWindows[0];
        assert.equal(w.quality, 'UNKNOWN');
        assert.equal(w.flows.harvest.value, null);
        assert.equal(w.complete, false);
        // visibility loss
        const hidden = H.snapshot(1006, { W5N8: { visibility: 'NOT_VISIBLE' } }, [H.creep('c1')]);
        const h = step(hidden, g.shadow, world(1005));
        assert.deepEqual(h.patch.gaps, [{ roomName: R, fromTick: 1005, toTick: 1005, reasonCode: 'NO_VISIBILITY' }]);
        assert.equal(h.shadow.rooms[R].flowWindows[0].flows.harvest.value, null);
    });

    test(label + ': windows roll over at 100 ticks and complete only when fully observed', function () {
        let prev = world(1000);
        let st = step(prev, null, null);
        for (let t = 1001; t <= 1101; t++) {
            const cur = world(t);
            st = step(cur, st.shadow, prev);
            prev = cur;
        }
        const ws = st.shadow.rooms[R].flowWindows;
        assert.deepEqual(ws.map(function (w) { return [w.windowStart, w.ticksCovered, w.complete]; }), [[1000, 100, true], [1100, 1, false]]);
    });

    test(label + ': stage-B operations are matched; UNKNOWN effects mark the domain uncertain', function () {
        const s0 = world(1000, { c1: 50, spawn: 250 });
        const a = step(s0, null, null);
        const op = H.operation('transfer', { issuedAt: 1000 });
        const cur = H.snapshot(1001, { W5N8: { nodes: [H.node('spawn1', 'spawn', 300)], spawns: [H.spawnObj('spawn1', null)], raw: [
            { i: 0, event: H.EV.TRANSFER, objectId: 'id_c1', data: { targetId: 'spawn1', resourceType: 'energy', amount: 25 } },
            { i: 1, event: H.EV.TRANSFER, objectId: 'id_c1', data: { targetId: 'spawn1', resourceType: 'energy', amount: 25 } },
        ] } }, [H.creep('c1', { energy: 0 })]);
        const patch = run(cur, a.shadow, {}, { previous: s0, operations: [op] });
        assert.ok(patch.reasonCodes.indexOf('AMBIGUOUS_EFFECT') !== -1);
        assert.equal(patch.domainStatus[R], 'UNCERTAIN_FUNDING');
    });

    test(label + ': flow windows carry the room topologyVersion', function () {
        const s0 = world(1000);
        const a = step(s0, null, null);
        const b = step(world(1001), a.shadow, s0);
        assert.match(b.shadow.rooms[R].flowWindows[0].topologyVersion, /^fnv1a64:/);
        const extra = H.snapshot(1002, { W5N8: { nodes: [H.node('spawn1', 'spawn', 300), H.node('ext9', 'extension', 0, 22, 22)], spawns: [H.spawnObj('spawn1', null)] } }, [H.creep('c1')]);
        const c = step(extra, b.shadow, world(1001));
        assert.equal(c.shadow.rooms[R].flowWindows[0].topologyVersion, null, 'changed mid-window: not proven unchanged');
    });

    test(label + ': lastClosedTick null is a gap only next to existing observation data', function () {
        assert.equal(run(world(1000), null, {}, null).domainStatus[R], 'OK', 'truly fresh state');
        const a = step(world(1000), null, null);
        const r = run(world(1001), a.shadow, {}, { previous: world(1000) });
        assert.equal(r.domainStatus[R], 'UNCERTAIN_FUNDING');
        assert.equal(run(world(1001), a.shadow, { lastClosedTick: 1000 }, { previous: world(1000) }).domainStatus[R], 'OK');
    });

    test(label + ': disputed observations are not evicted while unresolved; cap pressure degrades optional records', function () {
        const Rec = require('../../../../src/bot/app/Reconciler');
        function obs(key, effect, lastSeen) {
            return { observationKey: key, kind: 'PICKUP', roomName: R, actorRef: 'a', targetRef: null, firstSeen: lastSeen, lastSeen: lastSeen, effect: effect, amount: { value: 1, quality: 'DERIVED', reason: null }, energyAmount: { value: 1, quality: 'DERIVED', reason: null }, eventKeys: [] };
        }
        // age: an old CONFIRMED goes, an old unresolved UNKNOWN stays, an old resolved UNKNOWN goes
        const stored = { c: obs('c', 'CONFIRMED', 1000), u: obs('u', 'UNKNOWN', 1360), r: obs('r', 'UNKNOWN', 1000) };
        const plan = Rec.planObservedOperations(stored, {}, 1350 + Rec.OBSERVED_OPERATION_RETENTION);
        assert.deepEqual(plan.deletes, ['c', 'r']);
        // cap: only unresolved disputed records -> new optional record not added, degraded
        const full = {};
        for (let i = 0; i < Rec.OBSERVED_OPERATION_SOFT_CAP; i++) full['d' + i] = obs('d' + i, 'UNKNOWN', 2050); // window 2000..2100 still open
        const add = { n1: obs('n1', 'CONFIRMED', 2050), n2: obs('n2', 'UNKNOWN', 2050) };
        const p2 = Rec.planObservedOperations(full, add, 2050);
        assert.deepEqual(p2.deletes, []);
        assert.deepEqual(p2.sets, ['n2'], 'disputed record kept up to the hard limit, optional one dropped');
        assert.equal(p2.degraded, true);
        // with confirmed records present they are evicted first
        const mixed = Object.assign({}, full);
        delete mixed.d0;
        mixed.old = obs('old', 'CONFIRMED', 1500);
        const p3 = Rec.planObservedOperations(mixed, { n1: obs('n1', 'CONFIRMED', 2050) }, 2050);
        assert.deepEqual(p3.deletes, ['old']);
        assert.deepEqual(p3.sets, ['n1']);
        assert.equal(p3.degraded, false);
    });
}

module.exports = { defineReconcilerTests };
