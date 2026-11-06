'use strict';

// Long-lived, client-visible disposable Screeps instance. Unlike scenario
// runners this process deliberately stays alive until `stop`/SIGINT, while
// retaining the isolated-server ownership handle needed for safe teardown.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { createIsolatedServer } = require('../server/instance');
const { StepClient } = require('../server/step-client');
const { Harness } = require('../harness');
const { fixtureF0, resolveFixture, validateFixture } = require('../har/fixture');

const REPO = path.resolve(__dirname, '..', '..');
const RUNS = path.join(__dirname, '.runs');
const STEP_MOD = path.join(__dirname, '..', 'server', 'step-mod.js');
const STEP_PRELOAD = path.join(__dirname, '..', 'server', 'step-preload.js');
const VIEW_PRELOAD = path.join(__dirname, 'preload.js');
const HARVESTER_FILE = path.join(REPO, 'dist', 'role.harvester.js');
const OFFLINE_STEAM_ID = '76561197960287930';

function option(argv, name, dflt) {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? dflt : argv[i + 1];
}

function parseOptions(argv = process.argv.slice(2), env = process.env) {
    if (argv.includes('--help')) return { help: true };
    const out = {
        httpPort: Number(option(argv, 'http-port', 32500)),
        cliPort: Number(option(argv, 'cli-port', 32501)),
        host: option(argv, 'host', '127.0.0.1'),
        auth: option(argv, 'auth', 'none'),
        fixture: option(argv, 'fixture', 'eco-01-d'),
        room: option(argv, 'room', null),
        tickMode: option(argv, 'tick-mode', 'slow'),
        tickMs: Number(option(argv, 'tick-ms', 2000)),
        steamConfig: option(argv, 'steam-config', path.join(os.homedir(), 'screeps', '.screepsrc')),
        passwordEnv: option(argv, 'server-password-env', null),
    };
    if (!Number.isInteger(out.httpPort) || !Number.isInteger(out.cliPort)) throw Error('ports must be integers');
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(out.host) || out.host.split('.').some(x => Number(x) > 255)) throw Error('host must be an explicit IPv4 address');
    if (!['none', 'steam'].includes(out.auth)) throw Error('auth must be none or steam');
    if (!['har-01', 'eco-01-d'].includes(out.fixture)) throw Error('fixture must be har-01 or eco-01-d');
    if (!['slow', 'step'].includes(out.tickMode)) throw Error('tick-mode must be slow or step');
    if (!Number.isInteger(out.tickMs) || out.tickMs < 100 || out.tickMs > 600000) throw Error('tick-ms must be an integer from 100 to 600000');
    if (out.room && !/^[WE]\d+[NS]\d+$/.test(out.room)) throw Error('room must look like W9N8');
    if (out.passwordEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(out.passwordEnv)) throw Error('invalid server-password-env name');
    out.serverPassword = out.passwordEnv ? env[out.passwordEnv] : null;
    if (out.host === '0.0.0.0' && !out.serverPassword) throw Error('0.0.0.0 requires --server-password-env pointing to a non-empty environment variable');
    const octets = out.host.split('.').map(Number);
    const tailscale = octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
    if (out.auth === 'none' && out.host !== '127.0.0.1' && !tailscale) throw Error('auth none is allowed only on loopback or an explicit Tailscale 100.64.0.0/10 address');
    return out;
}

function readIniValue(file, key) {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;
        const m = line.match(/^([^=]+?)\s*=\s*(.*)$/);
        if (m && m[1].trim() === key) {
            const value = m[2].trim();
            if (!value || /[\0\r\n]/.test(value)) throw Error(`${key} is empty or invalid in ${file}`);
            return value;
        }
    }
    throw Error(`${key} is missing in ${file}`);
}

function profile(name, sourceId) {
    const eco = name === 'eco-01-d';
    const body = eco ? ['work', 'carry', 'move'] : ['move', 'carry', 'work'];
    const initialMemory = eco
        ? `{role:'harvester',efficiency:1,assignedSource:${JSON.stringify(sourceId)}}`
        : `{assignedSource:${JSON.stringify(sourceId)}}`;
    const main = `var role = require('role.harvester');
module.exports.loop = function () {
    for (var name in Game.creeps) {
        var creep = Game.creeps[name];
        if (!creep.memory.assignedSource) Object.assign(creep.memory, ${initialMemory});
        role.run(creep);
    }
    Memory.view = {profile:${JSON.stringify(name)}, tick:Game.time};
};`;
    return { body, main };
}

