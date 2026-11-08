// ReplacementForecast (A4): when, what and at which cost every executor of a
// room has to be replaced within the horizon (DESIGN §5, §7; ARCHITECTURE §5).
// Pure: Snapshot/demands/bindings in, Result<ReplacementPlan> out.
//
//   deadline  = death tick of the current executor (snapshot ticksToLive; a
//               spawning creep lives remainingTime + lifetime);
//   startBy   = deadline − travel − spawnTime − 25 (DESIGN §7 margin);
//   spawnTime = 3 × body length, bodyCost from part costs;
//   travel    = demand option travelTime or a supplied upper estimate, otherwise
//               UNKNOWN (never 0); unknown TTL/travel => entry quality UNKNOWN,
//               startBy null, reason MISSING_FIELD;
//   one chain per slot: an executor that already has a (spawning or alive)
//   successor of a higher generation gets no entry, so a replacement is never
//   ordered twice; generation (successor index) is distinct from occurrence
//   (always 0 for spawn, see replacementOperationKey);
//   legacy Memory expiryTime is never read: only Snapshot.ticksToLive counts.

'use strict';

const E = require('../domain/enums');
const { measured, unknownMeasure, validateSnapshot, validateReplacementPlan } = require('../domain/dtos');
const { parseOperationKey, isOperationKey, buildOperationKey } = require('../domain/keys');
const { READY, UNKNOWN, REJECTED } = require('../domain/results');
const { fingerprint } = require('../domain/fingerprint');

/** Vanilla server constants (override through options.constants when the server differs). */
const DEFAULT_CONSTANTS = Object.freeze({
    BODYPART_COST: Object.freeze({ move: 50, work: 100, attack: 80, carry: 50, heal: 250, ranged_attack: 150, tough: 10, claim: 600 }),
    CREEP_LIFE_TIME: 1500,
    CREEP_CLAIM_LIFE_TIME: 600,
    CREEP_SPAWN_TIME: 3,
});

/** DESIGN §7/§12: start margin of a replacement. */
const REPLACEMENT_MARGIN = 25;

/** Legacy role -> function (initial setting; unknown roles are 'other'). */
const ROLE_FUNCTION = Object.freeze({
    harvester: 'harvest', miner: 'harvest',
    mule: 'feed', hauler: 'feed', feeder: 'feed', filler: 'feed', carrier: 'feed',
    upgrader: 'upgrade', builder: 'build', repairer: 'build',
});

/** Function -> criticality (initial setting, DESIGN §4/§7). */
const FUNCTION_CRITICALITY = Object.freeze({ harvest: 'CRITICAL', feed: 'CRITICAL', upgrade: 'REQUIRED', build: 'OPTIONAL', other: 'REQUIRED' });

const Q_RANK = { OBSERVED: 0, DERIVED: 1, ESTIMATED: 2, STALE: 3, UNKNOWN: 4 };
function worse(a, b) { return Q_RANK[a] >= Q_RANK[b] ? a : b; }

/**
 * @param {string[]} body part types
 * @param {object} [constants]
 * @returns {number|null} cost, or null when a part type is unknown
 */
function bodyCost(body, constants) {
    const costs = (constants || DEFAULT_CONSTANTS).BODYPART_COST;
    let total = 0;
    for (let i = 0; i < body.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(costs, body[i])) return null;
        total += costs[body[i]];
    }
    return total;
}

/** @returns {number} spawn time 3 × body length */
function spawnTimeOf(body, constants) {
    return (constants || DEFAULT_CONSTANTS).CREEP_SPAWN_TIME * body.length;
}

/** @returns {number} lifetime of a body (claim bodies live 600) */
function lifetimeOf(body, constants) {
    const c = constants || DEFAULT_CONSTANTS;
    return body.indexOf('claim') !== -1 ? c.CREEP_CLAIM_LIFE_TIME : c.CREEP_LIFE_TIME;
}

