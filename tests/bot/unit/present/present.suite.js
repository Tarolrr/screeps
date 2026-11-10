// STRAT-VIEW presenter unit tests (pure layout/format, UNKNOWN rendering, console events,
// flags, component gating, ports, console commands). Shared by present.test.js (native)
// and present-mappatch.test.js (dist2/mapPatch.js active, as in the bundle).

const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('./helpers');
const { buildRoomModel, creepOfNeedKey } = require('../../../../src/bot/telemetry/present/model');
const { buildDrawOps, panelLines, UNKNOWN_MARK, COLORS } = require('../../../../src/bot/telemetry/present/layout');
const Events = require('../../../../src/bot/telemetry/present/events');
const { resolveFlags } = require('../../../../src/bot/telemetry/present/flags');
const { createPresenter } = require('../../../../src/bot/telemetry/Presenter');
const { createStratCommands } = require('../../../../src/bot/telemetry/present/commands');
const P = require('../../../../src/bot/app/ports');
const { createTrapMemory, createTrapGame, createRoomVisualRecorder } = require('../../support/trapRuntime');
const { validateStrategyView } = require('../../../../src/bot/domain/stateLayout');
const { CONTRACT_VERSION } = require('../../../../src/bot/domain/version');

const ROOM = H.ROOM;
const SHAPES = ['text', 'rect', 'line', 'circle', 'poly'];

function model(over) {
    const o = over || {};
    return buildRoomModel({
        tick: o.tick || 1050, roomName: ROOM,
        room: o.room === undefined ? H.roomSnapshot({ spawning: o.spawning }) : o.room,
        creeps: o.creeps || [H.creep('h1', 'harvester', 1180, 11, 10), H.creep('m1', 'mule', 120, 24, 25)],
        shadowRoom: o.shadowRoom || H.shadowRoom(),
        proposals: o.proposals || [],
    });
}

function textsOf(ops) {
    return ops.filter(function (o) { return o.shape === 'text'; }).map(function (o) { return o.args[0]; });
}

const DUE_MULE = { key: ROOM + '/legacy/feed/m1#g1', fn: 'feed', crit: 'CRITICAL', startBy: 1040, deadline: 1060, cost: 200, q: 'ESTIMATED', due: true, reason: 'CRITICAL_DEADLINE' };
const SPAWN_MULE = { label: 'spawn:' + DUE_MULE.key, proposalId: 'sp:W1N1:abc', reasonCode: 'CRITICAL_DEADLINE', accepted: true };