async function httpProbe(host, port, serverPassword, auth) {
    const headers = serverPassword ? { 'X-Server-Password': serverPassword } : {};
    const base = `http://${host}:${port}`;
    const response = await fetch(`${base}/api/version`, { headers });
    if (!response.ok) throw Error(`HTTP version probe failed: ${response.status}`);
    const data = await response.json();
    if (data.useNativeAuth !== false) throw Error(`unexpected auth mode: useNativeAuth=${data.useNativeAuth}`);
    const result = { protocol: data.protocol, packageVersion: data.packageVersion || null };
    if (auth === 'none') {
        const login = await fetch(`${base}/api/auth/steam-ticket`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
            body: JSON.stringify({ ticket: 'e2e-view-offline' }),
        });
        const payload = await login.json();
        if (!login.ok || !payload || typeof payload.token !== 'string' || !payload.token) throw Error(`offline login probe failed: ${login.status}`);
        result.offlineLogin = true;
    }
    return result;
}

async function prepareOfflineSpectator(h) {
    const id = OFFLINE_STEAM_ID;
    const user = await h.eval(`storage.db.users.findOne({'steam.id':${JSON.stringify(id)}})`, 10000);
    if (!user || !user._id) throw Error('offline spectator account was not created by login probe');
    await h.eval(`Promise.all([
        storage.db.users.update({_id:${JSON.stringify(user._id)}}, {$set:{username:'view_spectator',usernameLower:'view_spectator',active:0}}),
        storage.env.set(${JSON.stringify('memory:' + user._id)}, '{}')
    ])`, 10000);
    return user._id;
}

function help() {
    return `Usage: node e2e/view/view.js [options]

  --fixture eco-01-d|har-01   reusable F0 scenario profile (default eco-01-d)
  --room W9N8                 require this packaged-seed room
  --http-port 32500           fixed client port
  --cli-port 32501            fixed loopback-only admin port
  --host IPv4                  loopback, Tailscale IP, or guarded 0.0.0.0
  --auth none|steam            offline spectator or real Steam auth (default none)
  --steam-config PATH         source .screepsrc containing steam_api_key
  --server-password-env NAME  required for 0.0.0.0; secret is read from env
  --tick-mode slow|step       continuous slow ticks or manual fenced steps
  --tick-ms 2000              slow-mode tick duration

Interactive commands: status, pause, resume, speed MS, step [N], help, stop`;
}

