// Test 5 (construction, code-driven): hypothesis — "user code can place a
// construction site and a WORK creep can build it into a real structure".
//
// setup(): test user + spawn; one builder creep [WORK,CARRY,MOVE,MOVE] with a
//   full 50-energy load inserted on a free tile.
// code: once, place a road site on an adjacent tile; then creep.build() until
//   it's a real structure.
// Criteria: a constructionSite appears, then a finished road structure exists
//   at that position within 90 ticks. Build spends energy 1:1 with progress
//   (BUILD_POWER=5 progress AND 5 energy per WORK/tick), so a 300-progress
//   road needs a 300-energy load: [WORKx3, CARRYx6, MOVEx4], 300 energy.
const { Harness } = require('./harness');

const ROOM = 'W5N8';

const CODE = `
module.exports.loop = function() {
    var c = Game.creeps.b1;
    if (!c) return;
    var site = c.pos.findClosestByRange(FIND_MY_CONSTRUCTION_SITES);
    if (!site) {
        if (!Memory.sitePos) {
            var tx = c.pos.x + 1, ty = c.pos.y;
            var res = c.room.createConstructionSite(tx, ty, STRUCTURE_ROAD);
            Memory.sitePos = { x: tx, y: ty, res: res };
        }
        return;
    }
    var r = c.build(site);
    if (r === ERR_NOT_IN_RANGE) c.moveTo(site);
    Memory.test = { siteProgress: site.progress, buildRes: r, carry: c.store.energy };
};
`;

async function main() {
    const h = new Harness();
    await h.connect();

    const r = await h.runCase('build-road', {
        async setup(ctx) {
            ctx.userId = await h.createUser({
                username: 'TestBuild',
                modules: { main: CODE },
                roomName: ROOM,
                spawn: true,
            });
            const src = await h.dbFindOne('rooms.objects', { room: ROOM, type: 'source' });
            const p = await h.findFreePos(ROOM, src.x + 2, src.y + 2, 8);
            if (!p) throw new Error('no free tile for builder');
            const creep = await h.insertCreep({
                userId: ctx.userId, room: ROOM, x: p.x, y: p.y, name: 'b1',
                parts: ['work', 'work', 'work', 'carry', 'carry', 'carry',
                        'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'],
                store: { energy: 300 }, capacity: 300,
            });
            ctx.creepId = creep._id;
            console.log('  builder at', p.x, p.y, 'with 300 energy');
        },

        async test(ctx) {
            const site = await h.waitUntil(async () => {
                const s = await h.dbFindOne('rooms.objects', { room: ROOM, type: 'constructionSite', user: ctx.userId });
                return s || null;
            }, { pollMs: 1000, timeoutMs: 30000, label: 'constructionSite created' });
            ctx.metrics.sitePos = `${site.x},${site.y}`;
            ctx.metrics.siteProgressTotal = site.progressTotal;

            const road = await h.waitUntil(async () => {
                const objs = await h.dbFind('rooms.objects',
                    { $and: [{ room: ROOM }, { type: 'road' }, { x: site.x }, { y: site.y }] });
                return objs.length ? objs[0] : null;
            }, { pollMs: 1000, timeoutMs: 120000, label: 'road structure built' });
            ctx.metrics.roadHits = road.hits;
        },

        async teardown(ctx) {
            if (ctx.userId) await h.destroyUser(ctx.userId, ROOM);
        },
        timeoutMs: 160000,
    });

    h.close();
    process.exit(r.ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