/**
 * @param {string|null} capabilityOrRole demand capability or legacy role
 * @returns {string} 'harvest' | 'feed' | 'upgrade' | 'build' | 'other'
 */
function functionOf(capabilityOrRole) {
    if (!capabilityOrRole) return 'other';
    if (Object.prototype.hasOwnProperty.call(ROLE_FUNCTION, capabilityOrRole)) return ROLE_FUNCTION[capabilityOrRole];
    const text = String(capabilityOrRole).toLowerCase();
    if (text.indexOf('harvest') !== -1 || text.indexOf('mine') !== -1) return 'harvest';
    if (text.indexOf('feed') !== -1 || text.indexOf('haul') !== -1 || text.indexOf('fill') !== -1) return 'feed';
    if (text.indexOf('upgrade') !== -1) return 'upgrade';
    if (text.indexOf('build') !== -1 || text.indexOf('repair') !== -1) return 'build';
    return 'other';
}

/**
 * Operation key of the spawn of replacement `generation` of a demand.
 * Occurrence is always '0' for spawn (ARCHITECTURE §5) — the generation, not the
 * occurrence, distinguishes successive replacements.
 */
function replacementOperationKey(roomName, ownerEpoch, demandStableKey, generation) {
    return buildOperationKey({ domain: roomName, ownerEpoch: ownerEpoch, demandStableKey: demandStableKey, generation: generation, action: 'spawn', occurrence: '0' });
}

function demandIndex(demands) {
    const out = {};
    const list = Array.isArray(demands) ? demands : demands && typeof demands === 'object' ? Object.keys(demands).map(function (k) { return demands[k]; }) : [];
    for (let i = 0; i < list.length; i++) out[list[i].stableKey] = list[i];
    return out;
}

function lookupTravel(travelEstimates, keys) {
    if (!travelEstimates) return null;
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== null && Object.prototype.hasOwnProperty.call(travelEstimates, keys[i])) return travelEstimates[keys[i]];
    }
    return null;
}

/** Death tick of a creep as a Measured (absolute tick). */
function deathOf(creep, spawnsByCreep, tick, constants) {
    if (creep.ticksToLive.value !== null) return measured(tick + creep.ticksToLive.value, creep.ticksToLive.quality);
    if (creep.spawning && spawnsByCreep[creep.name]) {
        const types = creep.body.map(function (p) { return p.type; });
        return measured(tick + spawnsByCreep[creep.name].remainingTime + lifetimeOf(types, constants), E.Quality.DERIVED);
    }
    return unknownMeasure(creep.ticksToLive.reason || 'MISSING_FIELD');
}

/**
 * Full analysis: the ReplacementPlan plus per-entry metadata used by the
 * forecast calendar (slot, function, generation, payment tick).
 *
 * @param {{snapshot:object, roomName?:string, demands?:object[]|Object<string,object>,
 *          observedBindings?:Object<string,object>, horizon:number,
 *          travelEstimates?:Object<string,object>, constants?:object, ownerEpoch?:number}} input
 *        travelEstimates: Measured upper travel per slotKey / demand stableKey / legacy role / function
 * @returns {object} READY({plan, meta}) | UNKNOWN | REJECTED(INVALID_RECORD)
 */