async function run(opts) {
    const runId = `view-${Date.now()}-${process.pid}`;
    const runDir = path.join(RUNS, runId);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const steamApiKey = opts.auth === 'steam' ? readIniValue(opts.steamConfig, 'steam_api_key') : null;
    let server = null, h = null, gate = null, rl = null, ctx = null, fx = null;
    let stopping = false;

    const record = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
    const cleanup = async reason => {
        if (stopping) return;
        stopping = true;
        console.log(`\nStopping spectator instance (${reason})...`);
        if (rl) rl.close();
        try { if (gate) gate.close(); } catch {}
        try { if (h && ctx) await h.destroyUser(ctx.userId, ctx.room); }
        catch (error) { console.error(`fixture cleanup failed: ${error.message}`); }
        try { if (h) h.close(); } catch {}
        try { if (server) await server.stop(); }
        catch (error) { console.error(`server stop failed; quarantined at ${server.root}: ${error.message}`); process.exitCode = 3; return; }
        try { if (server) await server.destroy(); }
        catch (error) { console.error(`server destroy failed; quarantined at ${server.root}: ${error.message}`); process.exitCode = 3; return; }
        console.log('Stopped; scratch server root and copied credentials removed.');
    };

    const onSignal = signal => { cleanup(signal).catch(error => { console.error(error); process.exitCode = 3; }); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
        const step = opts.tickMode === 'step';
        server = await createIsolatedServer({
            runId, httpPort: opts.httpPort, cliPort: opts.cliPort,
            host: opts.host, steamApiKey,
            offlineSteamId: opts.auth === 'none' ? OFFLINE_STEAM_ID : null,
            serverPassword: opts.serverPassword,
            mods: step ? [STEP_MOD] : [], preload: step ? [VIEW_PRELOAD, STEP_PRELOAD] : VIEW_PRELOAD,
        });
        await server.start();
        await server.assertIdentity();
        h = new Harness({ cliHost: server.cliOptions.host, cliPort: server.cliOptions.port });
        await h.connect();
        await h.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])", 15000);
        if (step) gate = await StepClient.connect(server.root, { timeoutMs: 15000 });
        else await h.pauseSimulation();

        const spec = fixtureF0();
        if (opts.room) spec.preferredRooms = [opts.room];
        const p0 = profile(opts.fixture, '__SOURCE_PENDING__');
        spec.creep.body = p0.body;
        spec.creep.name = 'har1';
        fx = await resolveFixture((code, timeout) => h.eval(code, timeout || 15000), spec);
        const p = profile(opts.fixture, fx.actual.source1.id);
        const modules = { main: p.main, 'role.harvester': fs.readFileSync(HARVESTER_FILE, 'utf8') };
        const username = `view_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
        const userId = await h.createUser({ username, modules, roomName: fx.room, spawn: true, spawnPos: fx.actual.spawn });
        await h.dbUpdate('rooms.objects', { $and: [{ room: fx.room }, { type: 'controller' }] }, { level: fx.spec.rcl });
        const creep = await h.insertCreep({
            userId, room: fx.room, x: fx.actual.creep.x, y: fx.actual.creep.y,
            name: fx.spec.creep.name, parts: p.body, store: {}, capacity: 50, age: 1500,
        });
        ctx = { userId, room: fx.room, creepId: creep && creep._id };
        const validation = await validateFixture((code, timeout) => h.eval(code, timeout || 15000), fx, userId);
        if (!validation.ok) throw Error(`fixture invalid: ${validation.problems.join('; ')}`);

        const version = await httpProbe(opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host, opts.httpPort, opts.serverPassword, opts.auth);
        if (opts.auth === 'none') await prepareOfflineSpectator(h);
        if (!step) {
            await h.setTickDuration(opts.tickMs);
            await h.resumeSimulation();
        }
        record('metadata.json', {
            runId, pid: process.pid, created: new Date().toISOString(),
            ports: server.ports, host: opts.host, auth: opts.auth, fixture: opts.fixture,
            room: fx.room, tickMode: opts.tickMode, tickMs: step ? null : opts.tickMs,
            serverRoot: server.root, protocol: version.protocol, packageVersion: version.packageVersion,
            credentialSource: opts.auth === 'steam' ? path.resolve(opts.steamConfig) : null,
        });
        record('fixture.json', fx);
        record('fixture-validation.json', validation);

        const displayHost = opts.host === '0.0.0.0' ? '<server-host>' : opts.host;
        console.log(`Spectator instance ready: ${displayHost}:${opts.httpPort}`);
        console.log(`Room: ${fx.room}; fixture: ${opts.fixture}; auth: ${opts.auth}; tick mode: ${opts.tickMode}${step ? '' : ` (${opts.tickMs} ms)`}`);
        console.log(`Steam client: Change server -> ${displayHost}:${opts.httpPort}`);
        if (opts.host === '127.0.0.1') console.log(`Remote client tunnel: ssh -N -L ${opts.httpPort}:127.0.0.1:${opts.httpPort} <ssh-host>`);
        console.log('Commands: status, pause, resume, speed MS, step [N], help, stop');

        rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
        let commandQueue = Promise.resolve();
        const handleCommand = async raw => {
            const [cmd, value] = raw.trim().split(/\s+/);
            if (!cmd) return;
            if (cmd === 'stop') return cleanup('command');
            if (cmd === 'help') return console.log('status | pause | resume | speed MS | step [N] | stop');
            if (cmd === 'status') {
                await server.assertIdentity();
                return console.log(JSON.stringify({ gameTime: Number(await h.gameTime()), room: fx.room, tickMode: opts.tickMode }));
            }
            if (cmd === 'step') {
                if (!gate) throw Error('step is available only in --tick-mode step');
                const n = value === undefined ? 1 : Number(value);
                if (!Number.isInteger(n) || n < 1 || n > 1000) throw Error('step count must be 1..1000');
                let ack;
                for (let i = 0; i < n; i++) ack = await gate.step({ timeoutMs: 20000 });
                return console.log(JSON.stringify({ stepped: n, gameTime: ack && ack.gameTime, sequence: ack && ack.sequence }));
            }
            if (cmd === 'pause') {
                if (gate) throw Error('step mode is already paused behind the exclusive gate');
                await h.pauseSimulation(); return console.log('paused');
            }
            if (cmd === 'resume') {
                if (gate) throw Error('resume is disabled in step mode; use step N');
                await h.resumeSimulation(); return console.log('resumed');
            }
            if (cmd === 'speed') {
                if (gate) throw Error('speed is unavailable in step mode');
                const ms = Number(value);
                if (!Number.isInteger(ms) || ms < 100 || ms > 600000) throw Error('speed must be 100..600000 ms');
                await h.setTickDuration(ms); return console.log(`tick duration ${ms} ms`);
            }
            console.error(`unknown command: ${cmd}`);
        };
        rl.on('line', raw => {
            commandQueue = commandQueue.then(() => handleCommand(raw))
                .catch(error => { console.error(error.message); });
        });
        // EOF is not an implicit authorization to tear down a useful instance.
        // The child launcher handle keeps this controller alive until a signal.
        await new Promise(resolve => {
            const poll = setInterval(() => { if (stopping) { clearInterval(poll); resolve(); } }, 100);
        });
    } catch (error) {
        console.error(error.message);
        process.exitCode = 3;
        await cleanup('startup failure');
    } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
    }
}

if (require.main === module) {
    let opts;
    try { opts = parseOptions(); }
    catch (error) { console.error(error.message); process.exitCode = 64; }
    if (opts && opts.help) console.log(help());
    else if (opts) run(opts).catch(error => { console.error(error); process.exitCode = 3; });
}

module.exports = { parseOptions, readIniValue, profile, help, run, httpProbe, prepareOfflineSpectator };
