// Analytic travel estimate for replacements of legacy creeps (STRAT-A5).
//
// Pure: Snapshot values in, Measured travel times out (domain only).
//
// DESIGN §7: until reliable path statistics exist, travel uses the "upper fatigue
// model +25%". Stage A has no path/terrain DTO, so the distance is path-free:
//
//   distance  = Chebyshev range from a spawn of the room to the work target of the
//               role's function, worst spawn and worst target of the room;
//   perTile   = max(1, ceil(nonMoveParts / moveParts))      (plain terrain, loaded:
//               every non-MOVE part incl. CARRY generates fatigue 2, MOVE removes 2);
//   travel    = ceil(distance × perTile × 1.25)             quality ESTIMATED.
//
// Labelled ESTIMATED, NOT a proven bound: walls/detours and swamps can make the
// real path longer than the Chebyshev range. It exists so that reserves of legacy
// rooms are not permanently UNKNOWN; it never replaces measured data. Missing
// inputs (no visible room, no spawn position, no target, no MOVE part) leave the
// key absent, so the A4 models keep UNKNOWN(MISSING_FIELD).
//
// Targets per function: harvest/feed -> farthest source (feed shuttles source<->spawn);
// upgrade/build/other -> farthest interior tile of the room (the controller DTO has no
// position in contract A.2).
//
// Keys of the result (ReplacementForecast/ForecastCalendar lookup order):
//   '<room>/legacy/<role|unknown>/<creep>'  per legacy executor (its own body);
//   'emergency:harvest', 'emergency:feed'   emergency templates of ForecastCalendar.

const { measured } = require('../domain/dtos');
const { Quality, Visibility } = require('../domain/enums');

/** DESIGN §7 upper fatigue model. */
const FATIGUE_MARGIN = 1.25;

/** Same templates as ForecastCalendar.DEFAULT_EMERGENCY_TEMPLATES (bodies only). */
const EMERGENCY_BODIES = Object.freeze({
    harvest: Object.freeze(['work', 'carry', 'move']),
    feed: Object.freeze(['carry', 'carry', 'move']),
});

function chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * @param {string[]} body part types
 * @returns {number|null} ticks per plain tile when loaded; null when the body cannot move
 */
function ticksPerTile(body) {
    let move = 0;
    let other = 0;
    for (let i = 0; i < body.length; i++) {
        if (body[i] === 'move') move++;
        else other++;
    }
    if (move === 0) return null;
    return Math.max(1, Math.ceil(other / move));
}

/**
 * Worst Chebyshev distance of the room from any spawn to the targets of `fn`.
 * harvest/feed: the farthest source. Other functions (upgrade, build, other): the
 * controller DTO carries no position (contract A.2), so the farthest interior tile
 * of the room (1..48) bounds the range from the spawn.
 * @returns {number|null}
 */
function worstDistance(room, fn) {
    const spawns = room.spawns.filter(function (s) { return !!s.pos && s.pos.roomName === room.roomName; });
    if (spawns.length === 0) return null;
    let worst = 0;
    if (fn === 'harvest' || fn === 'feed') {
        const sources = room.sources.filter(function (s) { return !!s.pos; });
        if (sources.length === 0) return null;
        for (let s = 0; s < spawns.length; s++) {
            for (let t = 0; t < sources.length; t++) worst = Math.max(worst, chebyshev(spawns[s].pos, sources[t].pos));
        }
        return worst;
    }
    for (let s = 0; s < spawns.length; s++) {
        const p = spawns[s].pos;
        worst = Math.max(worst, p.x - 1, 48 - p.x, p.y - 1, 48 - p.y);
    }
    return worst;
}

/**
 * @param {number} distance
 * @param {string[]} body
 * @returns {object|null} Measured ESTIMATED travel, or null when not computable
 */
function travelFor(distance, body) {
    const perTile = ticksPerTile(body);
    if (distance === null || perTile === null) return null;
    return measured(Math.ceil(distance * perTile * FATIGUE_MARGIN), Quality.ESTIMATED);
}

/**
 * Travel estimates for the replacements of one room.
 * @param {object} snapshot Snapshot (filtered or full)
 * @param {string} roomName
 * @param {{observedBindings?: object, functionOf: function(string|null): string}} options
 *   functionOf: legacy role -> function (ReplacementForecast.functionOf, injected by the caller)
 * @returns {Object<string, object>} key -> Measured (keys absent when not computable)
 */
function estimateTravel(snapshot, roomName, options) {
    const out = {};
    const room = snapshot.rooms[roomName];
    if (!room || room.visibility !== Visibility.VISIBLE) return out;
    const opts = options || {};
    const bindings = opts.observedBindings || {};
    const functionOf = opts.functionOf;
    const distances = {};
    function distanceOf(fn) {
        if (!Object.prototype.hasOwnProperty.call(distances, fn)) distances[fn] = worstDistance(room, fn);
        return distances[fn];
    }
    const names = Object.keys(snapshot.ownCreeps).sort();
    for (let i = 0; i < names.length; i++) {
        const c = snapshot.ownCreeps[names[i]];
        if (c.strategyEnvelope) continue; // new-system creeps take travel from their Demand option
        const b = bindings[c.name];
        const home = b && b.homeRoom ? b.homeRoom : c.roomName;
        if (home !== roomName) continue;
        const role = c.legacyRole || (b && b.legacyRole) || null;
        const fn = functionOf ? functionOf(role) : 'other';
        const body = c.body.map(function (p) { return p.type; });
        const travel = travelFor(distanceOf(fn), body);
        if (travel !== null) out[roomName + '/legacy/' + (role || 'unknown') + '/' + c.name] = travel;
    }
    const fns = Object.keys(EMERGENCY_BODIES);
    for (let i = 0; i < fns.length; i++) {
        const travel = travelFor(distanceOf(fns[i]), EMERGENCY_BODIES[fns[i]]);
        if (travel !== null) out['emergency:' + fns[i]] = travel;
    }
    return out;
}

module.exports = { FATIGUE_MARGIN, EMERGENCY_BODIES, ticksPerTile, estimateTravel };
