'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
    parseOptions, readIniValue, profile, loadArtifact, strategySeed, consoleText, formatConsoleMessage,
    parseMemCommand, memExpr, stratExpression,
} = require('./view');

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

    // Profile defaults: old profiles keep the spectator account; strategy logs in as the bot.
    const dflt = parseOptions([]);
    assert.equal(dflt.loginAsBot, false);
    assert.equal(dflt.artifact, null);
    assert.equal(dflt.consoleStream, true);
    const st = parseOptions(['--fixture', 'strategy']);
    assert.equal(st.loginAsBot, true);
    assert.equal(st.overlay, true);
    assert.match(st.artifact, /build\/strategy\/main\.js$/);
    assert.match(st.manifest, /build\/strategy\/manifest\.json$/);
    assert.equal(parseOptions(['--fixture', 'strategy', '--no-login-as-bot']).loginAsBot, false);
    assert.equal(parseOptions(['--fixture', 'strategy', '--no-overlay']).overlay, false);
    assert.equal(parseOptions(['--fixture', 'strategy', '--no-console']).consoleStream, false);
    assert.equal(parseOptions(['--fixture', 'eco-01-d', '--login-as-bot']).loginAsBot, true);
    assert.equal(parseOptions(['--fixture', 'strategy', '--artifact', 'x/a.js']).artifact, path.resolve('x/a.js'));
    // Refusals.
    assert.throws(() => parseOptions(['--fixture', 'strategy', '--login-as-bot', '--no-login-as-bot']), /mutually exclusive/);
    assert.throws(() => parseOptions(['--fixture', 'strategy', '--auth', 'steam', '--login-as-bot']), /requires --auth none/);
    assert.equal(parseOptions(['--fixture', 'strategy', '--auth', 'steam', '--steam-config', config]).loginAsBot, false);
    assert.throws(() => parseOptions(['--fixture', 'eco-01-d', '--artifact', 'a.js']), /only with --fixture strategy/);
    assert.throws(() => parseOptions(['--fixture', 'har-01', '--no-overlay']), /only with --fixture strategy/);
    assert.throws(() => parseOptions(['--fixture', 'bogus']), /fixture must be/);
    assert.throws(() => parseOptions(['--fixture', 'strategy', '--host', '192.0.2.1']), /Tailscale/);
    assert.throws(() => parseOptions(['--fixture', 'strategy', '--host', '0.0.0.0'], { P: 'x' }), /requires/);
    assert.throws(() => parseOptions(['--fixture', 'strategy', '--host', '0.0.0.0', '--server-password-env', 'P'], { P: 'x' }), /Tailscale/);
    assert.equal(parseOptions(['--fixture', 'strategy', '--host', '100.96.112.15']).loginAsBot, true);

    // Artifact verification against the manifest.
    const art = path.join(tmp, 'main.js'), man = path.join(tmp, 'manifest.json');
    assert.throws(() => loadArtifact(art, man), /missing.*npm run build:strategy/);
    const code = 'module.exports.loop = function () {};\n';
    fs.writeFileSync(art, code);
    const good = { screepsModuleName: 'main', testBuild: false, buildId: 'b-1', output: { sha256: crypto.createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code) } };
    assert.throws(() => loadArtifact(art, man), /manifest missing/);
    fs.writeFileSync(man, JSON.stringify(good));
    const loaded = loadArtifact(art, man);
    assert.equal(loaded.code, code);
    assert.equal(loaded.info.sha256, good.output.sha256);
    fs.writeFileSync(man, JSON.stringify(Object.assign({}, good, { output: { sha256: '0'.repeat(64), bytes: good.output.bytes } })));
    assert.throws(() => loadArtifact(art, man), /refused: manifest sha256/);
    fs.writeFileSync(man, JSON.stringify(Object.assign({}, good, { testBuild: true })));
    assert.throws(() => loadArtifact(art, man), /testBuild/);

    // Memory seed shape.
    const seed = strategySeed('W9N8', true);
    assert.deepEqual(seed.strategy.control.rooms.W9N8, { requestedMode: 'shadow', effectiveOwner: 'legacy', epoch: 0,
        transitionPhase: null, transitionId: null, previousOwner: null, blockedReason: null });
    assert.equal(seed.strategy.schemaVersion, 1);
    assert.deepEqual(seed.strategy.migrations, { version: 1, cursor: null, sourceRevision: null, status: 'NONE' });
    assert.deepEqual(seed.strategyView, { rooms: { W9N8: { overlay: true } }, console: true });
    assert.equal(strategySeed('W9N8', false).strategyView.rooms.W9N8.overlay, false);

    // Console rendering: HTML stripped, entities decoded, no terminal control sequences.
    assert.equal(consoleText('<span style="color:#ff0000">a &lt;b&gt; &amp; c</span>'), 'a <b> & c');
    assert.equal(consoleText('x\u001b[2Jy'), 'x?[2Jy');
    const lines = formatConsoleMessage({ gt: 42, lines: ['ok<br>two', '<font color="red">bad</font>'], results: ['7'], error: 'Error: boom\n at x' }, '');
    assert.deepEqual(lines.map(l => l.text), ['[42] ok', '[42] two', '[42] bad', '[42] => 7', '[42] ERROR Error: boom', '[42] ERROR  at x']);
    assert.deepEqual(lines.map(l => l.level), ['log', 'log', 'error', 'log', 'error', 'error']);
    assert.equal(formatConsoleMessage({ gt: null, lines: ['x'] }, '')[0].text, '[?] x');

    // mem / strat command parsing.
    assert.deepEqual(parseMemCommand(['strategyShadow.rooms.W9N8.decisionRing']), { segments: ['strategyShadow', 'rooms', 'W9N8', 'decisionRing'], limit: 4000 });
    assert.deepEqual(parseMemCommand([]), { segments: [], limit: 4000 });
    assert.equal(parseMemCommand(['a', '9000']).limit, 9000);
    assert.throws(() => parseMemCommand(['a;b']), /dot-separated/);
    assert.throws(() => parseMemCommand(['a', '50']), /limit/);
    assert.match(memExpr('u1', ['a'], 100), /memory:u1/);
    assert.match(stratExpression(' report', 'W9N8'), /strat\.report\("W9N8"\)\)$/);
    assert.match(stratExpression("strat.visual('W9N8', false)", 'W9N8'), /: strat\.visual\('W9N8', false\)\)$/);
    assert.match(stratExpression('export(10);', 'W9N8'), /: strat\.export\(10\)\)$/);
    assert.throws(() => stratExpression('', 'W9N8'), /usage/);
    assert.throws(() => stratExpression('report; Game.cpu', 'W9N8'), /one call/);
    assert.throws(() => stratExpression('report\nx', 'W9N8'), /single line/);
    console.log('PASS viewer option, credential-source, profile, artifact, seed and console tests');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

// strat runner command: only one known strat.* call with literal args; escaped markup stripped
assert.match(stratExpression('report', 'W9N8'), /strat\.report\("W9N8"\)/);
assert.match(stratExpression("visual('W9N8', true)", 'W9N8'), /strat\.visual\('W9N8', true\)/);
for (const bad of ['strat.help(), Game.creeps.x.suicide()', 'report(1); Game.spawns.S.destroy()', 'report(Game)', 'evil()', 'report("W9N8") + 1']) {
    assert.throws(() => stratExpression(bad, 'W9N8'), /one call/);
}
assert.equal(consoleText('&lt;span style="x"&gt;mode&lt;/span&gt; <b>b</b>'), 'mode b');
assert.equal(consoleText('a &lt;b&gt; c'), 'a <b> c');
assert.equal(consoleText('\u001b[31mx'), '?[31mx');