function analyzeReplacements(input) {
    const snapshot = input.snapshot;
    const sv = validateSnapshot(snapshot);
    if (!sv.ok) return REJECTED('INVALID_RECORD', { what: 'snapshot', errors: sv.errors });
    const names = Object.keys(snapshot.rooms);
    const roomName = input.roomName || (names.length === 1 ? names[0] : null);
    if (!roomName || !snapshot.rooms[roomName]) return UNKNOWN('MISSING_FIELD', ['roomName']);
    const horizon = input.horizon;
    if (!(Number.isInteger(horizon) && horizon >= 1)) return REJECTED('INVALID_RECORD', { what: 'horizon' });
    const constants = input.constants || DEFAULT_CONSTANTS;
    const tick = snapshot.tick;
    const end = tick + horizon;
    const demands = demandIndex(input.demands);
    const bindings = input.observedBindings || {};
    const room = snapshot.rooms[roomName];

    const spawnsByCreep = {};
    for (let i = 0; i < room.spawns.length; i++) {
        const sp = room.spawns[i].spawning;
        if (sp) spawnsByCreep[sp.name] = sp;
    }

    // Group executors into slots.
    const slots = {};
    const legacyGroups = {};
    const creepNames = Object.keys(snapshot.ownCreeps).sort();
    for (let i = 0; i < creepNames.length; i++) {
        const creep = snapshot.ownCreeps[creepNames[i]];
        const binding = bindings[creep.name] || null;
        const env = creep.strategyEnvelope && isOperationKey(creep.strategyEnvelope.operationKey) ? creep.strategyEnvelope : null;
        const home = env ? env.homeRoom : binding && binding.homeRoom ? binding.homeRoom : creep.roomName;
        if (home !== roomName) continue;
        const types = creep.body.map(function (p) { return p.type; });
        const role = creep.legacyRole || (binding && binding.legacyRole) || null;
        const death = deathOf(creep, spawnsByCreep, tick, constants);
        if (env) {
            const parts = parseOperationKey(env.operationKey);
            const slotKey = parts.demandStableKey;
            const prev = slots[slotKey];
            if (!prev || prev.generation < parts.generation) {
                slots[slotKey] = { slotKey: slotKey, creep: creep, types: types, role: role, generation: parts.generation, death: death, demand: demands[slotKey] || null, legacy: false, ownerEpoch: env.ownerEpoch };
            }
        } else {
            const groupKey = role || 'unknown';
            if (!legacyGroups[groupKey]) legacyGroups[groupKey] = [];
            legacyGroups[groupKey].push({ creep: creep, types: types, role: role, death: death });
        }
    }
    // Legacy: k spawning creeps of a role cover the k soonest-dying non-spawning creeps of that role.
    const groupKeys = Object.keys(legacyGroups).sort();
    for (let g = 0; g < groupKeys.length; g++) {
        const group = legacyGroups[groupKeys[g]];
        let spawning = 0;
        const alive = [];
        for (let i = 0; i < group.length; i++) {
            if (group[i].creep.spawning) spawning++;
            else alive.push(group[i]);
        }
        alive.sort(function (a, b) {
            const da = a.death.value === null ? Infinity : a.death.value;
            const db = b.death.value === null ? Infinity : b.death.value;
            if (da !== db) return da < db ? -1 : 1;
            return a.creep.name < b.creep.name ? -1 : 1;
        });
        const covered = {};
        for (let i = 0; i < alive.length && i < spawning; i++) covered[alive[i].creep.name] = true;
        for (let i = 0; i < group.length; i++) {
            const it = group[i];
            if (covered[it.creep.name]) continue;
            const slotKey = roomName + '/legacy/' + groupKeys[g] + '/' + it.creep.name;
            slots[slotKey] = { slotKey: slotKey, creep: it.creep, types: it.types, role: it.role, generation: 0, death: it.death, demand: null, legacy: true, ownerEpoch: null };
        }
    }

    const entries = [];
    const meta = {};
    const slotKeys = Object.keys(slots).sort();
    for (let s = 0; s < slotKeys.length; s++) {
        const slot = slots[slotKeys[s]];
        const option = slot.demand && slot.demand.options.length > 0 ? slot.demand.options[0] : null;
        const body = option ? option.body.slice() : slot.types;
        const costRaw = option ? option.cost : bodyCost(body, constants);
        const spawnTime = option ? option.spawnTime : spawnTimeOf(body, constants);
        const fn = functionOf(slot.demand ? slot.demand.capability : slot.role);
        const criticality = slot.demand ? slot.demand.criticality : FUNCTION_CRITICALITY[fn];
        let travel = option ? option.travelTime : lookupTravel(input.travelEstimates, [slot.slotKey, slot.role, fn]);
        if (!travel) travel = unknownMeasure('MISSING_FIELD');
        const lifetime = lifetimeOf(body, constants);

        let deadline = slot.death;
        let generation = slot.generation + 1;
        let currentName = slot.creep.name;
        for (let guard = 0; guard < 64; guard++) {
            const unknownCost = costRaw === null;
            const known = deadline.value !== null && travel.value !== null && !unknownCost;
            const startBy = known ? deadline.value - travel.value - spawnTime - REPLACEMENT_MARGIN : null;
            let quality = worse(E.Quality.ESTIMATED, worse(deadline.quality, travel.quality));
            if (unknownCost) quality = E.Quality.UNKNOWN;
            let reason = null;
            if (!known) reason = 'MISSING_FIELD';
            else if (startBy < tick) reason = 'CRITICAL_DEADLINE';
            if (!known) quality = E.Quality.UNKNOWN;
            const anchor = startBy !== null ? startBy : deadline.value;
            if (anchor !== null && anchor > end) break;
            const stableKey = slot.slotKey + '#g' + generation;
            const ttl = deadline.value === null ? deadline : measured(Math.max(0, deadline.value - tick), guard === 0 ? deadline.quality : E.Quality.ESTIMATED);
            entries.push({
                stableKey: stableKey, roomName: roomName, currentCreepName: guard === 0 ? currentName : null,
                ticksToLive: ttl, body: body, bodyCost: unknownCost ? 0 : costRaw, spawnTime: spawnTime, travelTime: travel,
                startBy: startBy === null ? null : Math.max(0, startBy), deadline: deadline.value, criticality: criticality,
                reasonCode: reason, quality: quality,
            });
            meta[stableKey] = {
                slotKey: slot.slotKey, fn: fn, generation: generation, legacy: slot.legacy, lifetime: lifetime,
                cost: unknownCost ? null : costRaw, paymentTick: startBy === null ? null : Math.max(tick, startBy),
                deadline: deadline.value, operationKey: slot.legacy ? null : replacementOperationKey(roomName, input.ownerEpoch === undefined ? slot.ownerEpoch : input.ownerEpoch, slot.slotKey, generation),
            };
            if (!known) break; // no extrapolation from unknowns
            const born = Math.max(tick, startBy) + spawnTime;
            deadline = measured(born + lifetime, E.Quality.ESTIMATED);
            generation++;
            currentName = null;
        }
    }
    entries.sort(function (a, b) { return a.stableKey < b.stableKey ? -1 : a.stableKey > b.stableKey ? 1 : 0; });
    const plan = { roomName: roomName, tick: tick, horizon: horizon, entries: entries };
    const pv = validateReplacementPlan(plan);
    if (!pv.ok) return REJECTED('INVALID_RECORD', { what: 'plan', errors: pv.errors });
    return READY({ plan: plan, meta: meta }, fingerprint({ s: snapshot.fingerprint, d: input.demands || null, b: bindings, h: horizon, t: input.travelEstimates || null, r: roomName }));
}

/**
 * Contract A.2 §10 signature.
 * @param {{snapshot:object, demands?:object, observedBindings?:object, horizon:number, roomName?:string, travelEstimates?:object, constants?:object}} input
 * @returns {object} READY(ReplacementPlan) | UNKNOWN | REJECTED
 */
function forecastReplacements(input) {
    const r = analyzeReplacements(input);
    if (r.kind !== 'READY') return r;
    return READY(r.value.plan, r.inputFingerprint);
}

module.exports = {
    DEFAULT_CONSTANTS,
    REPLACEMENT_MARGIN,
    ROLE_FUNCTION,
    FUNCTION_CRITICALITY,
    bodyCost,
    spawnTimeOf,
    lifetimeOf,
    functionOf,
    replacementOperationKey,
    analyzeReplacements,
    forecastReplacements,
};
