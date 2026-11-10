// Console events (STRAT-VIEW, contract A.5): one line per CHANGE, never per tick.
//
//   eventState(model) -> {mode, proposals, divergence, unknown}   comparable signatures
//   baselineState(shadowRoom, proposals, tick) -> state as of the records BEFORE `tick`
//     (used after a global reset, when the heap lost the last emitted signatures, so a
//     reset does not repeat the lines of decisions already recorded)
//   diffEvents(prev, next, model) -> [{kind, text, color}]
//   createEventLimiter({maxLinesPerTick, dedupeTicks, maxRemembered}) -> {admit(room, tick, text)}
//   formatLine(room, tick, event) -> '[shadow <room> t<tick>] <span style="color:..">text</span>'
//
// Kinds: room mode change; new/changed proposal set; shadow-vs-legacy divergence (from the
// decision record comparison); new UNKNOWN cause. Pure except the limiter's own memory.

const { ringFacts } = require('./model');

const DEFAULT_LIMITS = Object.freeze({ maxLinesPerTick: 5, dedupeTicks: 100, maxRemembered: 64 });
const EVENT_COLORS = Object.freeze({ mode: '#ffcc66', proposals: '#66ccff', divergence: '#ff6666', unknown: '#aaaaaa', converged: '#66cc66' });

function proposalSig(p) {
    return p.id;
}

function divergenceOf(legacy) {
    if (!legacy) return null;
    return { status: legacy.status, late: legacy.late.slice().sort(), spawning: legacy.spawning.slice().sort() };
}

/** Comparable event state of a RoomModel. */
function eventState(model) {
    return {
        mode: model.mode ? model.mode.mode : null,
        modeSince: model.mode ? model.mode.since : null,
        reason: model.reason,
        proposals: model.proposals.map(proposalSig).sort().join(','),
        divergence: divergenceOf(model.legacy),
        unknown: model.quality.unknown.slice().sort(),
    };
}

/**
 * Event state as of the decision records strictly before `tick` (fallback after a reset).
 * The proposal set is taken as current (it is not historised): a reset never prints it.
 */
function baselineState(shadowRoom, proposals, tick) {
    const ring = shadowRoom && Array.isArray(shadowRoom.decisionRing) ? shadowRoom.decisionRing : [];
    const facts = ringFacts(ring, tick);
    const gov = facts.gov ? facts.gov.inputs.gov : null;
    const full = facts.full;
    const legacy = full && full.inputs.legacy ? full.inputs.legacy : null;
    return {
        mode: gov ? gov.mode : null,
        modeSince: gov ? gov.since : null,
        reason: facts.newest ? facts.newest.reasonCode : null,
        proposals: proposals.map(function (p) { return p.proposalId; }).sort().join(','),
        divergence: legacy ? divergenceOf({ status: legacy.status, late: (legacy.late || []).map(function (l) { return l.fn + '@' + l.startBy; }), spawning: (legacy.spawning || []).map(function (s) { return s.name; }) }) : null,
        unknown: full && Array.isArray(full.inputs.unknown) ? full.inputs.unknown.slice().sort() : [],
    };
}

function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {object|null} prev previous event state (null: nothing known -> everything is new)
 * @param {object} next eventState(model)
 * @param {object} model RoomModel (texts)
 * @returns {Array<{kind:string, text:string, color:string}>}
 */
