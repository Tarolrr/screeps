// Operator console commands (STRAT-VIEW, contract A.5): `global.strat`.
//
//   createStratCommands({operator, view, modelFor, clock}) -> {report, why, visual, export, help}
//
//   strat.report(room?)      text summary of the room (all shadow rooms when omitted)
//   strat.why(room)          the newest decision record explained
//   strat.visual(room, on?)  Memory.strategyView.rooms[room] = {overlay: on} (on defaults to true)
//   strat.export(ticks)      Memory.strategyShadow.exportRequest = {requested: true, ticks, tickFrom: now + 1}
//   strat.help()             usage
//
// Installed by the composition root on the first loop (never at require). Commands run in
// the console sandbox outside loop: they read the StateView of the last opened tick and the
// presenter's last snapshot (read-only) and write ONLY through the OperatorCommandPort
// (Memory.strategyView, Memory.strategyShadow.exportRequest), validated. They return text.

const { isRoomName } = require('../../domain/keys');
const { LIMITS } = require('../../domain/stateLayout');
const { panelLines } = require('./layout');

const HELP = [
    'strat.report(room?)     shadow summary of a room (all shadow rooms when omitted)',
    'strat.why(room)         newest shadow decision record, explained',
    'strat.visual(room, on)  RoomVisual overlay on/off for a shadow room (Memory.strategyView)',
    'strat.export(ticks)     bounded replay export of the next 1..' + LIMITS.replayExportTicks + ' ticks (Memory.strategyShadow.exportRequest)',
    'strat.help()            this text',
    'Console event lines: [shadow <room> t<tick>] ...; off: Memory.strategyView.console = false',
].join('\n');

function shadowRoomsOfView(view) {
    const rooms = view && view.strategy && view.strategy.control ? view.strategy.control.rooms : {};
    return Object.keys(rooms).filter(function (r) { return rooms[r] && rooms[r].requestedMode === 'shadow'; }).sort();
}

function list(items) {
    return items.length === 0 ? '-' : items.join('; ');
}

/**
 * @param {Object} deps
 * @param {{setOverlay: function(string, boolean): object, requestExport: function(object): object, readFlags: function(): *}} deps.operator OperatorCommandPort
 * @param {function(): (object|null)} deps.view StateView of the last opened tick (read-only API)
 * @param {function(string, object): (object|null)} deps.modelFor presenter.modelFor
 * @param {{tick: function(): (number|null)}} deps.clock
 */
