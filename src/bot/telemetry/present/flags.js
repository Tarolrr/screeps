// Operator view flags (STRAT-VIEW, contract A.5): Memory.strategyView -> presenter switches.
//
//   resolveFlags(raw, shadowRooms) -> {overlayRooms: string[], console: boolean, problem: (string|null)}
//
// raw is the copy returned by OperatorFlagReader.read(): undefined (absent), a JSON value,
// or {invalid: code}. Defaults: overlay OFF for every room, console ON (only meaningful
// while at least one room is in shadow). Invalid content is ignored as a whole (defaults
// apply) and reported as `problem` (the presenter logs it, rate-limited). Only shadow
// rooms can get an overlay.

const { validateStrategyView } = require('../../domain/stateLayout');

/**
 * @param {*} raw
 * @param {string[]} shadowRooms sorted
 */
function resolveFlags(raw, shadowRooms) {
    const out = { overlayRooms: [], console: true, problem: null };
    if (raw === undefined || raw === null) return out;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.invalid === 'string' && Object.keys(raw).length === 1) {
        out.problem = raw.invalid;
        return out;
    }
    const v = validateStrategyView(raw);
    if (!v.ok) {
        out.problem = v.errors[0].code + ' at ' + v.errors[0].path;
        return out;
    }
    if (typeof raw.console === 'boolean') out.console = raw.console;
    const rooms = raw.rooms || {};
    for (let i = 0; i < shadowRooms.length; i++) {
        const r = rooms[shadowRooms[i]];
        if (r && r.overlay === true) out.overlayRooms.push(shadowRooms[i]);
    }
    return out;
}

module.exports = { resolveFlags };
