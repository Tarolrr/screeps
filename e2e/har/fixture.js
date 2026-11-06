'use strict';
// HAR fixture support (schema version 1).
//
// A fixture spec describes the DESIRED world state using target coordinates.
// The packaged world cannot be reshaped, so resolveFixture() maps every target
// to an equivalent real cell in the chosen room and records the verified
// geometry (BFS distances, terrain legality) in the resolved fixture. If the
// room cannot supply a legal equivalent, resolution fails — the caller must
// treat that as BLOCKED/infrastructure, never as a strategy defect.
//
// validateFixture() then performs the engine-side checks against the live DB
// (through the admin CLI) AFTER arrangement but BEFORE any gated step:
//   RCL + controller ownership, terrain/overlap legality, walkable route
//   spawn<->source, capacity/store sanity, valid body with live parts,
//   spawn possible + sufficient creep TTL, empty user Memory, no competitors.
//
// impossibleFixture() is a deliberately unsatisfiable variant used to prove
// the refusal path (must produce BLOCKED, never a run).
const crypto = require('crypto');

const FIXTURE_SCHEMA_VERSION = 1;
const VALID_PARTS = new Set(['move', 'work', 'carry', 'attack', 'ranged_attack', 'heal', 'claim', 'tough']);
const PART_COST = { move: 50, work: 100, carry: 50, attack: 80, ranged_attack: 150, heal: 250, claim: 600, tough: 10 };
const CARRY_CAPACITY_PER_PART = 50;

class FixtureError extends Error {
    constructor(message, problems) {
        super(message);
        this.name = 'FixtureError';
        this.problems = problems || [message];
    }
}

function terrainAt(terrain, x, y) {
    return terrain.charAt(y * 50 + x);
}
function walkable(terrain, x, y) {
    if (x < 0 || x > 49 || y < 0 || y > 49) return false;
    const c = terrainAt(terrain, x, y);
    return c !== '1' && c !== '3'; // '1' wall, '3' wall|swamp; '0' plain, '2' swamp
}
function chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// BFS over walkable, non-blocked cells. Returns Map "x,y" -> steps from `from`,
// or null when `from` itself is not standable.
function bfsMap(terrain, blocked, from) {
    if (!walkable(terrain, from.x, from.y) || blocked.has(from.x + ',' + from.y)) return null;
    const dist = new Map([[from.x + ',' + from.y, 0]]);
    const queue = [from];
    while (queue.length) {
        const cur = queue.shift();
        const d = dist.get(cur.x + ',' + cur.y);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const x = cur.x + dx, y = cur.y + dy, k = x + ',' + y;
            if (dist.has(k) || blocked.has(k) || !walkable(terrain, x, y)) continue;
            dist.set(k, d + 1);
            queue.push({ x, y });
        }
    }
    return dist;
}

function freeAdjacent(terrain, blocked, obj) {
    const out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const x = obj.x + dx, y = obj.y + dy;
        if (walkable(terrain, x, y) && !blocked.has(x + ',' + y)) out.push({ x, y });
    }
    return out;
}

// Fixture F0: RCL2 owned open room, one spawn, two sources, one harvester
// creep a few cells off source S1, empty Memory, no competitors.
function fixtureF0() {
    return {
        schemaVersion: FIXTURE_SCHEMA_VERSION,
        id: 'F0',
        // Candidate rooms in preference order; the resolver takes the first
        // one whose topology AND placement constraints all check out. (The
        // packaged seed keeps only unowned source/mineral/controller rows, so
        // NPC-claimed rooms like W9N9 lose their controller here.)
        preferredRooms: ['W9N8', 'W9N6', 'W9N5', 'W9N2', 'W8N9', 'W8N8', 'W8N7',
            'W8N4', 'W8N3', 'W8N2', 'W8N1', 'W7N9', 'W7N7', 'W7N4', 'W7N3'],
        rcl: 2,
        spawnEnergy: 300,
        memoryMustBeEmpty: true,
        // Target coordinates from the scenario spec. These are intents, not
        // guaranteed cells; resolveFixture() records the real equivalents.
        targets: {
            controller: { x: 25, y: 25 },
            spawn: { x: 10, y: 10 },
            source1: { x: 15, y: 10 },
            source2: { x: 15, y: 20 },
            creep: { x: 14, y: 10 },
        },
        // Hard requirements; a cell listed in `required` must be used verbatim.
        required: {},
        // expectCreep=false produces the no-creep control variant.
        expectCreep: true,
        creep: {
            name: 'har1',
            body: ['move', 'carry', 'work'], // spec order [MOVE,CARRY,WORK]
            store: {},
            minTtl: 200,
            // Place the creep this many BFS steps from S1's adjacent standable
            // set so the production moveTo branch is exercised, not skipped.
            pathDistanceFromSource: 3,
        },
    };
}

