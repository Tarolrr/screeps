'use strict';
// STRAT fixture S1 = HAR F0 (e2e/har/fixture.js, unchanged) + extra actors so
// that the legacy dist2 executor actually produces harvest / transfer /
// withdraw / build / upgrade effects inside a ~100-tick window:
//
//   har1  [move,carry,work]       F0 creep, Memory {role:'harvester', sourceId:S1}
//   mul1  [carry,move]  50 energy Memory = verbatim copy of the dist2
//                                 RoomController `mule_spawn_<S1>` order memory
//                                 (what spawnCreep(order.memory) installs)
//   upg1  [work,carry,move] empty Memory {role:'upgrader'}; next to a container
//   ctr1  container 1000 energy   within range 2 of the controller (withdraw)
//   bld1  [work,carry,move] 50 en Memory {role:'builder'}
//   site1 road constructionSite   owned by the user, adjacent to bld1 (build)
//
// Extras are placed deterministically (sorted candidate cells) away from S1's
// standable cells so the F0 validator's spawn->S1 route still holds. Memory is
// written AFTER validateFixture (which requires empty Memory), before step 1 —
// identical bytes for every run of a comparison, so artifact and baseline runs
// start from the same state.
const PART_HITS = 100;

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

async function freeCells(h, room, center, range) {
    return h.eval(`storage.db['rooms.terrain'].findOne({room:${JSON.stringify(room)}}).then(function(t){
        var s=t.terrain,out=[];
        for(var dx=-${range};dx<=${range};dx++)for(var dy=-${range};dy<=${range};dy++){
            var x=${center.x}+dx,y=${center.y}+dy;
            if(x<2||x>47||y<2||y>47)continue;
            var c=s.charAt(y*50+x);if(c==='1'||c==='3')continue;
            out.push({x:x,y:y,d:Math.max(Math.abs(dx),Math.abs(dy))});
        }
        return storage.db['rooms.objects'].find({room:${JSON.stringify(room)}}).then(function(objs){
            var busy={};objs.forEach(function(o){busy[o.x+','+o.y]=1;});
            var free=out.filter(function(p){return !busy[p.x+','+p.y];});
            free.sort(function(a,b){return a.d-b.d||a.x-b.x||a.y-b.y;});
            return free;
        });
    })`, 15000);
}

function muleSpawnMemory(fx) {
    // Verbatim shape of dist2/RoomController.js applyResources() mule_spawn order memory.
    return {
        role: 'mule',
        collectTemplates: [{ type: 'area', entityType: 'ground', pos: { x: fx.actual.source1.x, y: fx.actual.source1.y }, range: 3 }],
        deliverTemplates: [{ type: 'area', entityType: 'structure', structureTypes: 'spawn extension', range: 50, pos: { x: fx.actual.spawn.x, y: fx.actual.spawn.y } }],
    };
}

async function insertCreep(h, userId, room, cell, name, parts, energy) {
    const capacity = parts.filter(p => p === 'carry').length * 50;
    const row = {
        type: 'creep', room, x: cell.x, y: cell.y, name, user: userId,
        body: parts.map(p => ({ type: p, hits: PART_HITS })),
        store: energy ? { energy } : {}, storeCapacity: capacity,
        hits: parts.length * PART_HITS, hitsMax: parts.length * PART_HITS,
        fatigue: 0, spawning: false, notifyWhenAttacked: true,
        actionLog: { attacked: null, healed: null, attack: null, rangedAttack: null, rangedMassAttack: null, rangedHeal: null,
            harvest: null, heal: null, repair: null, build: null, say: null, upgradeController: null, reserveController: null },
    };
    return h.eval(`storage.env.get('gameTime').then(function(gt){
        var c = ${JSON.stringify(row)}; c.ageTime = gt + 1500;
        return storage.db['rooms.objects'].insert(c);
    })`, 15000);
}