function defineTests(label) {
    test(label + ': contract A.5 and the operator view flag schema', function () {
        assert.equal(CONTRACT_VERSION, 'A.5');
        assert.equal(validateStrategyView({}).ok, true);
        assert.equal(validateStrategyView({ rooms: { W1N1: { overlay: true } }, console: false }).ok, true);
        assert.equal(validateStrategyView({ rooms: { W1N1: { overlay: 'yes' } } }).ok, false);
        assert.equal(validateStrategyView({ rooms: { notaroom: { overlay: true } } }).ok, false);
        assert.equal(validateStrategyView({ console: 1 }).ok, false);
        assert.equal(validateStrategyView({ extra: true }).ok, false);
    });

    test(label + ': layout: panel shows mode (colour), reason, since, maturity, reserve bar marks, income, deficit, quality', function () {
        const mo = model();
        const ops = buildDrawOps(mo);
        for (const op of ops) assert.ok(SHAPES.indexOf(op.shape) !== -1, op.shape);
        const texts = textsOf(ops);
        const head = ops.find(function (o) { return o.shape === 'text' && /shadow GROW since t1000/.test(o.args[0]); });
        assert.ok(head, texts.join('\n'));
        assert.equal(head.args[3].color, COLORS.GROW);
        assert.ok(texts.some(function (t) { return /reason SHADOW_ONLY \| BASIC \| threat NONE/.test(t); }));
        assert.ok(texts.some(function (t) { return /free 380 \| reserve 200\/450 \| age 10/.test(t); }), texts.join('\n'));
        assert.ok(texts.some(function (t) { return t === 'income >= 400/100t (DERIVED)'; }));
        assert.ok(texts.some(function (t) { return t === 'next deficit none'; }));
        assert.ok(texts.some(function (t) { return /^data DERIVED \| gaps 0\/1/.test(t); }));
        // bar: background + fill + two marks (lower red, target green)
        const marks = ops.filter(function (o) { return o.shape === 'line' && (o.args[4].color === COLORS.red || o.args[4].color === COLORS.ok); });
        assert.equal(marks.length, 2);
        assert.ok(marks[0].args[0] < marks[1].args[0], 'lower mark left of target mark');
        // creep labels
        assert.ok(texts.indexOf('harvester 1180') !== -1);
        assert.ok(texts.indexOf('mule 120') !== -1);
        // flow arrow from the source to the spawn sized by the last complete window
        const arrow = ops.find(function (o) { return o.shape === 'line' && o.args[0] === 10 && o.args[1] === 10 && o.args[2] === 25 && o.args[3] === 25; });
        assert.ok(arrow, 'source -> spawn arrow');
        assert.ok(texts.indexOf('harvest 400/100t') !== -1);
    });

    test(label + ': layout: UNKNOWN is a grey "?" and never 0', function () {
        const mo = model({
            shadowRoom: H.shadowRoom({ forecast: H.forecast(1040, { free: H.m(null, 'NO_HISTORY'), income: H.m(null, 'NO_HISTORY'), quality: 'UNKNOWN' }), flowWindows: [H.windowAt(1000, 0, false)], ring: [H.fullRecord(1000, { unknown: ['NO_HISTORY'], reserve: null })] }),
            creeps: [H.creep('h1', 'harvester', null, 11, 10)],
        });
        const ops = buildDrawOps(mo);
        const texts = textsOf(ops);
        const energy = ops.find(function (o) { return o.shape === 'text' && /^free /.test(o.args[0]); });
        assert.equal(energy.args[0], 'free ? (NO_HISTORY) | reserve ?/? | age 10');
        assert.equal(energy.args[3].color, COLORS.unknown);
        assert.ok(texts.indexOf('income >= ? (NO_HISTORY)') !== -1);
        assert.ok(texts.indexOf('next deficit ?') !== -1);
        assert.ok(texts.some(function (t) { return /\| \? NO_HISTORY$/.test(t); }), 'UNKNOWN cause listed with ?');
        assert.ok(texts.indexOf('harvester ?') !== -1, 'unknown TTL is ?');
        assert.ok(texts.indexOf(UNKNOWN_MARK) !== -1, 'empty bar marked ?');
        for (const t of texts) assert.ok(!/free 0|income >= 0|harvester 0/.test(t), 'no fabricated zero: ' + t);
        // no complete window -> no arrows
        assert.equal(ops.filter(function (o) { return o.shape === 'line' && o.args[0] === 10; }).length, 0);
    });

    test(label + ': layout: spawn lines compare shadow proposal with legacy actual; divergence highlighted; late replacement red', function () {
        const ring = [H.fullRecord(1045, { mode: 'STABILIZE', since: 1045, needs: [DUE_MULE], alternatives: [SPAWN_MULE], legacy: { status: 'LEGACY_BEHIND', spawning: [], late: [{ key: DUE_MULE.key, fn: 'feed', startBy: 1040 }] } })];
        const mo = model({ shadowRoom: H.shadowRoom({ ring: ring }) });
        assert.equal(mo.plan.kind, 'spawn');
        assert.equal(mo.plan.fn, 'feed');
        assert.equal(mo.spawns[0].diverge, true);
        const ops = buildDrawOps(mo);
        const texts = textsOf(ops);
        assert.ok(texts.indexOf('shadow: spawn feed 200e') !== -1);
        const legacyLine = ops.find(function (o) { return o.shape === 'text' && o.args[0] === 'legacy: idle'; });
        assert.equal(legacyLine.args[3].color, COLORS.red);
        assert.ok(ops.some(function (o) { return o.shape === 'circle' && o.args[2].stroke === COLORS.red; }), 'divergence ring at the spawn');
        const repl = ops.find(function (o) { return o.shape === 'text' && o.args[0] === 'repl @1040'; });
        assert.ok(repl, 'replacement label under m1');
        assert.equal(repl.args[3].color, COLORS.red, 'late replacement is red');
        assert.equal(repl.args[1], 24);
        assert.ok(panelLines(mo).some(function (l) { return l.text === 'legacy LEGACY_BEHIND late feed@1040'; }));
        // legacy now spawning the same function: no divergence
        const same = model({ shadowRoom: H.shadowRoom({ ring: ring }), spawning: { name: 'm2', needTime: 12, remainingTime: 5 }, creeps: [H.creep('m1', 'mule', 20, 24, 25), Object.assign(H.creep('m2', 'mule', 1500, 25, 25), { spawning: true })] });
        assert.equal(same.spawns[0].legacyText, 'legacy: mule m2');
        assert.equal(same.spawns[0].diverge, false);
        assert.equal(creepOfNeedKey('W1N1/legacy/feed/m1#g2'), 'm1');
        assert.equal(creepOfNeedKey('W1N1/emergency/feed#g1'), null);
    });

    test(label + ': layout: element count is bounded', function () {
        const creeps = [];
        for (let i = 0; i < 60; i++) creeps.push(H.creep('c' + String(i).padStart(2, '0'), 'harvester', 500, i % 50, 5 + (i % 40)));
        const mo = model({ creeps: creeps });
        assert.ok(mo.creeps.length <= 20, 'creep labels capped');
        assert.ok(buildDrawOps(mo).length <= 64);
        assert.equal(buildDrawOps(mo, { maxOps: 10 }).length, 10);
        assert.equal(buildDrawOps(mo, { maxOps: 10 })[0].shape, 'rect', 'panel first');
    });

    test(label + ': layout: an interruption record shows the interruption and keeps the carried mode', function () {
        const ring = [H.fullRecord(1000), H.interruptionRecord(1049, { mode: 'GROW', since: 1000, hold: null })];
        const mo = model({ shadowRoom: H.shadowRoom({ ring: ring }) });
        assert.equal(mo.mode.mode, 'GROW');
        assert.equal(mo.maturity, 'BASIC', 'maturity from the newest full record');
        assert.ok(textsOf(buildDrawOps(mo)).indexOf('interrupted t1049: BUDGET_DEFERRED (forecast.shadow)') !== -1);
    });

    test(label + ': flags: default off, console default on, invalid ignored, only shadow rooms', function () {
        assert.deepEqual(resolveFlags(undefined, [ROOM]), { overlayRooms: [], console: true, problem: null });
        assert.deepEqual(resolveFlags({}, [ROOM]), { overlayRooms: [], console: true, problem: null });
        assert.deepEqual(resolveFlags({ rooms: { W1N1: { overlay: true }, W2N2: { overlay: true } } }, [ROOM]), { overlayRooms: [ROOM], console: true, problem: null });
        assert.deepEqual(resolveFlags({ rooms: { W1N1: { overlay: false } }, console: false }, [ROOM]), { overlayRooms: [], console: false, problem: null });
        const bad = resolveFlags({ rooms: { W1N1: { overlay: 'on' } }, console: false }, [ROOM]);
        assert.deepEqual(bad.overlayRooms, []);
        assert.equal(bad.console, true, 'invalid content ignored as a whole');
        assert.match(bad.problem, /EXPECTED_BOOLEAN/);
        assert.equal(resolveFlags([1, 2], [ROOM]).problem !== null, true);
        assert.equal(resolveFlags({ invalid: 'TOO_LARGE' }, [ROOM]).problem, 'TOO_LARGE');
    });

    test(label + ': events: a line per change only, coloured, prefixed [shadow <room> t<tick>]', function () {
        const m1 = model();
        const s1 = Events.eventState(m1);
        const first = Events.diffEvents(null, s1, m1);
        assert.deepEqual(first.map(function (e) { return e.kind; }), ['mode']);
        assert.equal(Events.diffEvents(s1, s1, m1).length, 0, 'no change -> no line');
        const ring = [H.fullRecord(1000), H.fullRecord(1045, { mode: 'STABILIZE', since: 1045, reasonCode: 'INSUFFICIENT_LIQUIDITY', unknown: ['NO_HISTORY'], needs: [DUE_MULE], alternatives: [SPAWN_MULE], legacy: { status: 'LEGACY_BEHIND', spawning: [], late: [{ key: DUE_MULE.key, fn: 'feed', startBy: 1040 }] } })];
        const m2 = model({ shadowRoom: H.shadowRoom({ ring: ring }), proposals: [H.proposal('sp:W1N1:abc', 'feed', 200, 1040)] });
        const s2 = Events.eventState(m2);
        const ev = Events.diffEvents(s1, s2, m2);
        assert.deepEqual(ev.map(function (e) { return e.kind; }), ['mode', 'proposals', 'divergence', 'unknown']);
        assert.equal(ev[0].text, 'mode GROW -> STABILIZE since t1045 (INSUFFICIENT_LIQUIDITY)');
        assert.equal(ev[1].text, 'proposals: feed 200e @t1040 SHADOW_ONLY');
        assert.match(ev[2].text, /^divergence LEGACY_BEHIND: shadow due feed@1040; legacy spawning nothing \| shadow: spawn feed 200e$/);
        assert.equal(ev[3].text, 'new UNKNOWN cause: NO_HISTORY (shown as ?, not 0)');
        const line = Events.formatLine(ROOM, 1050, ev[0]);
        assert.equal(line, '[shadow W1N1 t1050] <span style="color:#ffcc66">mode GROW -&gt; STABILIZE since t1045 (INSUFFICIENT_LIQUIDITY)</span>');
        // known UNKNOWN cause again: no new line
        assert.equal(Events.diffEvents(s2, s2, m2).length, 0);
    });

    test(label + ': events: baseline after a reset = records before this tick (no repeated lines)', function () {
        const ring = [H.fullRecord(1000), H.fullRecord(1045, { mode: 'STABILIZE', since: 1045 })];
        const sr = H.shadowRoom({ ring: ring });
        const m1 = model({ shadowRoom: sr, tick: 1060 });
        const base = Events.baselineState(sr, [], 1060);
        assert.equal(Events.diffEvents(base, Events.eventState(m1), m1).length, 0, 'decision of t1045 already announced before the reset');
        const fresh = Events.baselineState(sr, [], 1045);
        assert.deepEqual(Events.diffEvents(fresh, Events.eventState(model({ shadowRoom: sr, tick: 1045 })), m1).map(function (e) { return e.kind; }), ['mode'], 'a decision recorded this tick is announced');
    });

    test(label + ': events: limiter caps lines per tick and dedupes repeated text', function () {
        const lim = Events.createEventLimiter({ maxLinesPerTick: 5, dedupeTicks: 100 });
        const verdicts = [];
        for (let i = 0; i < 7; i++) verdicts.push(lim.admit(ROOM, 10, 'line ' + i));
        assert.deepEqual(verdicts, ['PRINT', 'PRINT', 'PRINT', 'PRINT', 'PRINT', 'CAPPED', 'CAPPED']);
        assert.equal(lim.suppressed(), 2);
        assert.equal(lim.admit(ROOM, 11, 'line 0'), 'DUPLICATE');
        assert.equal(lim.admit(ROOM, 11, 'line 5'), 'PRINT', 'capped line printed next tick');
        assert.equal(lim.admit(ROOM, 111, 'line 0'), 'PRINT', 'after the dedupe window');
    });

    test(label + ': presenter: default flags -> no drawing; console lines on change only', function () {
        const ports = H.recordingPorts(undefined);
        const p = createPresenter(ports);
        const v = H.view(H.shadowRoom({ ring: [H.fullRecord(1050, { since: 1050 })] }));
        const snap = { kind: 'READY', value: { tick: 1050, rooms: { W1N1: H.roomSnapshot() }, ownCreeps: { h1: H.creep('h1', 'harvester', 1180, 11, 10) } } };
        for (let t = 1050; t < 1060; t++) {
            const r = p.component.run(H.frame(t, { 'boot.router': H.router([ROOM]), 'observe.snapshot': snap }, v));
            assert.equal(r.kind, 'READY');
            assert.equal(r.value.ops, 0);
        }
        assert.deepEqual(ports.ops, [], 'overlay off by default');
        assert.equal(ports.lines.length, 1, ports.lines.join('\n'));
        assert.match(ports.lines[0], /^\[shadow W1N1 t1050\] <span style="color:#ffcc66">mode GROW since t1050/);
        assert.equal(p.component.phase, 'CLOSE');
        assert.equal(p.component.budgetClass, 'optional');
    });

    test(label + ': presenter: overlay flag on -> bounded draw ops for that room only; console off -> no lines', function () {
        const ports = H.recordingPorts({ rooms: { W1N1: { overlay: true } }, console: false });
        const p = createPresenter(ports);
        const v = H.view(H.shadowRoom());
        const snap = { kind: 'READY', value: { tick: 1050, rooms: { W1N1: H.roomSnapshot() }, ownCreeps: { h1: H.creep('h1', 'harvester', 1180, 11, 10) } } };
        const r = p.component.run(H.frame(1050, { 'boot.router': H.router([ROOM]), 'observe.snapshot': snap }, v));
        assert.equal(r.kind, 'READY');
        assert.ok(r.value.ops > 5 && r.value.ops <= 64);
        assert.equal(ports.ops.length, r.value.ops);
        assert.ok(ports.ops.every(function (o) { return o.room === ROOM; }));
        assert.deepEqual(ports.lines, []);
    });

    test(label + ': presenter: no shadow room -> NOT_REQUESTED, flags never read; CPU shortage -> DEFERRED, nothing drawn', function () {
        const ports = H.recordingPorts({ rooms: { W1N1: { overlay: true } } });
        const p = createPresenter(ports);
        const v = H.view(H.shadowRoom());
        const none = p.component.run(H.frame(1050, { 'boot.router': H.router([]) }, v));
        assert.equal(none.kind, 'REJECTED');
        assert.equal(none.reasonCode, 'NOT_REQUESTED');
        assert.equal(ports.flagReads(), 0);
        // used 12 + prior 1.5 > min(20, 500) - 2 - 5 = 13
        const busy = p.component.run(H.frame(1051, { 'boot.router': H.router([ROOM]) }, v, H.cpuPort({ used: 12 })));
        assert.equal(busy.kind, 'DEFERRED');
        assert.equal(busy.reason, 'BUDGET_DEFERRED');
        const lowBucket = p.component.run(H.frame(1052, { 'boot.router': H.router([ROOM]) }, v, H.cpuPort({ bucket: 500 })));
        assert.equal(lowBucket.kind, 'DEFERRED');
        const unknownCpu = p.component.run(H.frame(1053, { 'boot.router': H.router([ROOM]) }, v, H.cpuPort({ used: null })));
        assert.equal(unknownCpu.kind, 'DEFERRED');
        assert.deepEqual(ports.ops, []);
        assert.deepEqual(ports.lines, []);
        const ok = p.component.run(H.frame(1054, { 'boot.router': H.router([ROOM]) }, v));
        assert.equal(ok.kind, 'READY');
        assert.ok(ports.ops.length > 0, 'draws again when CPU is available (no snapshot: panel only)');
    });

    test(label + ': presenter: invalid Memory.strategyView -> defaults and one rate-limited log line', function () {
        const ports = H.recordingPorts({ rooms: { W1N1: { overlay: 1 } } });
        const p = createPresenter(ports);
        const v = H.view(H.shadowRoom());
        for (let t = 1050; t < 1080; t++) p.component.run(H.frame(t, { 'boot.router': H.router([ROOM]) }, v));
        assert.deepEqual(ports.ops, [], 'invalid flags -> overlay stays off');
        assert.equal(ports.logs.length, 1);
        assert.equal(ports.logs[0][0], 'VIEW_FLAGS_INVALID');
    });

    test(label + ': presenter: a fresh heap (reset) does not repeat lines of earlier decisions', function () {
        const v = H.view(H.shadowRoom({ ring: [H.fullRecord(1000, { unknown: ['NO_HISTORY'] })] }));
        const a = H.recordingPorts(undefined);
        createPresenter(a).component.run(H.frame(1001, { 'boot.router': H.router([ROOM]) }, v));
        assert.equal(a.lines.length, 0, 'decision of t1000 predates this heap');
        const b = H.recordingPorts(undefined);
        createPresenter(b).component.run(H.frame(1000, { 'boot.router': H.router([ROOM]) }, v));
        assert.equal(b.lines.length, 2, 'recorded this tick -> announced: ' + b.lines.join('\n'));
    });

    test(label + ': presenter: capped lines are retried on the next tick, never lost', function () {
        const ports = H.recordingPorts(undefined);
        const p = createPresenter(Object.assign({}, ports, { limits: { maxLinesPerTick: 1 } }));
        const ring = [H.fullRecord(1050, { mode: 'STABILIZE', since: 1050, unknown: ['NO_HISTORY'] })];
        const v = H.view(H.shadowRoom({ ring: ring }), { a: H.proposal('a', 'feed', 150, 1060) });
        p.component.run(H.frame(1050, { 'boot.router': H.router([ROOM]) }, v));
        p.component.run(H.frame(1051, { 'boot.router': H.router([ROOM]) }, v));
        p.component.run(H.frame(1052, { 'boot.router': H.router([ROOM]) }, v));
        p.component.run(H.frame(1053, { 'boot.router': H.router([ROOM]) }, v));
        assert.equal(ports.lines.length, 2, ports.lines.join('\n'));
        assert.match(ports.lines[0], /t1050\].*mode STABILIZE/);
        assert.match(ports.lines[1], /t1051\].*new UNKNOWN cause: NO_HISTORY/);
    });

    test(label + ': ports: VisualPort draws over RoomVisual, one visual per room and tick; no RoomVisual -> no-op', function () {
        const rec = createRoomVisualRecorder();
        let time = 5;
        const port = P.createVisualPort(function () { return rec.RoomVisual; }, function () { return { time: time }; });
        assert.equal(port.available(), true);
        assert.equal(port.text(ROOM, 'hi', 1, 2, { color: '#fff' }), true);
        port.rect(ROOM, 0, 0, 1, 1, {});
        port.line(ROOM, 0, 0, 1, 1, {});
        port.circle(ROOM, 3, 3, {});
        port.poly(ROOM, [[1, 1], [2, 2]], {});
        assert.deepEqual(rec.journal.constructed, [ROOM]);
        time = 6;
        port.text(ROOM, 'again', 1, 2, {});
        assert.deepEqual(rec.journal.constructed, [ROOM, ROOM]);
        assert.deepEqual(rec.journal.ops.map(function (o) { return o.shape; }), ['text', 'rect', 'line', 'circle', 'poly', 'text']);
        assert.equal(port.text('bad room', 'x', 1, 1, {}), false);
        const none = P.createVisualPort(function () { return undefined; });
        assert.equal(none.available(), false);
        assert.equal(none.text(ROOM, 'x', 1, 1, {}), false);
    });

    test(label + ': ports: OperatorFlagReader returns a copy and never writes; ConsolePort caps line length', function () {
        const mem = createTrapMemory({ strategyView: { rooms: { W1N1: { overlay: true } } }, creeps: {} }, { allowedRootKeys: [] });
        const reader = P.createOperatorFlagReader(function () { return mem.Memory; });
        const copy = reader.read();
        copy.rooms.W1N1.overlay = false;
        assert.equal(mem.raw.strategyView.rooms.W1N1.overlay, true);
        assert.deepEqual(mem.journal.writes, []);
        assert.equal(P.createOperatorFlagReader(function () { return {}; }).read(), undefined);
        const huge = { strategyView: { rooms: {} } };
        huge.strategyView.junk = 'x'.repeat(P.MAX_VIEW_FLAGS_CHARS);
        assert.deepEqual(P.createOperatorFlagReader(function () { return huge; }).read(), { invalid: 'TOO_LARGE' });
        const out = [];
        P.createConsolePort(function (l) { out.push(l); }).log('y'.repeat(2000));
        assert.equal(out[0].length, 600);
    });

    test(label + ': ports: OperatorCommandPort writes only Memory.strategyView / strategyShadow.exportRequest, validated', function () {
        const mem = createTrapMemory({ creeps: { a: { role: 'x' } }, strategyShadow: { schemaVersion: 1, rooms: {}, ledger: { reservations: {} }, observedOperations: {}, proposals: {} } }, { allowedRootKeys: ['strategyView', 'strategyShadow'] });
        const op = P.createOperatorCommandPort(function () { return mem.Memory; });
        assert.deepEqual(op.setOverlay('nope', true), { ok: false, error: 'BAD_ROOM_NAME' });
        assert.deepEqual(op.setOverlay(ROOM, 'on'), { ok: false, error: 'EXPECTED_BOOLEAN' });
        assert.deepEqual(mem.journal.writes, []);
        assert.equal(op.setOverlay(ROOM, true).ok, true);
        assert.deepEqual(mem.raw.strategyView, { rooms: { W1N1: { overlay: true } } });
        mem.raw.strategyView.console = false;
        op.setOverlay('W2N2', false);
        assert.deepEqual(mem.raw.strategyView, { rooms: { W1N1: { overlay: true }, W2N2: { overlay: false } }, console: false });
        mem.raw.strategyView = 'garbage';
        op.setOverlay(ROOM, true);
        assert.deepEqual(mem.raw.strategyView, { rooms: { W1N1: { overlay: true } } }, 'invalid content replaced by a valid object');
        assert.deepEqual(op.requestExport({ requested: true, ticks: 0 }), { ok: false, error: 'BELOW_MIN' });
        assert.equal(op.requestExport({ requested: true, ticks: 5, tickFrom: 101 }).ok, true);
        assert.deepEqual(mem.raw.strategyShadow.exportRequest, { requested: true, ticks: 5, tickFrom: 101 });
        assert.deepEqual(mem.journal.violations, []);
        const roots = Array.from(new Set(mem.journal.writes.map(function (w) { return w.where.split('.')[1]; }))).sort();
        assert.deepEqual(roots, ['strategyShadow', 'strategyView']);
        assert.ok(mem.journal.writes.filter(function (w) { return w.where.indexOf('Memory.strategyShadow') === 0; }).every(function (w) { return w.where === 'Memory.strategyShadow.exportRequest'; }));
        const empty = P.createOperatorCommandPort(function () { return {}; });
        assert.deepEqual(empty.requestExport({ requested: true, ticks: 5 }), { ok: false, error: 'NO_SHADOW_STATE' });
    });

    test(label + ': commands: strat.* signatures, validation, report/why text', function () {
        const writes = [];
        const operator = {
            setOverlay: function (room, on) { if (typeof on !== 'boolean') return { ok: false, error: 'EXPECTED_BOOLEAN' }; writes.push(['overlay', room, on]); return { ok: true, value: {} }; },
            requestExport: function (req) { writes.push(['export', req]); return { ok: true, value: req }; },
            readFlags: function () { return undefined; },
        };
        const ring = [H.fullRecord(1045, { needs: [DUE_MULE], alternatives: [SPAWN_MULE], legacy: { status: 'LEGACY_BEHIND', spawning: [], late: [{ key: DUE_MULE.key, fn: 'feed', startBy: 1040 }] } })];
        const v = H.view(H.shadowRoom({ ring: ring }));
        const presenter = createPresenter(H.recordingPorts(undefined));
        presenter.component.run(H.frame(1050, { 'boot.router': H.router([ROOM]), 'observe.snapshot': { kind: 'READY', value: { tick: 1050, rooms: { W1N1: H.roomSnapshot() }, ownCreeps: {} } } }, v));
        const strat = createStratCommands({ operator: operator, view: function () { return v; }, modelFor: presenter.modelFor, clock: { tick: function () { return 1050; } } });
        assert.deepEqual(Object.keys(strat).sort(), ['export', 'help', 'report', 'visual', 'why']);
        assert.match(strat.help(), /strat\.visual\(room, on\)/);
        assert.match(strat.visual(ROOM, true), /^strat: overlay W1N1 on$/);
        assert.match(strat.visual('W9N9'), /not in shadow/);
        assert.match(strat.visual(ROOM, 'x'), /not changed \(EXPECTED_BOOLEAN\)/);
        assert.match(strat.export(0), /usage/);
        assert.match(strat.export(50), /usage/);
        assert.match(strat.export('5'), /usage/);
        assert.match(strat.export(10), /requested from t1051/);
        assert.deepEqual(writes, [['overlay', ROOM, true], ['overlay', 'W9N9', true], ['export', { requested: true, ticks: 10, tickFrom: 1051 }]]);
        const report = strat.report(ROOM);
        assert.match(report, /^\[shadow W1N1\] W1N1 shadow GROW since t1000/);
        assert.match(report, /Spawn1: shadow spawn feed 200e \| legacy: idle  <- DIVERGES/);
        assert.equal(strat.report(), report, 'all shadow rooms when omitted');
        const why = strat.why(ROOM);
        assert.match(why, /decision dr:W1N1:1045:0 t1045: SHADOW_ONLY/);
        assert.match(why, /alternatives: spawn:W1N1\/legacy\/feed\/m1#g1 yes CRITICAL_DEADLINE/);
        assert.match(why, /legacy LEGACY_BEHIND/);
        assert.match(strat.why('bad'), /usage/);
        const noState = createStratCommands({ operator: operator, view: function () { return null; }, modelFor: presenter.modelFor, clock: { tick: function () { return null; } } });
        assert.match(noState.report(ROOM), /no shadow state/);
    });

    test(label + ': runtime ports: createRuntimePorts reads nothing at creation; CommandHost installs only strat', function () {
        const mem = createTrapMemory({}, { allowedRootKeys: [] });
        const game = createTrapGame({ time: 1 });
        const host = {};
        const ports = P.createRuntimePorts({ getGame: function () { return game.Game; }, getMemory: function () { return mem.Memory; }, getGlobal: function () { return host; }, getRoomVisual: function () { return undefined; } });
        assert.deepEqual(mem.journal.reads, []);
        assert.deepEqual(game.journal.reads, []);
        assert.equal(ports.commands.install('strat', { help: function () { return 'x'; } }), true);
        assert.equal(host.strat.help(), 'x');
        assert.throws(function () { ports.commands.install('Game', {}); }, TypeError);
    });
}

module.exports = { defineTests };
