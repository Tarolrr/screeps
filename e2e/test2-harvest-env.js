// Test 2 (environment-prepared): hypothesis — "a creep inserted directly into
// rooms.objects next to a source can harvest it and deliver energy to a spawn".
//
// setup() prepares the world state via direct DB writes (no game-client steps):
//   - claims controller + inserts a spawn for a fresh test user (createUser)
//   - inserts a WORK/CARRY/MOVE creep object adjacent to a source
// test() polls rooms.objects server-side until the creep carries energy.
//
// Criteria:
//   - the inserted creep exists and its store.energy > 0 (harvest worked)
//   - within ~150 ticks the drained spawn's store reaches >= 50 energy.
//     Spawns self-regenerate only 1 energy/tick, so reaching 50 quickly
//     can only mean the creep delivered its full 50-energy load.
const { Harness, sleep } = require('./harness');

const ROOM = 'W5N8';

const USER_CODE = `
module.exports.loop = function() {
    for (var name in Game.creeps) {
        var c = Game.creeps[name];
        if (c.store.getFreeCapacity() > 0) {
            var src = c.pos.findClosestByPath(FIND_SOURCES);
            if (c.harvest(src) === ERR_NOT_IN_RANGE) c.moveTo(src);
        } else {
            var sp = c.pos.findClosestByPath(FIND_MY_SPAWNS);
            if (c.transfer(sp, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) c.moveTo(sp);
        }
    }
    Memory.test = { creeps: Object.keys(Game.creeps).map(function(n){
        var c = Game.creeps[n]; return { n: n, e: c.store.energy };
    }) };
};
`;

async function main() {
    const h = new Harness();
    await h.connect();

    const r = await h.runCase('harvest-env', {
        async setup(ctx) {
            ctx.userId = await h.createUser({
                username: 'TestHarvest',
                modules: { main: USER_CODE },
                roomName: ROOM,
                spawn: true,
            });
            console.log('  test user id:', ctx.userId);

            // Direct creep insertion adjacent to a source: same record shape a
            // live creep has in rooms.objects (meta/$loki are added by the DB).
            ctx.sourceId = await h.eval(`(function(){
                var db = storage.db, uid = ${JSON.stringify(ctx.userId)};
                return db['rooms.objects'].findOne({$and: [{room: ${JSON.stringify(ROOM)}},{type: 'source'}]})
                .then(function(src){
                    return db['rooms.terrain'].findOne({room: ${JSON.stringify(ROOM)}}).then(function(t){
                        var pos = null;
                        outer:
                        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
                            if (!dx && !dy) continue;
                            var x = src.x + dx, y = src.y + dy, c = t.terrain.charAt(y * 50 + x);
                            if (c !== '1' && c !== '3') { pos = {x: x, y: y}; break outer; }
                        }
                        if (!pos) throw 'no free tile next to source';
                        return storage.env.get('gameTime').then(function(gt){
                            return db['rooms.objects'].insert({
                                type: 'creep', room: ${JSON.stringify(ROOM)}, x: pos.x, y: pos.y,
                                name: 't1', user: uid,
                                body: [{type: 'work', hits: 100}, {type: 'carry', hits: 100},
                                       {type: 'move', hits: 100}, {type: 'move', hits: 100}],
                                store: {}, storeCapacity: 50,
                                hits: 400, hitsMax: 400, fatigue: 0, spawning: false,
                                ageTime: gt + 1500, notifyWhenAttacked: true,
                                actionLog: {attacked: null, healed: null, attack: null, rangedAttack: null,
                                    rangedMassAttack: null, rangedHeal: null, harvest: null, heal: null,
                                    repair: null, build: null, say: null, upgradeController: null,
                                    reserveController: null}
                            }).then(function(){ return src._id; });
                        });
                    });
                });
            })()`);
            ctx.spawnStart = await h.dbFindOne('rooms.objects', { room: ROOM, type: 'spawn', user: ctx.userId });
            // A fresh spawn is full (300/300) — drain it so the creep has
            // somewhere to deliver, and assert it gets refilled.
            await h.dbUpdate('rooms.objects', { _id: ctx.spawnStart._id }, { store: { energy: 0 } });
            console.log('  creep inserted next to source', ctx.sourceId, '| spawn drained');
        },

        async test(ctx) {
            const creep = await h.waitUntil(async () => {
                const c = await h.dbFindOne('rooms.objects',
                    { $and: [{ room: ROOM }, { type: 'creep' }, { user: ctx.userId }] });
                return c && c.store && c.store.energy > 0 ? c : null;
            }, { pollMs: 1500, timeoutMs: 120000, label: 'creep.store.energy>0' });
            ctx.metrics.creepEnergy = creep.store.energy;
            ctx.metrics.harvestedAt = await h.gameTime();

            const spawn = await h.waitUntil(async () => {
                const s = await h.dbFindOne('rooms.objects', { room: ROOM, type: 'spawn', user: ctx.userId });
                return s && s.store.energy >= 50 ? s : null;
            }, { pollMs: 2000, timeoutMs: 150000, label: 'spawn.store >= 50' });
            ctx.metrics.spawnEnergy = spawn.store.energy;
            // creep should be empty again after delivery
            const c = await h.dbFindOne('rooms.objects', { room: ROOM, type: 'creep', user: ctx.userId });
            ctx.metrics.creepEnergyAfterDelivery = c && c.store.energy;
        },

        async teardown(ctx) {
            if (ctx.userId) await h.destroyUser(ctx.userId, ROOM);
        },
        timeoutMs: 240000,
    });

    h.close();
    process.exit(r.ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
