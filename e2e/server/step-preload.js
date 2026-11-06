'use strict';
// This loader transforms only the pinned, isolated engine main entrypoint.
// All game logic, runner, processor and storage remain installed files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
if (process.env.SCREEPS_E2E_ROOT) { try { require('./step-integrity').verifyManifest(); } catch (error) { console.error(error); process.exit(78); } }
const entry = process.argv[1];
if (entry && /[/\\]@screeps[/\\]engine[/\\]dist[/\\]main\.js$/.test(entry)) {
  const root = process.env.SCREEPS_E2E_ROOT;
  const marker = process.env.SCREEPS_E2E_MARKER;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(root, 'ownership.json'), 'utf8'));
    if (!marker || owner.marker !== marker || owner.root !== root || fs.realpathSync(root) !== fs.realpathSync(process.cwd())) throw Error('identity mismatch');
    if (fs.realpathSync(entry) !== '/home/happier/screeps/node_modules/@screeps/engine/dist/main.js') throw Error('unsupported engine path');
    const original = Module._extensions['.js'];
    Module._extensions['.js'] = function (module, filename) {
      if (fs.realpathSync(filename) !== fs.realpathSync(entry)) return original(module, filename);
      let source = fs.readFileSync(filename, 'utf8');
      if (crypto.createHash('sha256').update(source).digest('hex') !== 'd24cbee450dbbb71f2632ab198d37c8595370b5f9c2ef1f6341af7df919899a4') throw Error('unsupported engine main hash');
      const substitutions = [
        ['setTimeout(loop, Math.max(driver.config.mainLoopMinDuration - usedTime, 0));', 'global.__screepsStepSchedule(loop, Math.max(driver.config.mainLoopMinDuration - usedTime, 0));'],
        ['    loop();\n});', '    global.__screepsStepSchedule(loop, 0);\n});']
      ];
      for (const [before, after] of substitutions) {
        if (source.split(before).length !== 2) throw Error('engine scheduler patch mismatch');
        source = source.replace(before, after);
      }
      global.__screepsStepPreload = true;
      return module._compile(source, filename);
    };
  } catch (error) { console.error('E2E preload refused:', error.message); process.exit(78); }
}
