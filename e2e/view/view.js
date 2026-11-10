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
const { ScreepsCLI } = require('../cli-client');
const { fixtureF0, resolveFixture, validateFixture } = require('../har/fixture');
const { arrangeS1, seedMemory } = require('../strat/fixture');
const { readUploadedModules } = require('../strat/runner');
const { pagedEval } = require('../strat/paged');

const REPO = path.resolve(__dirname, '..', '..');
const RUNS = path.join(__dirname, '.runs');
const STEP_MOD = path.join(__dirname, '..', 'server', 'step-mod.js');
const STEP_PRELOAD = path.join(__dirname, '..', 'server', 'step-preload.js');
const VIEW_PRELOAD = path.join(__dirname, 'preload.js');
const HARVESTER_FILE = path.join(REPO, 'dist', 'role.harvester.js');
const OFFLINE_STEAM_ID = '76561197960287930';
const DEFAULT_ARTIFACT = path.join(REPO, 'build', 'strategy', 'main.js');
const DEFAULT_MANIFEST = path.join(REPO, 'build', 'strategy', 'manifest.json');
const FIXTURES = ['har-01', 'eco-01-d', 'strategy'];
const MEM_DEFAULT_LIMIT = 4000;
const MEM_MAX_LIMIT = 20000;

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
        artifact: option(argv, 'artifact', null),
        manifest: option(argv, 'manifest', null),
        overlay: !argv.includes('--no-overlay'),
        consoleStream: !argv.includes('--no-console'),
    };
    if (!Number.isInteger(out.httpPort) || !Number.isInteger(out.cliPort)) throw Error('ports must be integers');
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(out.host) || out.host.split('.').some(x => Number(x) > 255)) throw Error('host must be an explicit IPv4 address');
    if (!['none', 'steam'].includes(out.auth)) throw Error('auth must be none or steam');
    if (!FIXTURES.includes(out.fixture)) throw Error(`fixture must be one of ${FIXTURES.join(', ')}`);
    const strategy = out.fixture === 'strategy';
    if (!strategy && (out.artifact !== null || out.manifest !== null)) throw Error('--artifact/--manifest are valid only with --fixture strategy');
    if (!strategy && !out.overlay) throw Error('--no-overlay is valid only with --fixture strategy');
    out.artifact = strategy ? path.resolve(out.artifact || DEFAULT_ARTIFACT) : null;
    out.manifest = strategy ? path.resolve(out.manifest || DEFAULT_MANIFEST) : null;
    if (argv.includes('--login-as-bot') && argv.includes('--no-login-as-bot')) throw Error('--login-as-bot and --no-login-as-bot are mutually exclusive');
    if (argv.includes('--login-as-bot')) out.loginAsBot = true;
    else if (argv.includes('--no-login-as-bot')) out.loginAsBot = false;
    else out.loginAsBot = strategy && out.auth === 'none';
    // Real Steam auth maps a client to its own Steam account; mapping it onto
    // the scenario user is defined only for the offline (auth none) adapter.
    if (out.loginAsBot && out.auth !== 'none') throw Error('--login-as-bot requires --auth none (offline adapter, disposable world)');
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

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const BUILD_HINT = 'build it first: npm ci && npm run build:strategy';

// Strategy artifact = the single Screeps module `main`, accepted only when the
// file matches its build manifest byte-for-byte.
function loadArtifact(artifactFile, manifestFile) {
    if (!fs.existsSync(artifactFile)) throw Error(`strategy artifact missing: ${artifactFile}; ${BUILD_HINT}`);
    if (!fs.existsSync(manifestFile)) throw Error(`strategy manifest missing: ${manifestFile}; ${BUILD_HINT}`);
    const buf = fs.readFileSync(artifactFile);
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
    catch (error) { throw Error(`strategy manifest unreadable: ${error.message}; ${BUILD_HINT}`); }
    const out = manifest.output || {};
    const fileSha256 = sha256(buf);
    const problems = [];
    if (out.sha256 !== fileSha256) problems.push(`manifest sha256 ${out.sha256} != artifact ${fileSha256}`);
    if (out.bytes !== buf.length) problems.push(`manifest bytes ${out.bytes} != artifact ${buf.length}`);
    if (manifest.screepsModuleName !== 'main') problems.push(`manifest screepsModuleName ${manifest.screepsModuleName} != main`);
    if (manifest.testBuild !== false) problems.push(`manifest testBuild=${manifest.testBuild} (test builds are not deployable)`);
    if (problems.length) throw Error(`strategy artifact refused: ${problems.join('; ')}; rebuild: npm run build:strategy`);
    return {
        code: buf.toString('utf8'),
        info: { artifact: artifactFile, manifest: manifestFile, sha256: fileSha256, bytes: buf.length,
            buildId: manifest.buildId || null, contractVersion: manifest.contractVersion || null, moduleCount: manifest.moduleCount || null },
    };
}

