// Shared runner for e2e tests of the user's real strategy code
// from github.com/Tarolrr/screeps (dist/ = last working, dist2/ = WIP rearch).
// Modules are uploaded to a test user in W5N8; the user's own
// require('./role.harvester')-style names work because the engine's
// requireFn strips the leading './' (engine/src/game/game.js).
const fs = require('fs');
const path = require('path');
const { Harness } = require('./harness');

const STRATEGY_REPO = path.resolve(__dirname, '..');
const ROOM = 'W5N8';

function loadModules(dir) {
    const modules = {};
    for (const file of fs.readdirSync(path.join(STRATEGY_REPO, dir))) {
        if (!file.endsWith('.js')) continue;
        const name = file.replace(/\.js$/, '');
        if (name === 'mock-game') continue; // local jest mock, not a game module
        modules[name] = fs.readFileSync(path.join(STRATEGY_REPO, dir, file), 'utf8');
    }
    return modules;
}

// criteria shared by both versions: the strategy boots with no script errors
// and actually produces creeps on a live spawn.
async function runStrategyCase(dir, { creepTimeoutMs = 200000, timeoutMs = 300000 } = {}) {
    const h = new Harness();
    await h.connect();
    let prevTick = null;
    const modules = loadModules(dir);

    const r = await h.runCase(`user-strategy-${dir}`, {
        async setup(ctx) {
            await h.assertSafeRoom(ROOM);
            prevTick = await h.getTickDuration();
            await h.setTickDuration(200);
            ctx.userId = await h.createUser({
                username: `TarE2E_${dir}`,
                modules,
                roomName: ROOM,
                spawn: true,
            });
            console.log(`  ${Object.keys(modules).length} modules from ${dir}/, user ${ctx.userId}`);
        },

        async test(ctx) {
            const creeps = await h.waitUntil(async () => {
                const c = await h.dbFind('rooms.objects', { room: ROOM, type: 'creep', user: ctx.userId });
                return c.length > 0 ? c : null;
            }, { pollMs: 1500, timeoutMs: creepTimeoutMs, label: '>=1 creep spawned' });
            // creep memory lives in Memory.creeps[name], not on the rooms.objects
            // row; project it in-sandbox — the raw memory blob is too big to print
            const roles = await h.eval(`storage.env.get('memory:' + ${JSON.stringify(ctx.userId)}).then(function(raw){
                var m = JSON.parse(raw || '{}');
                return ${JSON.stringify(creeps.map(c => c.name))}.map(function(n){
                    return n + ':' + (m.creeps && m.creeps[n] && m.creeps[n].role);
                });
            })`, 120000);
            ctx.metrics.creeps = roles.join(',');

            // give the loop a few more ticks, then check for script errors
            await h.waitTicks(5);
            const errs = await h.eval(
                `storage.db['users.notifications'].find({user_id:${JSON.stringify(ctx.userId)},type:'error'})`);
            ctx.metrics.scriptErrors = (errs || []).length;
            if (ctx.metrics.scriptErrors) throw new Error(`user script raised ${ctx.metrics.scriptErrors} error(s)`);
        },

        async teardown(ctx) {
            let tickError;
            try { if (prevTick !== null) await h.setTickDuration(prevTick); } catch (e) { tickError = e; }
            if (ctx.userId) {
                const errs = await h.eval(
                    `storage.db['users.notifications'].find({user_id:${JSON.stringify(ctx.userId)},type:'error'})`
                ).catch(() => []);
                (errs || []).slice(0, 3).forEach(e => console.log('  script error:', String(e.message || '').slice(0, 300)));
                await h.destroyUser(ctx.userId, ROOM);
            }
            if (tickError) throw tickError;
        },
        timeoutMs,
    });

    h.close();
    return r;
}

module.exports = { runStrategyCase, loadModules };