// Deliberately unsatisfiable variant: the creep is REQUIRED at (0,0), which is
// border wall in every generated room, and the RCL is required to be 9. Any
// compliant runner must refuse with BLOCKED before stepping.
function impossibleFixture() {
    const spec = fixtureF0();
    spec.id = 'F0-IMPOSSIBLE';
    spec.rcl = 9;
    spec.required = { creep: { x: 0, y: 0 }, spawn: { x: 1, y: 0 } };
    spec.creep.pathDistanceFromSource = 0;
    return spec;
}

// Resolve the spec against the live world. Fetches rooms.objects/terrain once.
// Returns {spec, room, actual:{controller,spawn,source1,source2,creep},
//          distances, terrainSha256, objectsBaseline, sourceEnergy...}.
async function resolveFixture(evalFn, spec) {
    const problems = [];
    if (spec.schemaVersion !== FIXTURE_SCHEMA_VERSION) throw new FixtureError(`unsupported fixture schema ${spec.schemaVersion}`);
    for (const part of spec.creep.body) {
        if (!VALID_PARTS.has(part)) problems.push(`invalid body part ${part}`);
    }
    if (problems.length) throw new FixtureError(`spec invalid: ${problems.join('; ')}`, problems);

    const failures = [];
    for (const candidate of spec.preferredRooms || []) {
        try {
            return await resolveInRoom(evalFn, spec, candidate);
        } catch (error) {
            if (error instanceof FixtureError) { failures.push(`${candidate}: ${error.problems.join('; ')}`); continue; }
            throw error;
        }
    }
    throw new FixtureError(`no preferred room satisfies F0 topology+placement`, failures.length ? failures : ['no candidates']);
}

// Server-side projection for room-object reads: actionLog fields alone are
// ~600 B per creep and 10+ object rooms blow the ~10 KB CLI pipe (eval
// timeouts observed on eco-02-d-fulltarget arrange).
const OBJ_SLIM = ".then(function(os){return os.map(function(o){return {_id:o._id,type:o.type,x:o.x,y:o.y,user:o.user,reservation:o.reservation,name:o.name,level:o.level,store:o.store,storeCapacity:o.storeCapacity,storeCapacityResource:o.storeCapacityResource,spawning:o.spawning,energy:o.energy,energyCapacity:o.energyCapacity,body:o.body,hits:o.hits,hitsMax:o.hitsMax,ageTime:o.ageTime,fatigue:o.fatigue}})})";

