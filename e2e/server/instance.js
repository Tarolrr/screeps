'use strict';
// Disposable Linux-only server. This controls its own process group, not a shared server.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ScreepsCLI } = require('../cli-client');
const RUNS = path.join(__dirname, '.runs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function procInfo(pid) {
    try {
        const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = s.slice(s.lastIndexOf(')') + 2).split(' ');
        return { state: fields[0], group: +fields[2], start: fields[19] };
    } catch { return null; }
}
function groupMembers(group) {
    return fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)).map(Number)
        .filter(pid => { const p = procInfo(pid); return p && p.group === group && p.state !== 'Z'; });
}
async function freePort(port) {
    await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen({host:'127.0.0.1', port, exclusive:true}, () => s.close(resolve));
    });
}
function ownsSocket(inode, group) {
    for (const pid of groupMembers(group)) {
        try {
            for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
                try { if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return true; } catch {}
            }
        } catch {}
    }
    return false;
}
function peerOwned(socket, group) {
    if (!socket || socket.destroyed || socket.remoteAddress !== '127.0.0.1') return false;
    const found = [];
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        for (const line of fs.readFileSync(file, 'utf8').trim().split('\n').slice(1)) {
            const f = line.trim().split(/\s+/);
            if (f[3] === '01' && parseInt(f[1].split(':')[1],16) === socket.remotePort &&
                parseInt(f[2].split(':')[1],16) === socket.localPort) found.push(f[9]);
        }
    }
    return found.length === 1 && ownsSocket(found[0],group);
}
function listenerOwned(port, group) {
    const sockets = new Set();
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        for (const line of fs.readFileSync(file, 'utf8').trim().split('\n').slice(1)) {
            const f = line.trim().split(/\s+/);
            if (parseInt(f[1].split(':')[1], 16) === port && f[3] === '0A') sockets.add(f[9]);
        }
    }
    if (sockets.size !== 1) return false;
    for (const pid of groupMembers(group)) {
        try {
            for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
                try { const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); if (sockets.has((link.match(/^socket:\[(\d+)\]$/) || [])[1])) return true; } catch {}
            }
        } catch {}
    }
    return false;
}
function memAvailable() {
    const m = fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+) kB/m);
    if (!m) throw Error('cannot determine available memory');
    let available = +m[1] * 1024;
    const cg = fs.readFileSync('/proc/self/cgroup','utf8').match(/^0::(\/.*)$/m);
    if (!cg) throw Error('cannot determine cgroup memory budget');
    const base = '/sys/fs/cgroup';
    let dir = path.join(base, cg[1]);
    let checked = false;
    while (dir.startsWith(base)) {
        if (!fs.existsSync(path.join(dir,'memory.max'))) {
            if (dir === base) break;
            dir = path.dirname(dir);
            continue;
        }
        checked = true;
        const limit = fs.readFileSync(path.join(dir,'memory.max'),'utf8').trim();
        const current = Number(fs.readFileSync(path.join(dir,'memory.current'),'utf8').trim());
        if (!Number.isFinite(current)) throw Error('invalid cgroup memory usage');
        if (limit !== 'max') {
            const max = Number(limit);
            if (!Number.isFinite(max)) throw Error('invalid cgroup memory limit');
            available = Math.min(available, Math.max(0, max-current));
        }
        if (dir === base) break;
        dir = path.dirname(dir);
    }
    if (!checked) throw Error('cannot inspect cgroup memory limits');
    return available;
}
async function createIsolatedServer({runId, serverHome = path.join(os.homedir(), 'screeps'), httpPort, cliPort, mods = [], minAvailableBytes = 1024 ** 3, nodeBinary = process.execPath, preload, keepCron = false, seedEnv = null} = {}) {
    if (process.platform !== 'linux') throw Error('Linux process ownership required');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(runId || '')) throw Error('invalid runId');
    for (const p of [httpPort, cliPort]) if (!Number.isInteger(p) || p < 1024 || p > 65535) throw Error('explicit unprivileged ports required');
    if (httpPort === cliPort || [21025,21026].includes(httpPort) || [21025,21026].includes(cliPort)) throw Error('ports must be distinct from live server');
    const home = await fsp.realpath(serverHome);
    const launcher = path.join(home,'node_modules/@screeps/launcher/bin/screeps.js');
    const seed = path.join(home,'node_modules/@screeps/launcher/init_dist/db.json');
    for (const mod of mods) if (!path.isAbsolute(mod) || !(await fsp.stat(mod)).isFile()) throw Error('mods must be existing absolute files');
    let preloadPath;
    if (preload !== undefined) {
        if (typeof preload !== 'string' || !path.isAbsolute(preload) || /[\0\r\n]/.test(preload)) throw Error('preload must be an absolute file path');
        preloadPath = await fsp.realpath(preload);
        if (!(await fsp.stat(preloadPath)).isFile() || /[\0\r\n]/.test(preloadPath)) throw Error('preload must be an existing regular file');
    }
    await fsp.mkdir(RUNS, {recursive:true, mode:0o700});
    const root = await fsp.mkdtemp(path.join(RUNS, runId + '-'));
    const marker = crypto.randomBytes(24).toString('hex');
    const markerFile = path.join(root,'ownership.json');
    let child = null, startTime = null, busy = false, exited = false, spawnError = null;
    function exclusive(fn) { return async (...args) => {
        if (busy) throw Error('instance operation already in progress');
        busy = true; try { return await fn(...args); } finally { busy = false; }
    }; }
    const identity = {runId, marker, root, ports:{http:httpPort,cli:cliPort}, created: new Date().toISOString()};
    await fsp.writeFile(markerFile, JSON.stringify(identity), {mode:0o600, flag:'wx'});
    async function checkIdentity() {
        const actual = JSON.parse(await fsp.readFile(markerFile,'utf8'));
        if (actual.marker !== marker || actual.root !== root || await fsp.realpath(root) !== root || path.dirname(root) !== await fsp.realpath(RUNS)) throw Error('identity mismatch; quarantine');
        if (child) { const p = procInfo(child.pid); if (!p || p.start !== startTime || p.group !== child.pid) throw Error('process identity lost; quarantine'); }
        return true;
    }
    async function stopInternal() {
        if (child && exited && groupMembers(child.pid).length === 0) { child = null; startTime = null; }
        await checkIdentity();
        if (!child) return;
        process.kill(-child.pid, 'SIGTERM');
        for (let i=0;i<100 && groupMembers(child.pid).length;i++) await sleep(100);
        if (groupMembers(child.pid).length) throw Error('process group did not stop; quarantine');
        child = null; startTime = null;
    }
    async function destroyInternal() {
        await checkIdentity();
        if (child) throw Error('stop instance before destroy');
        await fsp.rm(root, {recursive:true});
    }
    async function startInternal() {
        await checkIdentity();
        if (child) throw Error('already started');
        if (memAvailable() < minAvailableBytes) throw Error('insufficient available memory');
        await freePort(httpPort); await freePort(cliPort);
        if (fs.existsSync(path.join(root,'storage.sock'))) throw Error('storage socket already exists; quarantine');
        const db = JSON.parse(await fsp.readFile(seed,'utf8'));
        // Packaged seed, not live world: retain neutral terrain/world and system NPC accounts only.
        const keep = new Set(['2','3']);
        for (const c of db.collections) {
            if (c.name === 'users') c.data = c.data.filter(x => keep.has(x._id));
            if (c.name === 'users.code') c.data = [];
            if (c.name === 'rooms.objects') c.data = c.data.filter(x => ['source','mineral','controller'].includes(x.type) && !x.user && !x.reservation);
        }
        const envCollection = db.collections.find(c => c.name === 'env');
        const envRecord = envCollection && envCollection.data.find(x => x.$loki === 1);
        if (!envRecord || !envRecord.data) throw Error('invalid packaged seed env');
        envRecord.data.e2eInstanceMarker = marker;
        if (seedEnv && typeof seedEnv === 'object') Object.assign(envRecord.data, seedEnv);
        await fsp.writeFile(path.join(root,'db.json'), JSON.stringify(db), {flag:'wx'});
        await fsp.mkdir(path.join(root,'assets'));
        await fsp.mkdir(path.join(root,'logs'));
        const steamModule = require.resolve('steam-webapi', {paths:[path.join(home,'node_modules/@screeps/backend')]});
        const offlineMod = path.join(root,'offline-steam.js');
        await fsp.writeFile(offlineMod, `module.exports = function () { require(${JSON.stringify(steamModule)}).ready = function (cb) { cb(null); }; };\n`, {flag:'wx'});
        await fsp.writeFile(path.join(root,'mods.json'), JSON.stringify({mods:[offlineMod,...mods],bots:{}}), {flag:'wx'});
        const config = `port = ${httpPort}\nhost = 127.0.0.1\ncli_port = ${cliPort}\ncli_host = 127.0.0.1\nrunners_cnt = 1\nrunner_threads = 1\nprocessors_cnt = 1\nlogdir = logs\nmodfile = mods.json\nassetdir = assets\ndb = db.json\nrestart_interval = 3600\n`;
        await fsp.writeFile(path.join(root,'.screepsrc'),config,{flag:'wx',mode:0o600});
        const out = fs.openSync(path.join(root,'launcher.log'),'a');
        try {
            exited = false; spawnError = null;
            child = spawn(nodeBinary,[launcher,'start'], {cwd:root, detached:true, stdio:['ignore',out,out], env:{PATH:process.env.PATH, HOME:root, NODE_ENV:'production', STEAM_KEY:'e2e-offline-placeholder', SCREEPS_E2E_ROOT:root, SCREEPS_E2E_MARKER:marker, ...(keepCron ? {SCREEPS_E2E_KEEP_CRON:'1'} : {}), ...(preloadPath ? {NODE_OPTIONS:`--require=${JSON.stringify(preloadPath)}`} : {})}});
            child.on('error', error => { spawnError = error; });
            child.on('exit', () => { exited = true; });
            await new Promise((resolve,reject) => {
                child.once('spawn', resolve);
                child.once('error', reject);
            });
            const p = procInfo(child.pid);
            if (!p || p.group !== child.pid || p.state === 'Z') {
                if (!groupMembers(child.pid).length) { child = null; throw Error('launcher exited before identity'); }
                throw Error('launcher identity unavailable; quarantine');
            }
            startTime = p.start;
            for (let i=0;i<200;i++) {
                if (spawnError) throw spawnError;
                if (exited) throw Error('launcher exited before readiness');
                await checkIdentity();
                if (listenerOwned(httpPort,child.pid) && listenerOwned(cliPort,child.pid)) {
                    const cli = new ScreepsCLI('127.0.0.1',cliPort);
                    try {
                        await cli.connect();
                        if (!peerOwned(cli.socket,child.pid)) throw Error('CLI peer ownership mismatch');
                        if (await cli.eval(`storage.env.get('e2eInstanceMarker')`) !== marker) throw Error('CLI marker mismatch');
                        if (!peerOwned(cli.socket,child.pid) || !listenerOwned(cliPort,child.pid)) throw Error('CLI peer changed');
                        await checkIdentity();
                    } finally { cli.close(); }
                    return;
                }
                await sleep(100);
            }
            throw Error('launch timeout or port ownership mismatch');
        } catch (err) {
            if (child && !child.pid) { child = null; startTime = null; }
            try { await stopInternal(); } catch (stopErr) { throw Error(`${err.message}; cleanup: ${stopErr.message}`); }
            throw err;
        } finally { fs.closeSync(out); }
    }
    return {root, ports:identity.ports, marker, cliOptions:{host:'127.0.0.1',port:cliPort}, assertIdentity:exclusive(checkIdentity), start:exclusive(startInternal), stop:exclusive(stopInternal), destroy:exclusive(destroyInternal)};
}
module.exports = { createIsolatedServer, _peerOwned: peerOwned };