function diffEvents(prev, next, model) {
    const out = [];
    const p = prev || { mode: null, modeSince: null, proposals: '', divergence: null, unknown: [] };
    if (next.mode !== null && (next.mode !== p.mode || next.modeSince !== p.modeSince)) {
        out.push({ kind: 'mode', color: EVENT_COLORS.mode, text: 'mode ' + (p.mode && p.mode !== next.mode ? p.mode + ' -> ' : '') + next.mode + ' since t' + next.modeSince + ' (' + (next.reason || '?') + ')' });
    }
    if (next.proposals !== p.proposals) {
        const text = model.proposals.length === 0 ? 'proposals cleared' : 'proposals: ' + model.proposals.map(function (x) {
            return (x.fn || '?') + (x.cost !== null ? ' ' + x.cost + 'e' : '') + (x.dueAt !== null ? ' @t' + x.dueAt : '') + ' ' + x.reason;
        }).join('; ');
        out.push({ kind: 'proposals', color: EVENT_COLORS.proposals, text: text });
    }
    const d = next.divergence;
    if (d !== null && !same(d, p.divergence)) {
        const diverging = d.status === 'LEGACY_BEHIND' || d.status === 'LEGACY_UNPLANNED_SPAWN';
        const wasDiverging = p.divergence !== null && (p.divergence.status === 'LEGACY_BEHIND' || p.divergence.status === 'LEGACY_UNPLANNED_SPAWN');
        if (diverging) {
            out.push({ kind: 'divergence', color: EVENT_COLORS.divergence, text: 'divergence ' + d.status + (d.late.length > 0 ? ': shadow due ' + d.late.join(',') : '') + (d.spawning.length > 0 ? '; legacy spawning ' + d.spawning.join(',') : '; legacy spawning nothing') + ' | shadow: ' + model.plan.text });
        } else if (wasDiverging && d.status === 'CONSISTENT') {
            out.push({ kind: 'divergence', color: EVENT_COLORS.converged, text: 'legacy consistent with shadow again' });
        }
    }
    const fresh = next.unknown.filter(function (c) { return p.unknown.indexOf(c) === -1; });
    if (fresh.length > 0) out.push({ kind: 'unknown', color: EVENT_COLORS.unknown, text: 'new UNKNOWN cause: ' + fresh.join(', ') + ' (shown as ?, not 0)' });
    return out;
}

/** Fields of the event state per kind (mergeState). */
const KIND_FIELDS = Object.freeze({ mode: ['mode', 'modeSince', 'reason'], proposals: ['proposals'], divergence: ['divergence'], unknown: ['unknown'] });

/**
 * State to remember after emitting: `next`, except the kinds whose line was not printed
 * (rate cap) keep their `prev` fields so the line is retried on the next tick.
 */
function mergeState(prev, next, keepKinds) {
    const out = Object.assign({}, next);
    const p = prev || { mode: null, modeSince: null, reason: null, proposals: '', divergence: null, unknown: [] };
    for (let i = 0; i < keepKinds.length; i++) {
        const fields = KIND_FIELDS[keepKinds[i]] || [];
        for (let f = 0; f < fields.length; f++) out[fields[f]] = p[fields[f]];
    }
    return out;
}

function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatLine(room, tick, event) {
    return '[shadow ' + room + ' t' + tick + '] <span style="color:' + event.color + '">' + escapeHtml(event.text) + '</span>';
}

/**
 * Per-tick line cap and per-room text dedupe (same text not repeated within dedupeTicks).
 * @param {{maxLinesPerTick?: number, dedupeTicks?: number, maxRemembered?: number}} [options]
 */
function createEventLimiter(options) {
    const cfg = Object.assign({}, DEFAULT_LIMITS, options || {});
    let tickNow = null;
    let used = 0;
    let suppressed = 0;
    const seen = {}; // room -> {text: tick}
    return {
        /** @returns {'PRINT'|'DUPLICATE'|'CAPPED'} PRINT: the line may be printed now */
        admit: function (room, tick, text) {
            if (tick !== tickNow) { tickNow = tick; used = 0; suppressed = 0; }
            const r = seen[room] || (seen[room] = {});
            if (r[text] !== undefined && tick - r[text] < cfg.dedupeTicks) return 'DUPLICATE';
            if (used >= cfg.maxLinesPerTick) { suppressed++; return 'CAPPED'; }
            used++;
            r[text] = tick;
            const keys = Object.keys(r);
            if (keys.length > cfg.maxRemembered) {
                keys.sort(function (a, b) { return r[a] - r[b]; });
                for (let i = 0; i < keys.length - cfg.maxRemembered; i++) delete r[keys[i]];
            }
            return 'PRINT';
        },
        suppressed: function () { return suppressed; },
        limits: cfg,
    };
}

module.exports = { DEFAULT_LIMITS, EVENT_COLORS, eventState, baselineState, diffEvents, mergeState, formatLine, createEventLimiter };
