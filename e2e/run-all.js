// Runs every test*.js in this directory sequentially (each is a self-contained
// process with its own CLI connection and teardown).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const tests = fs.readdirSync(dir)
    .filter(f => /^test\d+.*\.js$/.test(f))
    .sort();

const only = process.argv[2];
const selected = tests.filter(t => !only || t.includes(only));

let failed = 0;
for (const t of selected) {
    console.log(`\n########## ${t} ##########`);
    const r = spawnSync(process.execPath, [path.join(dir, t)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
}

console.log(`\n########## SUMMARY: ${selected.length} file(s), ${failed} failed ##########`);
process.exit(failed ? 1 : 0);
