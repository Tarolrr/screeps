'use strict';
const assert = require('assert/strict');
const net = require('net');
const fs = require('fs/promises');
const path = require('path');
const {createIsolatedServer, _peerOwned} = require('./instance');
async function main() {
    await assert.rejects(createIsolatedServer({runId:'invalid-preload',httpPort:32133,cliPort:32134,preload:'relative.js'}), /absolute file path/);
    await assert.rejects(createIsolatedServer({runId:'missing-preload',httpPort:32133,cliPort:32134,preload:'/not/a/real/preload.js'}), /ENOENT/);
    const portServer = net.createServer();
    await new Promise((r,j)=>portServer.once('error',j).listen(32135,'127.0.0.1',r));
    const occupied = await createIsolatedServer({runId:'occupied',httpPort:32135,cliPort:32136});
    try { await assert.rejects(occupied.start(), /EADDRINUSE/); await occupied.destroy(); }
    finally { portServer.close(); }
    const wrong = await createIsolatedServer({runId:'identity',httpPort:32137,cliPort:32138});
    const markerPath = path.join(wrong.root,'ownership.json');
    const original = await fs.readFile(markerPath,'utf8');
    await fs.writeFile(markerPath, '{}');
    await assert.rejects(wrong.assertIdentity(), /identity mismatch/);
    await assert.rejects(wrong.destroy(), /identity mismatch/);
    await fs.writeFile(markerPath, original);
    await wrong.destroy();
    const partial = await createIsolatedServer({runId:'partial',httpPort:32139,cliPort:32140});
    await fs.writeFile(path.join(partial.root,'db.json'),'occupied');
    await assert.rejects(partial.start(), /EEXIST/);
    await partial.destroy();
    for (const [name,binary] of [['missing','/not/a/real/e2e-node'],['immediate','/bin/true']]) {
        const instance = await createIsolatedServer({runId:name,httpPort:32143,cliPort:32144,nodeBinary:binary});
        const starting = instance.start();
        await assert.rejects(instance.destroy(), /operation already in progress/);
        await assert.rejects(starting, /ENOENT|exited|identity/);
        await instance.destroy();
    }
    let received = 0;
    const foreign = net.createServer(sock => sock.on('data', b => { received += b.length; }));
    await new Promise((r,j)=>foreign.once('error',j).listen(32145,'127.0.0.1',r));
    const sock = net.connect(32145,'127.0.0.1');
    await new Promise((r,j)=>sock.once('connect',r).once('error',j));
    assert.equal(_peerOwned(sock, -1),false, 'foreign endpoint must not be accepted');
    sock.destroy(); await new Promise(r=>foreign.close(r));
    assert.equal(received,0,'foreign endpoint must receive no bootstrap command');
    if (process.argv.includes('--offline')) { console.log('PASS offline spawn errors, operation race, foreign peer and setup failures'); return; }
    const s = await createIsolatedServer({runId:'lifecycle',httpPort:32141,cliPort:32142});
    try {
        await s.start();
        assert.equal(await s.assertIdentity(),true);
        await assert.rejects(s.destroy(), /stop instance/);
        await s.stop();
        await s.destroy();
        await assert.rejects(fs.stat(s.root), /ENOENT/);
    } catch (e) { try { await s.stop(); await s.destroy(); } catch (cleanup) { console.error('cleanup failed:', cleanup.message); } throw e; }
    console.log('PASS occupied port, identity mismatch, partial setup, lifecycle');
}
main().catch(e=>{console.error(e);process.exitCode=1});
