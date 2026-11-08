// Static guards for stage-A source rules (docs/strategy/CONTRACTS-A.md §6):
//   - no Array.prototype.flat / Map.prototype.toObject / Map.prototype.filter / Map.fromObject
//     anywhere in src/bot (dist2/mapPatch.js replaces them globally);
//   - pure layers (domain, models, planning, scheduling) do not reference Game,
//     Memory, RawMemory, PathFinder or InterShardMemory and do not require dist2;
//   - no Node builtins in src/bot.
// The scan is textual (comments stripped); it is a tripwire, not a proof.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../../../src/bot');
const PURE_DIRS = ['domain', 'models', 'planning', 'scheduling'];

function listJs(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push.apply(out, listJs(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out.sort();
}

function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

test('src/bot does not use APIs replaced by dist2/mapPatch.js', function () {
    const offenders = [];
    for (const file of listJs(SRC)) {
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        if (/\.flat\s*\(/.test(code) || /\.toObject\s*\(/.test(code) || /Map\.fromObject/.test(code) || /new Map\([^)]*\)\.filter/.test(code)) {
            offenders.push(path.relative(SRC, file));
        }
    }
    assert.deepEqual(offenders, []);
});

test('pure layers do not touch Screeps globals or legacy modules', function () {
    const offenders = [];
    for (const dir of PURE_DIRS) {
        for (const file of listJs(path.join(SRC, dir))) {
            const code = stripComments(fs.readFileSync(file, 'utf8')).replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
            if (/\b(Game|Memory|RawMemory|PathFinder|InterShardMemory)\b/.test(code)) offenders.push(path.relative(SRC, file) + ': global');
        }
        for (const file of listJs(path.join(SRC, dir))) {
            const raw = fs.readFileSync(file, 'utf8');
            if (/require\(\s*['"][^'"]*dist2/.test(raw)) offenders.push(path.relative(SRC, file) + ': dist2 require');
        }
    }
    assert.deepEqual(offenders, []);
});

test('src/bot requires no Node builtins', function () {
    const builtins = require('module').builtinModules;
    const offenders = [];
    for (const file of listJs(SRC)) {
        const raw = fs.readFileSync(file, 'utf8');
        const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
        let m;
        while ((m = re.exec(raw)) !== null) {
            const name = m[1];
            if (name.startsWith('node:') || builtins.indexOf(name.split('/')[0]) !== -1) offenders.push(path.relative(SRC, file) + ': ' + name);
        }
    }
    assert.deepEqual(offenders, []);
});
