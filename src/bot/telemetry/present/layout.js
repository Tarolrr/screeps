// Overlay layout (STRAT-VIEW, contract A.5): RoomModel -> bounded list of draw ops.
//
//   buildDrawOps(model, {maxOps?}) -> [{shape, args}]   shape in VisualPort shapes
//   panelLines(model) -> [{text, color}]                 also used by strat.report
//
// Pure: no ports. The presenter forwards each op to VisualPort[shape](room, ...args).
// Order = priority (panel, spawns, flows, creeps); the list is cut at maxOps so the
// visual budget is bounded whatever the room holds. UNKNOWN is drawn as a grey '?'.

const COLORS = Object.freeze({
    GROW: '#66cc66', STABILIZE: '#ffcc66', ALERT: '#ff9966', RECOVER: '#ff6666', SIEGE: '#ff44ff',
    text: '#dddddd', dim: '#aaaaaa', unknown: '#888888', red: '#ff4444', warn: '#ffaa33', ok: '#66cc66',
    bar: '#333333', flow: '#ffee55',
});

const DEFAULT_MAX_OPS = 64;
const PANEL_X = 0.6;
const PANEL_Y = 0.9;
const LINE_H = 0.75;
const BAR_W = 9;
const UNKNOWN_MARK = '?';

function num(value) {
    return value === null || value === undefined ? UNKNOWN_MARK : String(Math.round(value));
}

/** "?" (grey) for UNKNOWN measured values, never 0. */
function measuredText(m) {
    return m && m.value !== null ? String(Math.round(m.value)) : UNKNOWN_MARK;
}

function modeColor(mode) {
    return mode && COLORS[mode] ? COLORS[mode] : COLORS.unknown;
}

/**
 * Panel text lines of the room (overlay corner panel and strat.report).
 * @returns {Array<{text:string, color:string, key:string}>}
 */
function panelLines(model) {
    const out = [];
    const m = model.mode;
    out.push({ key: 'mode', color: modeColor(m ? m.mode : null), text: model.roomName + ' shadow ' + (m ? m.mode + ' since t' + m.since + (m.hold ? ' (hold ' + m.hold.mode + ')' : '') : UNKNOWN_MARK + ' (no decision yet)') });
    out.push({ key: 'reason', color: COLORS.dim, text: 'reason ' + (model.reason || UNKNOWN_MARK) + ' | ' + (model.maturity || UNKNOWN_MARK) + ' | threat ' + (model.threat || UNKNOWN_MARK) });
    if (model.interruption) out.push({ key: 'interrupted', color: COLORS.warn, text: 'interrupted t' + model.interruption.tick + ': ' + model.interruption.reason + (model.interruption.component ? ' (' + model.interruption.component + ')' : '') });
    const e = model.energy;
    const freeUnknown = e.free.value === null;
    out.push({ key: 'energy', color: freeUnknown ? COLORS.unknown : e.status === 'BELOW_LOWER' ? COLORS.red : e.status === 'BELOW_TARGET' ? COLORS.warn : COLORS.text,
        text: 'free ' + measuredText(e.free) + (freeUnknown && e.free.reason ? ' (' + e.free.reason + ')' : '') + ' | reserve ' + num(e.lower) + '/' + num(e.target) + (model.quality.age !== null ? ' | age ' + model.quality.age : '') });
    const inc = model.income;
    out.push({ key: 'income', color: inc.per100 === null ? COLORS.unknown : COLORS.text, text: 'income >= ' + (inc.per100 === null ? UNKNOWN_MARK + ' (' + (inc.reason || 'UNKNOWN') + ')' : inc.per100 + '/100t (' + inc.quality + ')') });
    const d = model.deficit;
    out.push({ key: 'deficit', color: d.tick !== null ? COLORS.warn : d.unknown ? COLORS.unknown : COLORS.text, text: 'next deficit ' + (d.tick !== null ? '@t' + d.tick : d.unknown ? UNKNOWN_MARK : 'none') });
    const q = model.quality;
    out.push({ key: 'quality', color: q.forecast === 'UNKNOWN' || q.unknown.length > 0 ? COLORS.unknown : COLORS.dim,
        text: 'data ' + q.forecast + ' | gaps ' + q.gaps + '/' + q.windows + (q.unknown.length > 0 ? ' | ' + UNKNOWN_MARK + ' ' + q.unknown.join(',') : '') });
    out.push({ key: 'plan', color: model.plan.kind === 'spawn' ? COLORS.ok : model.plan.kind === 'defer' ? COLORS.warn : COLORS.dim, text: 'shadow: ' + model.plan.text });
    if (model.legacy && model.legacy.status !== 'CONSISTENT') {
        out.push({ key: 'legacy', color: model.legacy.status === 'UNKNOWN' ? COLORS.unknown : COLORS.red, text: 'legacy ' + model.legacy.status + (model.legacy.late.length > 0 ? ' late ' + model.legacy.late.join(',') : '') });
    }
    return out;
}

/**
 * @param {object} model RoomModel (present/model.js)
 * @param {{maxOps?: number}} [options]
 * @returns {Array<{shape:string, args:Array}>}
 */
