'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseOptions, readIniValue, profile } = require('./view');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screeps-view-test-'));
try {
    const config = path.join(tmp, '.screepsrc');
    fs.writeFileSync(config, '; comment\nsteam_api_key = test-key-123\npassword = ignored\n', { mode: 0o600 });
    assert.equal(readIniValue(config, 'steam_api_key'), 'test-key-123');
    assert.throws(() => readIniValue(config, 'missing'), /missing/);
    assert.equal(parseOptions(['--steam-config', config]).fixture, 'eco-01-d');
    assert.equal(parseOptions(['--steam-config', config]).auth, 'none');
    assert.equal(parseOptions(['--auth', 'steam', '--steam-config', config]).auth, 'steam');
    assert.throws(() => parseOptions(['--host', '0.0.0.0']), /requires/);
    const pub = parseOptions(['--host', '0.0.0.0', '--auth', 'steam', '--server-password-env', 'VIEW_PASS'], { VIEW_PASS: 'secret' });
    assert.equal(pub.serverPassword, 'secret');
    assert.throws(() => parseOptions(['--tick-mode', 'fast']), /tick-mode/);
    assert.throws(() => parseOptions(['--auth', 'none', '--host', '192.0.2.1']), /Tailscale/);
    assert.equal(parseOptions(['--auth', 'none', '--host', '100.96.112.15']).host, '100.96.112.15');
    assert.throws(() => parseOptions(['--room', 'bad']), /room/);
    const eco = profile('eco-01-d', 'src1');
    assert.deepEqual(eco.body, ['work', 'carry', 'move']);
    assert.match(eco.main, /efficiency:1/);
    assert.doesNotMatch(eco.main, /test-key-123/);
    console.log('PASS viewer option, credential-source and profile tests');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
