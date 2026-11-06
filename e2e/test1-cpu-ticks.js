// Test 1 (minimal): hypothesis — "uploaded user code executes every tick and
// Game.cpu.getUsed() reports its real CPU cost".
//
// We create a user in a free room (a user with zero room objects is deactivated
// by the runner — driver/lib/runtime/data.js sets active=0), upload a main.js
// that burns CPU in a controlled loop and reports metrics to Memory. The harness
// polls the memory key server-side and validates the criteria.
//
// Criteria:
//   - Memory.test.ticks reaches >= 10 within 90 ticks (code runs every tick)
//   - every reported cpuUsed sample is in (0, 95) — below the 100 CPU limit
//   - cpuAvailable of the user decreases (CPU is actually consumed)
const { Harness } = require('./harness');

const USER_CODE = `
module.exports.loop = function() {
    var t0 = Game.cpu.getUsed();
    var s = 0;
    for (var i = 0; i < 100000; i++) s += Math.sqrt(i);
    var used = Game.cpu.getUsed() - t0;
    Memory.test = Memory.test || { ticks: 0, samples: [] };
    Memory.test.ticks++;
    if (Memory.test.samples.length < 50) Memory.test.samples.push(Math.round(used * 100) / 100);
    Memory.test.checksum = Math.round(s);
};
`;

async function main() {
    const h = new Harness();
    await h.connect();

    const r = await h.runCase('cpu-ticks', {
        async setup(ctx) {
            ctx.userId = await h.createUser({
                username: 'TestCPU',
                modules: { main: USER_CODE },
                roomName: 'W5N8',
                spawn: true,
            });
            ctx.cpuBefore = await h.userCpuAvailable(ctx.userId);
            console.log('  test user id:', ctx.userId);
        },

        async test(ctx) {
            const mem = await h.waitUntil(async () => {
                const m = await h.getMemory(ctx.userId);
                return m && m.test && m.test.ticks >= 10 ? m : null;
            }, { pollMs: 2000, label: 'Memory.test.ticks>=10' });

            const samples = mem.test.samples;
            const min = Math.min(...samples), max = Math.max(...samples);
            const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
            Object.assign(ctx.metrics, { samples: samples.length, cpuMin: min, cpuMax: max, cpuAvg: +avg.toFixed(2) });

            if (!(min > 0)) throw new Error(`cpuUsed min ${min} <= 0`);
            if (!(max < 95)) throw new Error(`cpuUsed max ${max} >= 95 (limit 100)`);
            const cpuAfter = await h.userCpuAvailable(ctx.userId);
            ctx.metrics.cpuAvailableDelta = cpuAfter - ctx.cpuBefore;
        },

        async teardown(ctx) {
            if (ctx.userId) await h.destroyUser(ctx.userId);
        },
        timeoutMs: 120000,
    });

    h.close();
    process.exit(r.ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