function buildDrawOps(model, options) {
    const maxOps = options && options.maxOps !== undefined ? options.maxOps : DEFAULT_MAX_OPS;
    const ops = [];
    function push(shape, args) { if (ops.length < maxOps) ops.push({ shape: shape, args: args }); }

    // corner panel
    const lines = panelLines(model);
    const barLine = 1 + (model.interruption ? 1 : 0) + 1; // after the energy line
    const height = (lines.length + 1) * LINE_H + 0.3;
    push('rect', [PANEL_X - 0.4, PANEL_Y - 0.65, BAR_W + 4.6, height, { fill: '#000000', opacity: 0.45, stroke: modeColor(model.mode ? model.mode.mode : null), strokeWidth: 0.05 }]);
    let y = PANEL_Y;
    for (let i = 0; i < lines.length; i++) {
        push('text', [lines[i].text, PANEL_X, y, { color: lines[i].color, font: i === 0 ? 0.6 : 0.5, align: 'left' }]);
        y += LINE_H;
        if (i === barLine) {
            // free energy bar with lower/target reserve marks
            const e = model.energy;
            const yb = y - LINE_H * 0.55;
            push('rect', [PANEL_X, yb, BAR_W, 0.3, { fill: COLORS.bar, opacity: 0.8 }]);
            const scale = Math.max(1, e.free.value || 0, e.target || 0, e.lower || 0) * 1.15;
            if (e.free.value !== null) {
                const w = Math.max(0, Math.min(BAR_W, BAR_W * e.free.value / scale));
                const fill = e.status === 'BELOW_LOWER' ? COLORS.red : e.status === 'BELOW_TARGET' ? COLORS.warn : COLORS.ok;
                if (w > 0) push('rect', [PANEL_X, yb, w, 0.3, { fill: fill, opacity: 0.9 }]);
            } else {
                push('text', [UNKNOWN_MARK, PANEL_X + BAR_W / 2, yb + 0.25, { color: COLORS.unknown, font: 0.4 }]);
            }
            if (e.lower !== null) { const xl = PANEL_X + BAR_W * Math.min(1, e.lower / scale); push('line', [xl, yb - 0.1, xl, yb + 0.4, { color: COLORS.red, width: 0.08 }]); }
            if (e.target !== null) { const xt = PANEL_X + BAR_W * Math.min(1, e.target / scale); push('line', [xt, yb - 0.1, xt, yb + 0.4, { color: COLORS.ok, width: 0.08 }]); }
            y += LINE_H * 0.4;
        }
    }

    // spawns: shadow proposal vs legacy actual, divergence highlighted
    for (let i = 0; i < model.spawns.length; i++) {
        const s = model.spawns[i];
        if (s.x === null) continue;
        if (s.diverge) push('circle', [s.x, s.y, { radius: 0.7, fill: 'transparent', stroke: COLORS.red, strokeWidth: 0.1, opacity: 0.9 }]);
        push('text', ['shadow: ' + model.plan.text, s.x, s.y - 1.5, { color: s.diverge ? COLORS.warn : COLORS.ok, font: 0.45, backgroundColor: '#000000', backgroundPadding: 0.05 }]);
        push('text', [s.legacyText, s.x, s.y - 0.9, { color: s.diverge ? COLORS.red : COLORS.dim, font: 0.45, backgroundColor: '#000000', backgroundPadding: 0.05 }]);
    }

    // flow arrows source -> spawn sized by the last complete window
    const arrows = model.flows.arrows;
    for (let i = 0; i < arrows.length; i++) {
        const a = arrows[i];
        const width = Math.max(0.05, Math.min(0.4, 0.05 + a.perTick / 20));
        push('line', [a.from.x, a.from.y, a.to.x, a.to.y, { color: COLORS.flow, width: width, opacity: 0.35 }]);
        push('circle', [a.to.x + (a.from.x - a.to.x) * 0.15, a.to.y + (a.from.y - a.to.y) * 0.15, { radius: width * 0.9, fill: COLORS.flow, opacity: 0.6 }]);
        if (i === 0) push('text', ['harvest ' + Math.round(a.perTick * 100 * arrows.length) + '/100t', (a.from.x + a.to.x) / 2, (a.from.y + a.to.y) / 2, { color: COLORS.flow, font: 0.4, opacity: 0.8 }]);
    }

    // own creeps: role, TTL, replacement start (red when late)
    for (let i = 0; i < model.creeps.length; i++) {
        const c = model.creeps[i];
        push('text', [(c.role || '?') + ' ' + measuredText(c.ttl), c.x, c.y - 0.55, { color: c.ttl.value === null ? COLORS.unknown : COLORS.text, font: 0.35, opacity: 0.85 }]);
        if (c.repl) push('text', ['repl @' + (c.repl.at === null ? UNKNOWN_MARK : c.repl.at), c.x, c.y + 0.85, { color: c.repl.late ? COLORS.red : COLORS.dim, font: 0.35 }]);
    }
    return ops;
}

module.exports = { COLORS, DEFAULT_MAX_OPS, UNKNOWN_MARK, buildDrawOps, panelLines, measuredText, modeColor };