// Resolve the spec inside one room. Throws FixtureError on any impossibility.
async function resolveInRoom(evalFn, spec, room) {
    const problems = [];
    const roomObjects = await evalFn(`storage.db['rooms.objects'].find({room:${JSON.stringify(room)}})${OBJ_SLIM}`, 15000);
    const terrainRow = await evalFn(`storage.db['rooms.terrain'].findOne({room:${JSON.stringify(room)}})`, 15000);
    if (!terrainRow || !terrainRow.terrain || terrainRow.terrain.length !== 2500) {
        throw new FixtureError('terrain row missing/malformed', [`${room}: bad terrain`]);
    }
    const controllers = roomObjects.filter(o => o.type === 'controller');
    const sourceRows = roomObjects.filter(o => o.type === 'source');
    if (controllers.length !== 1) throw new FixtureError('controller count', [`${room}: ${controllers.length} controllers`]);
    if (sourceRows.length < 2) throw new FixtureError('source count', [`${room}: ${sourceRows.length} sources`]);
    if (roomObjects.some(o => o.user || o.reservation)) throw new FixtureError('owned/reserved objects present', [`${room}: competitors`]);

    const terrain = terrainRow.terrain;
    const controller = controllers[0];
    const sources = sourceRows;
    // Objects occupying cells for placement/pathing purposes. Sources and the
    // controller sit on generated tiles (often walls); they block placement
    // and routing alike.
    const blocked = new Set(roomObjects.map(o => o.x + ',' + o.y));

    const wantCreep = spec.expectCreep !== false;

    // Required cells must be usable verbatim (impossible-fixture hook).
    for (const [slot, pos] of Object.entries(spec.required || {})) {
        if (slot === 'creep' && !wantCreep) continue;
        if (!walkable(terrain, pos.x, pos.y)) problems.push(`required ${slot} cell ${pos.x},${pos.y} is wall/border`);
        if (blocked.has(pos.x + ',' + pos.y)) problems.push(`required ${slot} cell ${pos.x},${pos.y} overlaps object`);
    }
    if (problems.length) throw new FixtureError(`required cells unusable: ${problems.join('; ')}`, problems);

    // S1 = the source with the most standable adjacent cells (best harvest
    // geometry); S2 = the first remaining source (recorded, unused by HAR-01).
    const ranked = sources.map(s => ({ s, adj: freeAdjacent(terrain, blocked, s) }))
        .sort((a, b) => b.adj.length - a.adj.length);
    const s1 = ranked[0], s2 = ranked[1];
    if (!s1.adj.length) throw new FixtureError(`source ${s1.s._id} has no standable adjacent cell`, ['source unreachable']);

    // Reachability universe: BFS from S1's best adjacent cell.
    const distFromS1 = bfsMap(terrain, blocked, s1.adj[0]);
    if (!distFromS1) throw new FixtureError('cannot route next to source');

    // Creep cell: BFS distance spec.creep.pathDistanceFromSource from the set
    // of S1-adjacent standable cells; prefer the candidate closest to the
    // spec's target coordinate so the target->actual mapping stays faithful.
    const adjSet = new Set(s1.adj.map(p => p.x + ',' + p.y));
    // Multi-source BFS from every standable S1-adjacent cell: exact distance
    // from each free cell to the harvest standing set.
    const distMulti = new Map(s1.adj.map(p => [p.x + ',' + p.y, 0]));
    const q = s1.adj.slice();
    while (q.length) {
        const cur = q.shift();
        const d = distMulti.get(cur.x + ',' + cur.y);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const x = cur.x + dx, y = cur.y + dy, k = x + ',' + y;
            if (distMulti.has(k) || blocked.has(k) || !walkable(terrain, x, y)) continue;
            distMulti.set(k, d + 1);
            q.push({ x, y });
        }
    }
    spec._distMulti = distMulti;

    let creepCell = wantCreep && spec.required && spec.required.creep;
    let creepToSource = null;
    if (wantCreep && !creepCell) {
        const want = spec.creep.pathDistanceFromSource;
        const cands = [...distMulti.entries()]
            .filter(([k, d]) => d === want && !adjSet.has(k))
            .map(([k, d]) => { const [x, y] = k.split(',').map(Number); return { x, y, d }; })
            .sort((a, b) => chebyshev(a, spec.targets.creep) - chebyshev(b, spec.targets.creep));
        if (!cands.length) {
            const fallback = [...distMulti.entries()].filter(([k, d]) => d >= 2 && d <= 6 && !adjSet.has(k))
                .map(([k, d]) => { const [x, y] = k.split(',').map(Number); return { x, y, d }; })
                .sort((a, b) => a.d - b.d || chebyshev(a, spec.targets.creep) - chebyshev(b, spec.targets.creep));
            if (!fallback.length) throw new FixtureError(`no free cell at distance ${want} from S1`, ['creep placement impossible']);
            creepCell = { x: fallback[0].x, y: fallback[0].y };
            creepToSource = fallback[0].d;
        } else {
            creepCell = { x: cands[0].x, y: cands[0].y };
            creepToSource = cands[0].d;
        }
    }

    // Spawn cell: free cell nearest the target, must route to S1-adj set.
    let spawnCell = spec.required && spec.required.spawn;
    if (!spawnCell) {
        let best = null;
        for (let y = 2; y <= 47; y++) for (let x = 2; x <= 47; x++) {
            const k = x + ',' + y;
            if (!walkable(terrain, x, y) || blocked.has(k) || !spec._distMulti.has(k)) continue;
            if (creepCell && x === creepCell.x && y === creepCell.y) continue;
            const score = chebyshev({ x, y }, spec.targets.spawn);
            if (!best || score < best.score) best = { x, y, score };
        }
        if (!best) throw new FixtureError('no routable free cell for spawn', ['spawn placement impossible']);
        spawnCell = { x: best.x, y: best.y };
    }
    const spawnToSource = spec._distMulti ? spec._distMulti.get(spawnCell.x + ',' + spawnCell.y) : null;
    if (!Number.isFinite(spawnToSource)) throw new FixtureError(`spawn cell ${spawnCell.x},${spawnCell.y} cannot route to S1`, ['spawn-source route missing']);

    return {
        schemaVersion: FIXTURE_SCHEMA_VERSION,
        spec,
        room,
        terrainSha256: crypto.createHash('sha256').update(terrain).digest('hex'),
        actual: {
            controller: { id: controller._id, x: controller.x, y: controller.y },
            spawn: { x: spawnCell.x, y: spawnCell.y },
            source1: { id: s1.s._id, x: s1.s.x, y: s1.s.y, energy: s1.s.energy, energyCapacity: s1.s.energyCapacity },
            source2: { id: s2.s._id, x: s2.s.x, y: s2.s.y, energy: s2.s.energy, energyCapacity: s2.s.energyCapacity },
            creep: creepCell ? { x: creepCell.x, y: creepCell.y } : null,
        },
        distances: {
            creepToSourceAdj: creepToSource,
            spawnToSourceAdj: spawnToSource,
            spawnToController: chebyshev(spawnCell, controller),
            chebyshevCreepToSource: creepCell ? chebyshev(creepCell, s1.s) : null,
            source1AdjCells: s1.adj.length,
        },
        objectsBaseline: roomObjects.map(o => o._id),
        targetDelta: {
            controller: { target: spec.targets.controller, actual: { x: controller.x, y: controller.y } },
            spawn: { target: spec.targets.spawn, actual: spawnCell },
            source1: { target: spec.targets.source1, actual: { x: s1.s.x, y: s1.s.y } },
            source2: { target: spec.targets.source2, actual: { x: s2.s.x, y: s2.s.y } },
            creep: { target: spec.targets.creep, actual: creepCell },
        },
    };
}

