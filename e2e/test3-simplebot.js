// Test 3 (repo code): runs the actual @screeps/simplebot AI shipped in
// node_modules as a test user's modules — the same files bots.spawn('simplebot')
// would load — and verifies the bot really plays: spawns role creeps and makes
// controller progress.
//
// Criteria:
//   - >= 3 creeps owned by the user appear within 150 ticks (spawn pipeline works)
//   - controller.progress > 0 within 300 ticks (harvest->upgrade loop works)
// Runs at tickDuration=200ms to keep wall time reasonable; restored afterwards.
const fs = require('fs');
const path = require('path');
const { Harness } = require('./harness');

const ROOM = 'W5N8';
const BOT_DIR = path.join(process.env.SCREEPS_SERVER_HOME || path.join(require('os').homedir(), 'screeps'), 'node_modules/@screeps/simplebot/src');

function loadBotModules(dir) {
    const modules = {};
    for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^(.*)\.js$/);
        if (m) modules[m[1]] = fs.readFileSync(path.join(dir, f), 'utf8');
    }
    return modules;
}

async function main() {
    const h = new Harness();
    await h.connect();
    let prevTick = null;

    const r = await h.runCase('simplebot-repo-ai', {
        async setup(ctx) {
            await h.assertSafeRoom(ROOM);
            prevTick = await h.getTickDuration();
            await h.setTickDuration(200);
            ctx.userId = await h.createUser({
                username: 'TestBotRepo',
                modules: loadBotModules(BOT_DIR),
                roomName: ROOM,
                spawn: true,
            });
            console.log('  test user id:', ctx.userId, '| modules:', Object.keys(loadBotModules(BOT_DIR)).join(', '));
        },

        async test(ctx) {
            const creeps = await h.waitUntil(async () => {
                const c = await h.dbFind('rooms.objects', { room: ROOM, type: 'creep', user: ctx.userId });
                return c.length >= 3 ? c : null;
            }, { pollMs: 1500, timeoutMs: 200000, label: '>=3 creeps' });
            ctx.metrics.creepCount = creeps.length;
            ctx.metrics.creepNames = creeps.map(c => c.name).join(',');

            const ctrl = await h.waitUntil(async () => {
                const c = await h.dbFindOne('rooms.objects', { room: ROOM, type: 'controller' });
                return c && c.progress > 0 ? c : null;
            }, { pollMs: 2000, timeoutMs: 300000, label: 'controller.progress>0' });
            ctx.metrics.controllerProgress = ctrl.progress;
            ctx.metrics.controllerLevel = ctrl.level;
        },

        async teardown(ctx) {
            // restore the tick rate first — the world shouldn't stay at 200ms
            let tickError;
            try { if (prevTick !== null) await h.setTickDuration(prevTick); } catch (e) { tickError = e; }
            if (ctx.userId) await h.destroyUser(ctx.userId, ROOM);
            if (tickError) throw tickError;
        },
        timeoutMs: 320000,
    });

    h.close();
    process.exit(r.ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