// Memory seed for the strategy profile: shadow requested for ROOM (legacy keeps
// executing) plus operator view flags read by the presenter, if present.
function strategySeed(room, overlay) {
    return {
        strategy: {
            schemaVersion: 1, policyVersion: null, buildId: null, revision: 0, lastClosedTick: null, recentPatchIds: [],
            control: { rooms: { [room]: { requestedMode: 'shadow', effectiveOwner: 'legacy', epoch: 0,
                transitionPhase: null, transitionId: null, previousOwner: null, blockedReason: null } } },
            rooms: {}, missions: {}, demands: {}, bindings: {}, assignments: {},
            ledger: { reservations: {}, funds: {}, missionExposure: {} }, operations: {}, faults: {},
            migrations: { version: 1, cursor: null, sourceRevision: null, status: 'NONE' },
        },
        strategyView: { rooms: { [room]: { overlay: !!overlay } }, console: true },
    };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
        }
        const v = ENTITIES[e.toLowerCase()];
        return v === undefined ? m : v;
    });
}

// Screeps console lines are HTML; the terminal gets plain text without control
// sequences (an in-game string must not drive the operator's terminal).
function consoleText(raw) {
    // strip tags, decode entities, then drop only colour markup that arrived escaped
    // (&lt;span style=..&gt;); other escaped text such as &lt;b&gt; stays literal
    const text = decodeEntities(String(raw).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
        .replace(/<\/?(?:span|font)(?:\s[^<>]*)?>/gi, '');
    return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?');
}

const RED_MARKUP = /color\s*[:=]\s*["']?\s*(?:red|#f00\b|#ff0000|#f[0-9a-f]{2}0{2}\b|#e[0-9a-f]0{4}|rgb\(\s*2[0-9]{2}\s*,\s*[0-6]?[0-9]\s*,\s*[0-6]?[0-9]\s*\))/i;

// One pubsub console message -> terminal lines [{text, level}].
function formatConsoleMessage(msg, prefix) {
    const out = [];
    const tag = `[${msg.gt === null || msg.gt === undefined ? '?' : msg.gt}]`;
    const push = (raw, level, mark) => {
        for (const line of consoleText(raw).split('\n')) out.push({ text: `${prefix}${tag}${mark}${line}`, level });
    };
    for (const raw of msg.lines || []) push(raw, RED_MARKUP.test(String(raw)) ? 'error' : 'log', ' ');
    for (const raw of msg.results || []) push(raw, 'log', ' => ');
    if (msg.error) push(msg.error, 'error', ' ERROR ');
    if (msg.dropped) out.push({ text: `${prefix}${tag} (${msg.dropped} console message(s) dropped by the bounded buffer)`, level: 'error' });
    return out;
}

// Dedicated admin-CLI connection subscribed to the bot's console channel (same
// channel the client uses). Messages are buffered server-side (bounded) and
// drained by polling; pubsub is best effort, not a journal.
class ConsoleTail {
    constructor(cliOptions) {
        this.cli = new ScreepsCLI(cliOptions.host, cliOptions.port);
        this.slot = `__viewCon${process.pid}`;
    }
    async start(userId) {
        await this.cli.connect();
        const slot = JSON.stringify(this.slot);
        const ok = await this.cli.eval(`(function(){
            var c = globalThis[${slot}] = {msgs: [], n: 0, dropped: 0};
            storage.pubsub.subscribe(${JSON.stringify('user:' + userId + '/console')}, function(raw){
                var m; try { m = JSON.parse(raw); } catch (e) { m = {error: 'unparsable console payload'}; }
                var msgs = m.messages || {};
                var e = {gt: null, lines: (msgs.log || []).slice(0, 200).map(function(l){ return String(l).slice(0, 1000); }),
                    results: (msgs.results || []).slice(0, 50).map(function(l){ return String(l).slice(0, 1000); }),
                    error: m.error ? String(m.error).slice(0, 2000) : null, dropped: 0};
                c.n++;
                if (c.msgs.length >= 500) { c.msgs.shift(); c.dropped++; }
                if (c.dropped) { e.dropped = c.dropped; c.dropped = 0; }
                c.msgs.push(e);
                storage.env.get('gameTime').then(function(gt){ e.gt = Number(gt); }, function(){});
            });
            return true;
        })()`, 15000);
        if (ok !== true) throw Error('console subscribe failed');
    }
    async drain() {
        const out = [];
        for (let guard = 0; guard < 20; guard++) {
            const r = await pagedEval(this.cli, `(function(){ var c = globalThis[${JSON.stringify(this.slot)}]; return {msgs: c.msgs.splice(0, 50), left: c.msgs.length}; })()`, 15000);
            out.push(...r.msgs);
            if (!r.left) break;
        }
        return out;
    }
    close() { try { this.cli.close(); } catch {} }
}

// `mem a.b.c [limit]` -> bounded JSON excerpt of the bot's Memory.
function parseMemCommand(args) {
    const [pathArg, limitArg] = args;
    const segments = pathArg ? pathArg.split('.') : [];
    if (segments.some(x => !/^[A-Za-z0-9_$-]{1,64}$/.test(x)) || segments.length > 16) throw Error('mem path must be dot-separated keys like strategyShadow.rooms.W9N8.decisionRing');
    const limit = limitArg === undefined ? MEM_DEFAULT_LIMIT : Number(limitArg);
    if (!Number.isInteger(limit) || limit < 100 || limit > MEM_MAX_LIMIT) throw Error(`mem limit must be 100..${MEM_MAX_LIMIT}`);
    return { segments, limit };
}

function memExpr(userId, segments, limit) {
    return `storage.env.get(${JSON.stringify('memory:' + userId)}).then(function(raw){
        var v; try { v = JSON.parse(raw || '{}'); } catch (e) { return {error: 'Memory is not valid JSON'}; }
        var segs = ${JSON.stringify(segments)};
        for (var i = 0; i < segs.length; i++) {
            if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, segs[i])) return {missing: segs.slice(0, i + 1).join('.')};
            v = v[segs[i]];
        }
        var keys = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).slice(0, 50) : null;
        var s = JSON.stringify(v, null, 1);
        if (s === undefined) s = 'undefined';
        return {bytes: s.length, text: s.slice(0, ${limit}), truncated: s.length > ${limit}, keys: keys, rawBytes: (raw || '').length};
    })`;
}

// `strat <cmd>` -> expression for the bot sandbox. Bare `strat report` calls
// strat.report(ROOM); otherwise the text after `strat` must be a strat.* call.
function stratExpression(rest, room) {
    let text = String(rest || '').trim();
    if (!text) throw Error('usage: strat report | strat why | strat visual(\'W9N8\', true) | strat export(10)');
    if (/[\r\n\0]/.test(text) || text.length > 300) throw Error('strat command must be a single line of at most 300 characters');
    if (!text.startsWith('strat.')) text = `strat.${text}`;
    if (/^strat\.[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) text = `${text}(${JSON.stringify(room)})`;
    // one call of a known strat.* command with literal arguments only (room string, boolean, integer)
    const ARG = `(?:'[A-Za-z0-9]{1,12}'|"[A-Za-z0-9]{1,12}"|true|false|-?[0-9]{1,6})`;
    const CALL = new RegExp(`^strat\\.(?:report|why|visual|export|help)\\s*\\(\\s*(?:${ARG}(?:\\s*,\\s*${ARG}){0,2})?\\s*\\)\\s*;?$`);
    if (!CALL.test(text)) throw Error('strat command must be one call like strat.report(\'W9N8\') with literal arguments');
    return `(typeof strat === 'undefined' ? 'strat.* console commands are not installed by this artifact' : ${text.replace(/;\s*$/, '')})`;
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
        // Resolve the account the token belongs to; the token itself is never stored.
        const me = await fetch(`${base}/api/auth/me`, {
            headers: Object.assign({ 'X-Token': payload.token, 'X-Username': payload.token }, headers),
        });
        const account = me.ok ? await me.json() : null;
        if (!account || !account._id) throw Error(`offline login probe: /api/auth/me failed: ${me.status}`);
        result.offlineLogin = true;
        result.offlineUser = { id: String(account._id), username: account.username || null };
    }
    return result;
}

// --login-as-bot: bind the offline adapter's fixed Steam ID to the scenario
// user before any client login, so every client session becomes that user.
async function bindOfflineLoginToBot(h, userId) {
    const id = OFFLINE_STEAM_ID;
    const holders = await h.eval(`storage.db.users.find({'steam.id':${JSON.stringify(id)}}).then(function(r){ return r.map(function(u){ return u._id; }); })`, 10000);
    if (holders.some(x => x !== userId)) throw Error('offline Steam ID is already bound to another account; refusing to rebind');
    await h.dbUpdate('users', { _id: userId }, { steam: { id } });
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

const COMMANDS = 'status | pause | resume | speed MS | step [N] | console on|off | mem PATH [LIMIT] | strat CMD | help | stop';

function help() {
    return `Usage: node e2e/view/view.js [options]

  --fixture eco-01-d|har-01|strategy
                              F0 scenario profile (default eco-01-d); strategy
                              uploads build/strategy/main.js as module main over
                              the STRAT S1 fixture with shadow seeded for ROOM
  --artifact PATH             strategy artifact (default build/strategy/main.js)
  --manifest PATH             its manifest (default build/strategy/manifest.json)
  --no-overlay                strategy: seed Memory.strategyView overlay=false
  --login-as-bot              auth none: every client login becomes the bot user
                              (default for --fixture strategy; disposable world only)
  --no-login-as-bot           auth none: separate view_spectator account instead
  --no-console                do not stream the bot console to this terminal
  --room W9N8                 require this packaged-seed room
  --http-port 32500           fixed client port
  --cli-port 32501            fixed loopback-only admin port
  --host IPv4                  loopback, Tailscale IP, or guarded 0.0.0.0
  --auth none|steam            offline adapter or real Steam auth (default none)
  --steam-config PATH         source .screepsrc containing steam_api_key
  --server-password-env NAME  required for 0.0.0.0; secret is read from env
  --tick-mode slow|step       continuous slow ticks or manual fenced steps
  --tick-ms 2000              slow-mode tick duration

Interactive commands: ${COMMANDS}`;
}

function makeJournal(file) {
    return {
        add(kind, id, action, detail, ok = true) {
            fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), kind, id, action, detail, ok }) + '\n', { mode: 0o600 });
        },
    };
}