function createStratCommands(deps) {
    function guard(fn) {
        return function () {
            try { return fn.apply(null, arguments); } catch (error) { return 'strat: error ' + String(error && error.message ? error.message : error).slice(0, 300); }
        };
    }

    function reportRoom(view, room) {
        const model = deps.modelFor(room, view);
        if (model === null) return '[shadow ' + room + '] no shadow state';
        const lines = panelLines(model).map(function (l) { return l.text; });
        for (let i = 0; i < model.spawns.length; i++) lines.push(model.spawns[i].name + ': shadow ' + model.plan.text + ' | ' + model.spawns[i].legacyText + (model.spawns[i].diverge ? '  <- DIVERGES' : ''));
        if (model.proposals.length > 0) lines.push('proposals: ' + model.proposals.map(function (p) { return (p.fn || '?') + ' ' + (p.cost === null ? '?' : p.cost) + 'e @' + (p.dueAt === null ? '?' : p.dueAt) + ' ' + p.reason; }).join('; '));
        const repl = model.creeps.filter(function (c) { return c.repl; }).map(function (c) { return c.name + ' @' + (c.repl.at === null ? '?' : c.repl.at) + (c.repl.late ? ' LATE' : ''); });
        if (repl.length > 0) lines.push('replacements: ' + repl.join('; '));
        if (model.flows.window) lines.push('last window t' + model.flows.window.start + ': harvest ' + (model.flows.window.harvest.value === null ? '?' : model.flows.window.harvest.value) + ', upgrade ' + (model.flows.window.upgrade.value === null ? '?' : model.flows.window.upgrade.value) + ', internal ' + (model.flows.window.internal.value === null ? '?' : model.flows.window.internal.value) + ' (' + model.flows.window.quality + ')');
        return lines.map(function (l) { return '[shadow ' + room + '] ' + l; }).join('\n');
    }

    function report(room) {
        const view = deps.view();
        if (!view || !view.shadow) return 'strat: no shadow state (enable shadow for a room: see docs/strategy/SHADOW-A.md)';
        const rooms = room === undefined ? shadowRoomsOfView(view) : [room];
        if (room !== undefined && !isRoomName(room)) return 'strat: bad room name ' + String(room);
        if (rooms.length === 0) return 'strat: no room in shadow';
        return rooms.map(function (r) { return reportRoom(view, r); }).join('\n');
    }

    function why(room) {
        if (!isRoomName(room)) return 'strat: usage strat.why(room)';
        const view = deps.view();
        const sr = view && view.shadow ? view.shadow.rooms[room] : null;
        const ring = sr ? sr.decisionRing : [];
        if (!ring || ring.length === 0) return '[shadow ' + room + '] no decision recorded';
        const r = ring[ring.length - 1];
        const i = r.inputs || {};
        const out = [];
        out.push('decision ' + r.decisionId + ' t' + r.tick + ': ' + r.reasonCode + ' (' + r.resultKind + ', executed ' + r.executed + ')');
        if (i.gov) out.push('mode ' + i.gov.mode + ' since t' + i.gov.since + (i.gov.hold ? ' hold ' + i.gov.hold.mode + ' clearSince ' + i.gov.hold.clearSince : '') + (i.raw ? ' raw ' + i.raw : ''));
        if (i.interruption) out.push('interruption ' + JSON.stringify(i.interruption));
        if (i.maturity) out.push('maturity ' + i.maturity + ' | threat ' + (i.threat ? i.threat.threat : '?') + ' | signals ' + list(i.signals || []));
        if (Array.isArray(i.needs)) out.push('needs: ' + list(i.needs.map(function (n) { return n.fn + ' ' + n.crit + ' start @' + (n.startBy === null ? '?' : n.startBy) + ' ' + n.cost + 'e' + (n.due ? ' DUE' : '') + ' ' + n.reason; })));
        out.push('alternatives: ' + list((r.alternatives || []).map(function (a) { return a.label + ' ' + (a.accepted ? 'yes' : 'no') + ' ' + a.reasonCode; })));
        if (i.legacy) out.push('legacy ' + i.legacy.status + ' | spawning ' + list((i.legacy.spawning || []).map(function (s) { return s.name + '(' + s.role + ')'; })) + ' | late ' + list((i.legacy.late || []).map(function (l) { return l.fn + '@' + l.startBy; })));
        if (Array.isArray(i.unknown) && i.unknown.length > 0) out.push('UNKNOWN: ' + i.unknown.join(', '));
        if (i.balance) out.push('balance ' + JSON.stringify(i.balance).slice(0, 400));
        if (r.expectedNextFact) out.push('next fact ' + JSON.stringify(r.expectedNextFact));
        return out.map(function (l) { return '[shadow ' + room + '] ' + l; }).join('\n');
    }

    function visual(room, on) {
        const flag = on === undefined ? true : on;
        const res = deps.operator.setOverlay(room, flag);
        if (!res.ok) return 'strat: visual not changed (' + res.error + '); usage strat.visual(room, true|false)';
        const view = deps.view();
        const inShadow = shadowRoomsOfView(view).indexOf(room) !== -1;
        return 'strat: overlay ' + room + ' ' + (flag ? 'on' : 'off') + (flag && !inShadow ? ' (room is not in shadow: nothing is drawn until requestedMode is shadow)' : '');
    }

    function exportTicks(ticks) {
        if (!Number.isInteger(ticks) || ticks < 1 || ticks > LIMITS.replayExportTicks) return 'strat: usage strat.export(ticks), ticks 1..' + LIMITS.replayExportTicks;
        const now = deps.clock.tick();
        const res = deps.operator.requestExport({ requested: true, ticks: ticks, tickFrom: now === null ? null : now + 1 });
        if (!res.ok) return 'strat: export not requested (' + res.error + ')';
        return 'strat: export of ' + ticks + ' ticks requested from t' + res.value.tickFrom + '; status in Memory.strategyShadow.replayExport';
    }

    return Object.freeze({
        report: guard(report),
        why: guard(why),
        visual: guard(visual),
        export: guard(exportTicks),
        help: function () { return HELP; },
    });
}

module.exports = { HELP, createStratCommands };
