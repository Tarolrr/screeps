// Test 4 (combat): hypothesis — "an ATTACK creep inserted next to a hostile
// creep destroys it".
//
// setup(): test user + spawn in a free room; two directly-inserted creeps:
//   ours [ATTACK,ATTACK,MOVE,MOVE] and a passive dummy [CARRY,MOVE] owned by a
//   second test user (inert — no objects until we insert it, then active=0).
// Criteria: the hostile creep loses hits below hitsMax within 30 ticks and is
// fully removed from rooms.objects within 60 ticks.
const { Harness } = require('./harness');

const ROOM = 'W5N8';

const ATK_CODE = `
module.exports.loop = function() {
    var c = Game.creeps.a1;
    if (!c) return;
    var hostile = c.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (!hostile) { Memory.test = { done: true }; return; }
    if (c.attack(hostile) === ERR_NOT_IN_RANGE) c.moveTo(hostile);
};
`;

async function main() {
    const h = new Harness();
    await h.connect();

    const r = await h.runCase('combat-attack', {
        async setup(ctx) {
            ctx.userId = await h.createUser({
                username: 'TestAtk',
                modules: { main: ATK_CODE },
                roomName: ROOM,
                spawn: true,
            });
            ctx.enemyId = await h.createUser({
                username: 'TestDummy',
                modules: { main: 'module.exports.loop=function(){}' },
            });
            console.log('  atk user:', ctx.userId, '| dummy user:', ctx.enemyId);

            const src = await h.dbFindOne('rooms.objects', { room: ROOM, type: 'source' });
            const p1 = await h.findFreePos(ROOM, src.x, src.y + 4, 6);
            const p2 = await h.findFreePos(ROOM, p1.x + 1, p1.y, 2);
            if (!p1 || !p2) throw new Error('no free tiles for creeps');

            await h.insertCreep({ userId: ctx.userId, room: ROOM, x: p1.x, y: p1.y, name: 'a1', parts: ['attack', 'attack', 'move', 'move'] });
            const dummy = await h.insertCreep({ userId: ctx.enemyId, room: ROOM, x: p2.x, y: p2.y, name: 'd1', parts: ['carry', 'move'] });
            ctx.dummyId = dummy._id;
            console.log('  attacker at', p1.x, p1.y, '| dummy at', p2.x, p2.y);
        },

        async test(ctx) {
            const damaged = await h.waitUntil(async () => {
                const d = await h.dbFindOne('rooms.objects', { _id: ctx.dummyId });
                return !d || d.hits < d.hitsMax ? (d || { hits: 0 }) : null;
            }, { pollMs: 1000, timeoutMs: 60000, label: 'dummy takes damage' });
            ctx.metrics.dummyHitsAfterFirstDamage = damaged.hits;

            const gone = await h.waitUntil(async () => {
                const d = await h.dbFindOne('rooms.objects', { _id: ctx.dummyId });
                return !d ? true : null;
            }, { pollMs: 1000, timeoutMs: 90000, label: 'dummy destroyed' });
            ctx.metrics.dummyDestroyed = true;
        },

        async teardown(ctx) {
            if (ctx.userId) await h.destroyUser(ctx.userId, ROOM);
            if (ctx.enemyId) await h.destroyUser(ctx.enemyId);
        },
        timeoutMs: 150000,
    });

    h.close();
    process.exit(r.ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