// Engine-side validity check, run against the live DB after arrangement and
// before any gated step. Returns {ok, problems, checks}.
async function validateFixture(evalFn, fx, userId) {
    const spec = fx.spec, problems = [], checks = [];
    const ok = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) problems.push(`${name}: ${detail}`); };

    const objects = await evalFn(`storage.db['rooms.objects'].find({room:${JSON.stringify(fx.room)}})${OBJ_SLIM}`, 15000);
    const gameTime = Number(await evalFn(`storage.env.get('gameTime')`, 10000));
    const memRaw = await evalFn(`storage.env.get(${JSON.stringify('memory:' + userId)})`, 10000);
    const activeRooms = await evalFn(`storage.env.smembers('activeRooms')`, 10000);
    const terrainRow = await evalFn(`storage.db['rooms.terrain'].findOne({room:${JSON.stringify(fx.room)}})`, 15000);
    const terrain = terrainRow && terrainRow.terrain;

    const ctrl = objects.find(o => o.type === 'controller');
    ok('controller.ownership', ctrl && ctrl.user === userId, ctrl && `user=${ctrl.user}`);
    ok('controller.rcl', ctrl && ctrl.level === spec.rcl, ctrl && `level=${ctrl.level}`);

    const spawn = objects.find(o => o.type === 'spawn' && o.user === userId);
    ok('spawn.present', !!spawn, spawn && spawn._id);
    ok('spawn.position', spawn && spawn.x === fx.actual.spawn.x && spawn.y === fx.actual.spawn.y, spawn && `${spawn.x},${spawn.y}`);
    ok('spawn.store', spawn && spawn.store && spawn.store.energy === spec.spawnEnergy &&
        spawn.storeCapacityResource && spawn.storeCapacityResource.energy === spec.spawnEnergy,
        spawn && JSON.stringify(spawn.store));
    ok('spawn.idle', spawn && !spawn.spawning, spawn && JSON.stringify(spawn.spawning));

    const s1 = objects.find(o => o._id === fx.actual.source1.id);
    ok('source1.present', !!s1, fx.actual.source1.id);
    ok('source1.capacity', s1 && s1.energy === fx.actual.source1.energy && s1.energyCapacity === fx.actual.source1.energyCapacity,
        s1 && `${s1.energy}/${s1.energyCapacity}`);

    const wantCreep = spec.expectCreep !== false;
    const creep = objects.find(o => o.type === 'creep' && o.user === userId && o.name === spec.creep.name);
    ok('creep.presence', wantCreep ? !!creep : !objects.some(o => o.type === 'creep'),
        wantCreep ? spec.creep.name : `${objects.filter(o => o.type === 'creep').length} creeps`);
    if (creep && wantCreep) {
        ok('creep.position', creep.x === fx.actual.creep.x && creep.y === fx.actual.creep.y, `${creep.x},${creep.y}`);
        ok('creep.body', Array.isArray(creep.body) && creep.body.length === spec.creep.body.length &&
            creep.body.every((p, i) => p.type === spec.creep.body[i] && VALID_PARTS.has(p.type)),
            JSON.stringify(creep.body && creep.body.map(p => p.type)));
        ok('creep.partsAlive', creep.body.every(p => p.hits > 0) && creep.hits === creep.body.length * 100,
            `hits=${creep.hits}`);
        ok('creep.storeCapacity', creep.storeCapacity === spec.creep.body.filter(p => p === 'carry').length * CARRY_CAPACITY_PER_PART,
            `storeCapacity=${creep.storeCapacity}`);
        ok('creep.emptyStore', !creep.store || !creep.store.energy, JSON.stringify(creep.store));
        const ttl = creep.ageTime - gameTime;
        ok('creep.ttl', Number.isFinite(ttl) && ttl >= spec.creep.minTtl, `ttl=${ttl} (gameTime=${gameTime})`);
        ok('creep.notSpawning', creep.spawning === false, `spawning=${creep.spawning}`);
        ok('creep.fatigue', !creep.fatigue, `fatigue=${creep.fatigue}`);
    }

    // Terrain legality and overlap at placed cells.
    ok('terrain.spawnWalkable', terrain && walkable(terrain, fx.actual.spawn.x, fx.actual.spawn.y), 'spawn cell');
    if (wantCreep && fx.actual.creep) {
        ok('terrain.creepWalkable', terrain && walkable(terrain, fx.actual.creep.x, fx.actual.creep.y), 'creep cell');
    }
    const distinctCells = [fx.actual.spawn.x + ',' + fx.actual.spawn.y,
        fx.actual.source1.x + ',' + fx.actual.source1.y,
        fx.actual.controller.x + ',' + fx.actual.controller.y];
    if (fx.actual.creep) distinctCells.push(fx.actual.creep.x + ',' + fx.actual.creep.y);
    ok('overlap.distinct', new Set(distinctCells).size === distinctCells.length, 'cells distinct');

    // Route spawn<->S1 recomputed on the live terrain (BFS, post-placement).
    // The spawn's own cell is excluded from the blocked set — it is the start.
    // Creeps are transient obstacles and excluded as well.
    const blockedNow = new Set(objects.filter(o => o.type !== 'creep' && o.type !== 'energy').map(o => o.x + ',' + o.y));
    blockedNow.delete(fx.actual.spawn.x + ',' + fx.actual.spawn.y);
    const distMap = terrain && bfsMap(terrain, blockedNow, fx.actual.spawn);
    const route = distMap && s1 && freeAdjacent(terrain, blockedNow, s1)
        .map(p => distMap.get(p.x + ',' + p.y)).filter(Number.isFinite);
    ok('route.spawnToSource', route && route.some(Number.isFinite), route && `dist=${Math.min(...route.filter(Number.isFinite))}`);

    // Spawn could produce this body: energy covers cost and TTL affords a run.
    const bodyCost = spec.creep.body.reduce((s, p) => s + (PART_COST[p] || 0), 0);
    ok('spawn.affordable', spawn && spawn.store.energy >= bodyCost, `cost=${bodyCost}`);

    // Memory and competition.
    ok('memory.empty', !spec.memoryMustBeEmpty || memRaw === '{}', JSON.stringify(memRaw && memRaw.slice(0, 80)));
    ok('room.active', Array.isArray(activeRooms) && activeRooms.includes(fx.room), JSON.stringify(activeRooms));
    const foreign = objects.filter(o => (o.user && o.user !== userId) || o.reservation);
    ok('competitors.none', foreign.length === 0, `${foreign.length} foreign objects`);

    return { ok: problems.length === 0, problems, checks };
}

module.exports = {
    FIXTURE_SCHEMA_VERSION, FixtureError,
    fixtureF0, impossibleFixture, resolveFixture, validateFixture,
    bfsMap, walkable, chebyshev, VALID_PARTS, PART_COST,
};
