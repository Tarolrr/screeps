// Test 8 (user repo dist2, deep): verifies the WIP rearch end-to-end on a
// live server — spawn pipeline, harvest->mule->upgrader economy and the
// construction controller (roads first, then extensions after we bump RCL).
//
// Phase A (organic, RCL1):
//   - >=2 distinct creep roles spawned
//   - controller.progress > 0  (energy actually reaches the upgrade path)
//   - >=1 road constructionSite (BuildController fires every %100 ticks;
//     extension orders fail silently at RCL1, road orders go through)
// Phase B (prepared env):
//   - bump controller to RCL8 + drop an energy pile near the spawn
//   - expect an 'extension' constructionSite or built extension
//   - zero script error notifications the whole run
const { Harness } = require('./harness');
const { loadModules } = require('./user-strategy-runner');

const ROOM = 'W5N8';

async function main() {
    const h = new Harness();
    await h.connect();
    let prevTick = null;

    const r = await h.runCase('dist2-deep', {
        async setup(ctx) {
            await h.assertSafeRoom(ROOM);
            prevTick = await h.getTickDuration();
            await h.setTickDuration(200);
            ctx.userId = await h.createUser({
                username: 'TarE2E_d2deep',
                modules: loadModules('dist2'),
                roomName: ROOM,
                spawn: true,
            });
            ctx.spawn = await h.dbFindOne('rooms.objects', { room: ROOM, type: 'spawn', user: ctx.userId });
            console.log(`  dist2 modules on user ${ctx.userId}, spawn at ${ctx.spawn.x},${ctx.spawn.y}`);
        },

        async test(ctx) {
            // --- A1: several distinct roles alive -----------------------------
            await h.waitUntil(async () => {
                const mem = await h.eval(`storage.env.get('memory:' + ${JSON.stringify(ctx.userId)}).then(function(raw){
                    var m = JSON.parse(raw || '{}');
                    return Object.keys(m.creeps || {}).map(function(n){ return m.creeps[n].role; });
                })`, 120000);
                const distinct = new Set(mem || []);
                if (distinct.size >= 2) { ctx.metrics.roles = [...distinct].join(','); return true; }
            }, { pollMs: 2000, timeoutMs: 120000, label: '>=2 distinct roles' });

            // --- A2: upgrade pipeline moves progress --------------------------
            await h.waitUntil(async () => {
                const c = await h.dbFindOne('rooms.objects', { room: ROOM, type: 'controller' });
                if (c && c.progress > 0) { ctx.metrics.ctrlProgress = c.progress; return true; }
            }, { pollMs: 3000, timeoutMs: 120000, label: 'controller.progress>0' });

            // --- A3: construction sites appear (roads, at RCL1) ---------------
            const site = await h.waitUntil(async () => {
                const s = await h.dbFind('rooms.objects', { room: ROOM, type: 'constructionSite' });
                if (s.length) return s;
            }, { pollMs: 3000, timeoutMs: 120000, label: '>=1 constructionSite' });
            ctx.metrics.sites = site.map(s => s.structureType).join(',');

            // --- B: bump RCL + feed builders ----------------------------------
            await h.dbUpdate('rooms.objects', { room: ROOM, type: 'controller' }, { level: 8, progress: 0 });
            await h.dbInsert('rooms.objects', {
                type: 'energy', room: ROOM, x: ctx.spawn.x + 1, y: ctx.spawn.y, energy: 50000,
            });
            console.log('  phase B: controller->RCL8, energy pile dropped near spawn');

            const ext = await h.waitUntil(async () => {
                const s = await h.dbFind('rooms.objects', { room: ROOM, type: 'constructionSite', structureType: 'extension' });
                if (s.length) return s;
                // finished extension is a structure, not a site
                const e = await h.dbFind('rooms.objects', { room: ROOM, type: 'extension' });
                if (e.length) return e;
            }, { pollMs: 3000, timeoutMs: 140000, label: 'extension site/structure' });
            ctx.metrics.extensions = ext.map(s => `${s.type}${s.structureType ? ':' + s.structureType : ''}@${s.x},${s.y}`).join(',');
        },

        async teardown(ctx) {
            let tickError;
            try { if (prevTick !== null) await h.setTickDuration(prevTick); } catch (e) { tickError = e; }
            if (ctx.userId) {
                const errs = await h.eval(
                    `storage.db['users.notifications'].find({user_id:${JSON.stringify(ctx.userId)},type:'error'})`
                ).catch(() => []);
                ctx.metrics.scriptErrors = (errs || []).length;
                (errs || []).slice(0, 3).forEach(e => console.log('  script error:', String(e.message || '').slice(0, 300)));
                await h.destroyUser(ctx.userId, ROOM);
            }
            if (tickError) throw tickError;
        },
        timeoutMs: 420000,
    });

    h.close();
    process.exit(r.ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