async function run(opts) {
    const runId = `view-${Date.now()}-${process.pid}`;
    const runDir = path.join(RUNS, runId);
    const strategy = opts.fixture === 'strategy';
    // Refuse a missing/mismatching artifact before any server is created.
    let art = null;
    if (strategy) {
        try { art = loadArtifact(opts.artifact, opts.manifest); }
        catch (error) { console.error(error.message); process.exitCode = 2; return; }
    }
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const steamApiKey = opts.auth === 'steam' ? readIniValue(opts.steamConfig, 'steam_api_key') : null;
    let server = null, h = null, gate = null, rl = null, ctx = null, fx = null, con = null, conTimer = null;
    let stopping = false, consoleOn = opts.consoleStream;
    const color = process.stdout.isTTY && !process.env.NO_COLOR;

    const record = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
    const cleanup = async reason => {
        if (stopping) return;
        stopping = true;
        console.log(`\nStopping spectator instance (${reason})...`);
        if (conTimer) clearInterval(conTimer);
        if (con) con.close();
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

        const evalFx = (code, timeout) => h.eval(code, timeout || 15000);
        const username = `view_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
        let validation, uploaded = null, memorySeedKeys = null;
        if (strategy) {
            // STRAT S1: HAR F0 plus mule/upgrader/builder/container/site so the
            // legacy dist2 inside the artifact has real work to do.
            const spec = fixtureF0();
            if (opts.room) spec.preferredRooms = [opts.room];
            fx = await resolveFixture(evalFx, spec);
            const journal = makeJournal(path.join(runDir, 'arrange-journal.jsonl'));
            const s1 = await arrangeS1(h, fx, journal, { username, modules: { main: art.code } });
            ctx = { userId: s1.userId, room: s1.room, creepId: s1.creepId };
            validation = await validateFixture(evalFx, fx, ctx.userId);
            if (!validation.ok) throw Error(`fixture invalid: ${validation.problems.join('; ')}`);
            uploaded = await readUploadedModules(h, ctx.userId);
            const names = uploaded ? Object.keys(uploaded.hashes) : [];
            if (!uploaded || names.length !== 1 || uploaded.hashes.main !== art.info.sha256) {
                throw Error(`uploaded code is not exactly {main} with the manifest sha256 (got ${names.join(',') || 'none'})`);
            }
            const seeded = await seedMemory(h, s1, strategySeed(fx.room, opts.overlay), journal);
            memorySeedKeys = Object.keys(seeded);
        } else {
            const spec = fixtureF0();
            if (opts.room) spec.preferredRooms = [opts.room];
            const p0 = profile(opts.fixture, '__SOURCE_PENDING__');
            spec.creep.body = p0.body;
            spec.creep.name = 'har1';
            fx = await resolveFixture(evalFx, spec);
            const p = profile(opts.fixture, fx.actual.source1.id);
            const modules = { main: p.main, 'role.harvester': fs.readFileSync(HARVESTER_FILE, 'utf8') };
            const userId = await h.createUser({ username, modules, roomName: fx.room, spawn: true, spawnPos: fx.actual.spawn });
            await h.dbUpdate('rooms.objects', { $and: [{ room: fx.room }, { type: 'controller' }] }, { level: fx.spec.rcl });
            const creep = await h.insertCreep({
                userId, room: fx.room, x: fx.actual.creep.x, y: fx.actual.creep.y,
                name: fx.spec.creep.name, parts: p.body, store: {}, capacity: 50, age: 1500,
            });
            ctx = { userId, room: fx.room, creepId: creep && creep._id };
            validation = await validateFixture(evalFx, fx, userId);
            if (!validation.ok) throw Error(`fixture invalid: ${validation.problems.join('; ')}`);
        }

        if (opts.loginAsBot) await bindOfflineLoginToBot(h, ctx.userId);
        const version = await httpProbe(opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host, opts.httpPort, opts.serverPassword, opts.auth);
        if (opts.auth === 'none') {
            if (opts.loginAsBot) {
                if (version.offlineUser.id !== ctx.userId) throw Error(`offline login mapped to ${version.offlineUser.id}, not the bot user ${ctx.userId}`);
            } else {
                await prepareOfflineSpectator(h);
            }
        }

        if (opts.consoleStream) {
            con = new ConsoleTail(server.cliOptions);
            await con.start(ctx.userId);
            let draining = false, failures = 0;
            conTimer = setInterval(() => {
                if (draining || stopping) return;
                draining = true;
                con.drain().then(msgs => {
                    failures = 0;
                    if (!consoleOn || stopping) return;
                    for (const m of msgs) {
                        for (const line of formatConsoleMessage(m, 'bot ')) {
                            if (line.level === 'error') console.log(color ? `\x1b[31m${line.text}\x1b[0m` : line.text);
                            else console.log(line.text);
                        }
                    }
                }).catch(error => {
                    if (!stopping && ++failures === 3) console.error(`console stream read failing: ${error.message}`);
                }).finally(() => { draining = false; });
            }, 500);
        }

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
            loginAsBot: opts.loginAsBot, botUser: { id: ctx.userId, username },
            offlineLoginUser: version.offlineUser || null,
            artifact: art ? art.info : null, uploadedMainSha256: uploaded ? uploaded.hashes.main : null,
            memorySeedKeys, overlay: strategy ? opts.overlay : null,
        });
        record('fixture.json', fx);
        record('fixture-validation.json', validation);

        const displayHost = opts.host === '0.0.0.0' ? '<server-host>' : opts.host;
        console.log(`Spectator instance ready: ${displayHost}:${opts.httpPort} (run ${runId})`);
        console.log(`Room: ${fx.room}; fixture: ${opts.fixture}; auth: ${opts.auth}; tick mode: ${opts.tickMode}${step ? '' : ` (${opts.tickMs} ms)`}`);
        if (art) console.log(`Artifact: ${path.relative(REPO, art.info.artifact)} sha256 ${art.info.sha256} buildId ${art.info.buildId}; uploaded main verified`);
        if (opts.auth === 'none') {
            console.log(opts.loginAsBot
                ? `Client login: offline, AS THE BOT USER ${username} (${ctx.userId}); disposable world only`
                : 'Client login: offline, separate view_spectator account');
        }
        console.log(`Steam client: Change server -> ${displayHost}:${opts.httpPort}`);
        if (opts.host === '127.0.0.1') console.log(`Remote client tunnel: ssh -N -L ${opts.httpPort}:127.0.0.1:${opts.httpPort} <ssh-host>`);
        console.log(`Bot console stream: ${consoleOn ? 'on' : 'off'}`);
        console.log(`Commands: ${COMMANDS}`);

        rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
        let commandQueue = Promise.resolve();
        const handleCommand = async raw => {
            const parts = raw.trim().split(/\s+/);
            const [cmd, value] = parts;
            if (!cmd) return;
            if (cmd === 'stop') return cleanup('command');
            if (cmd === 'help') return console.log(COMMANDS);
            if (cmd === 'status') {
                await server.assertIdentity();
                const st = await h.eval(`Promise.all([
                    storage.env.get('gameTime'),
                    storage.db['rooms.objects'].count({$and: [{user: ${JSON.stringify(ctx.userId)}}, {type: 'creep'}]}),
                    storage.env.get(${JSON.stringify('memory:' + ctx.userId)})
                ]).then(function(r){
                    var m = {}; try { m = JSON.parse(r[2] || '{}'); } catch (e) {}
                    return {gameTime: Number(r[0]), creeps: r[1], memoryBytes: (r[2] || '').length,
                        lastClosedTick: m.strategy ? m.strategy.lastClosedTick : null, strategyShadow: !!m.strategyShadow};
                })`, 15000);
                return console.log(JSON.stringify(Object.assign({ room: fx.room, tickMode: opts.tickMode, console: consoleOn }, st)));
            }
            if (cmd === 'console') {
                if (value !== 'on' && value !== 'off') throw Error('usage: console on|off');
                if (!con) throw Error('console stream was disabled at startup (--no-console)');
                consoleOn = value === 'on';
                return console.log(`bot console stream ${value}`);
            }
            if (cmd === 'mem') {
                const { segments, limit } = parseMemCommand(parts.slice(1));
                const r = await pagedEval(h.cli, memExpr(ctx.userId, segments, limit), 30000);
                if (r.error) throw Error(r.error);
                if (r.missing) return console.log(`Memory.${r.missing}: absent`);
                console.log(`Memory${segments.length ? '.' + segments.join('.') : ''} (${r.bytes} chars${r.truncated ? `, first ${limit} shown` : ''}; Memory ${r.rawBytes} chars)`);
                if (r.keys) console.log(`keys: ${r.keys.map(consoleText).join(', ')}`);
                return console.log(r.text + (r.truncated ? '\n...(truncated)' : ''));
            }
            if (cmd === 'strat') {
                const expression = stratExpression(raw.trim().slice(cmd.length), fx.room);
                await h.dbInsert('users.console', { user: ctx.userId, expression, hidden: false });
                return console.log(`queued for the next bot tick: ${expression}${con && consoleOn ? '' : ' (console stream is off; the result goes to the client console)'}`);
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

module.exports = {
    parseOptions, readIniValue, profile, help, run, httpProbe, prepareOfflineSpectator, bindOfflineLoginToBot,
    loadArtifact, strategySeed, consoleText, formatConsoleMessage, parseMemCommand, memExpr, stratExpression, ConsoleTail,
};