// Arrange S1 on an already-resolved F0 fixture. Returns ctx for the runner.
async function arrangeS1(h, fx, journal, { username, modules }) {
    const translated = {};
    for (const k of Object.keys(modules)) translated[k] = modules[k];
    const userId = await h.createUser({ username, modules: translated, roomName: fx.room, spawn: true, spawnPos: fx.actual.spawn });
    journal.add('user', userId, 'create', { username, modules: Object.keys(modules), spawnPos: fx.actual.spawn });
    await h.dbUpdate('rooms.objects', { $and: [{ room: fx.room }, { type: 'controller' }] }, { level: fx.spec.rcl });
    journal.add('controller', fx.actual.controller.id, 'update', { level: fx.spec.rcl });
    const ctx = { userId, room: fx.room, actors: {} };

    const har = await insertCreep(h, userId, fx.room, fx.actual.creep, 'har1', ['move', 'carry', 'work'], 0);
    ctx.creepId = har && har._id; ctx.creepName = 'har1';
    ctx.actors.har1 = { id: har && har._id, x: fx.actual.creep.x, y: fx.actual.creep.y };
    journal.add('creep', ctx.creepId, 'create', { name: 'har1', cell: fx.actual.creep });

    // Cells reserved so the validator's spawn->S1 route and S1 harvest cells stay free.
    const s1 = fx.actual.source1;
    const reserved = (c) => cheb(c, s1) <= 2 || cheb(c, fx.actual.creep) <= 1 || cheb(c, fx.actual.spawn) < 2;
    const taken = [];
    const pick = (cells, extraOk) => {
        const c = cells.find(p => !reserved(p) && !taken.some(t => t.x === p.x && t.y === p.y) && (!extraOk || extraOk(p)));
        if (!c) throw new Error('arrange: no legal cell for S1 extra');
        taken.push(c);
        return c;
    };

    // Container near the controller (range 2) + upgrader adjacent to it and within 3 of the controller.
    const ctrlCells = await freeCells(h, fx.room, fx.actual.controller, 3);
    const ctrCell = pick(ctrlCells, p => cheb(p, fx.actual.controller) === 2);
    const ctr = await h.dbInsert('rooms.objects', { type: 'container', room: fx.room, x: ctrCell.x, y: ctrCell.y,
        store: { energy: 1000 }, storeCapacity: 2000, hits: 250000, hitsMax: 250000, nextDecayTime: 1000000, notifyWhenAttacked: false });
    ctx.actors.ctr1 = { id: ctr && ctr._id, x: ctrCell.x, y: ctrCell.y };
    journal.add('extra', ctx.actors.ctr1.id, 'create', { kind: 'container', cell: ctrCell, energy: 1000 });
    const upgCell = pick(ctrlCells, p => cheb(p, ctrCell) === 1 && cheb(p, fx.actual.controller) <= 3);
    const upg = await insertCreep(h, userId, fx.room, upgCell, 'upg1', ['work', 'carry', 'move'], 0);
    ctx.actors.upg1 = { id: upg && upg._id, x: upgCell.x, y: upgCell.y };
    journal.add('extra', ctx.actors.upg1.id, 'create', { kind: 'creep', name: 'upg1', cell: upgCell });

    // Mule and builder near the spawn (range 2..4).
    const spawnCells = await freeCells(h, fx.room, fx.actual.spawn, 4);
    const mulCell = pick(spawnCells, p => cheb(p, fx.actual.spawn) >= 2);
    const mul = await insertCreep(h, userId, fx.room, mulCell, 'mul1', ['carry', 'move'], 50);
    ctx.actors.mul1 = { id: mul && mul._id, x: mulCell.x, y: mulCell.y };
    journal.add('extra', ctx.actors.mul1.id, 'create', { kind: 'creep', name: 'mul1', cell: mulCell, energy: 50 });
    const bldCell = pick(spawnCells, p => cheb(p, fx.actual.spawn) >= 3);
    const bld = await insertCreep(h, userId, fx.room, bldCell, 'bld1', ['work', 'carry', 'move'], 50);
    ctx.actors.bld1 = { id: bld && bld._id, x: bldCell.x, y: bldCell.y };
    journal.add('extra', ctx.actors.bld1.id, 'create', { kind: 'creep', name: 'bld1', cell: bldCell, energy: 50 });
    const siteCell = pick(spawnCells, p => cheb(p, bldCell) === 1);
    const site = await h.dbInsert('rooms.objects', { type: 'constructionSite', room: fx.room, x: siteCell.x, y: siteCell.y,
        structureType: 'road', user: userId, progress: 0, progressTotal: 300 });
    ctx.actors.site1 = { id: site && site._id, x: siteCell.x, y: siteCell.y };
    journal.add('extra', ctx.actors.site1.id, 'create', { kind: 'constructionSite', structureType: 'road', cell: siteCell });

    ctx.initialMemory = {
        creeps: {
            har1: { role: 'harvester', sourceId: s1.id },
            mul1: muleSpawnMemory(fx),
            upg1: { role: 'upgrader' },
            bld1: { role: 'builder' },
        },
    };
    return ctx;
}

// Memory seed written after validation, before step 1.
async function seedMemory(h, ctx, extraSeed, journal) {
    const mem = Object.assign({}, ctx.initialMemory, extraSeed || {});
    const raw = JSON.stringify(mem);
    await h.eval(`storage.env.set(${JSON.stringify('memory:' + ctx.userId)}, ${JSON.stringify(raw)})`, 15000);
    const back = await h.eval(`storage.env.get(${JSON.stringify('memory:' + ctx.userId)})`, 15000);
    const ok = back === raw;
    journal.add('env', 'memory:' + ctx.userId, 'seed', { bytes: raw.length, keys: Object.keys(mem) }, ok);
    if (!ok) throw new Error('memory seed read-back mismatch');
    return mem;
}

module.exports = { arrangeS1, seedMemory, muleSpawnMemory };
