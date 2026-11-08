#!/usr/bin/env node
// Build the Screeps strategy bundle: src/bot/main.js -> build/strategy/main.js
// plus build/strategy/manifest.json.
//
//   node tools/build-strategy.js [--outdir <dir>]
//
// - esbuild, CommonJS, platform neutral, single file, no minification;
// - bare imports resolved by explicit aliases: logger -> dist2/logger.js,
//   js-yaml -> dist2/js-yaml.js;
// - the build FAILS if any Node builtin (fs, path, node:*, ...) is imported, if
//   dist2/main.js is pulled in, or if an import cannot be resolved;
// - deterministic: no timestamps, relative paths only; buildId is the
//   fingerprint of (inputs + options + esbuild version), injected into the bundle
//   as __STRATEGY_BUILD_ID__ (two-pass build).
// This tool runs in Node at build time only; the artifact has no Node/npm dependency.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { builtinModules } = require('module');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = 'src/bot/main.js';
const ALIASES = Object.freeze({ logger: './dist2/logger.js', 'js-yaml': './dist2/js-yaml.js' });
const FORBIDDEN_INPUTS = Object.freeze(['dist2/main.js']);
const TARGET = 'es2018';
const SCREEPS_MODULE_NAME = 'main';

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function toPosix(p) {
    return p.split(path.sep).join('/');
}

const BUILTINS = new Set(builtinModules.concat(builtinModules.map(function (m) { return 'node:' + m; })));

/** esbuild plugin: refuse Node builtins in the runtime artifact. */
const noNodeBuiltins = {
    name: 'no-node-builtins',
    setup: function (build) {
        build.onResolve({ filter: /.*/ }, function (args) {
            const bare = args.path.split('/')[0];
            if (args.path.startsWith('node:') || BUILTINS.has(args.path) || BUILTINS.has(bare)) {
                return { errors: [{ text: 'Node builtin "' + args.path + '" is not available in the Screeps runtime (imported from ' + toPosix(path.relative(ROOT, args.importer)) + ')' }] };
            }
            return undefined;
        });
    },
};

function esbuildOptions(buildId, extraPlugins) {
    return {
        absWorkingDir: ROOT,
        entryPoints: [ENTRY],
        bundle: true,
        format: 'cjs',
        platform: 'neutral',
        mainFields: ['main'],
        target: TARGET,
        alias: Object.assign({}, ALIASES),
        define: { __STRATEGY_BUILD_ID__: JSON.stringify(buildId) },
        minify: false,
        sourcemap: false,
        legalComments: 'none',
        charset: 'utf8',
        logLevel: 'silent',
        metafile: true,
        write: false,
        outfile: 'build/strategy/main.js',
        plugins: (extraPlugins || []).concat([noNodeBuiltins]),
    };
}

/** Options that influence the output, hashed into buildId. */
function optionsDigest() {
    return {
        entry: ENTRY,
        format: 'cjs',
        platform: 'neutral',
        target: TARGET,
        aliases: ALIASES,
        esbuildVersion: esbuild.version,
        screepsModuleName: SCREEPS_MODULE_NAME,
    };
}

function listInputs(metafile, allowVirtual) {
    const inputs = Object.keys(metafile.inputs).map(toPosix).sort();
    for (const forbidden of FORBIDDEN_INPUTS) {
        if (inputs.indexOf(forbidden) !== -1) throw new Error('Forbidden input bundled: ' + forbidden);
    }
    return inputs.map(function (rel) {
        if (/^[a-z0-9-]+:/.test(rel)) {
            // plugin namespace (test builds only): no file on disk
            if (!allowVirtual) throw new Error('Virtual input in production build: ' + rel);
            return { path: rel, sha256: sha256(JSON.stringify(metafile.inputs[rel])), bytes: metafile.inputs[rel].bytes, virtual: true };
        }
        const content = fs.readFileSync(path.join(ROOT, rel));
        return { path: rel, sha256: sha256(content), bytes: content.length };
    });
}

/**
 * @param {{outdir?: string, testPlugins?: Array<object>}} [options]
 *   testPlugins: TEST-ONLY esbuild plugins (e.g. redirect dist2 / stageA wiring to
 *   fakes). Such builds are marked testBuild:true and get a 't-' buildId; they
 *   must never be deployed.
 * @returns {Promise<{outFile:string, manifestFile:string, manifest:object}>}
 */
async function buildStrategy(options) {
    const outdir = path.resolve(ROOT, (options && options.outdir) || 'build/strategy');
    const domainVersion = require(path.join(ROOT, 'src/bot/domain/version.js'));

    const testPlugins = (options && options.testPlugins) || null;
    const isTest = testPlugins !== null && testPlugins.length > 0;

    // Pass 1: discover inputs (placeholder buildId).
    const first = await esbuild.build(esbuildOptions('pending', testPlugins));
    const inputs = listInputs(first.metafile, isTest);
    const buildId = (isTest ? 't-' : 'b-') + sha256(JSON.stringify({ inputs: inputs, options: optionsDigest() })).slice(0, 16);

    // Pass 2: final artifact with the buildId injected.
    const second = await esbuild.build(esbuildOptions(buildId, testPlugins));
    const secondInputs = listInputs(second.metafile, isTest);
    if (JSON.stringify(secondInputs) !== JSON.stringify(inputs)) throw new Error('Inputs changed between build passes');
    if (second.outputFiles.length !== 1) throw new Error('Expected exactly one output file');
    const code = Buffer.from(second.outputFiles[0].contents);
    const text = code.toString('utf8');
    if (/^\s*["']use strict["']/.test(text)) throw new Error('Bundle must not be strict at top level (dist2/mapPatch.js relies on sloppy mode)');
    if (!/module\.exports\.loop\s*=|exports\.loop\s*=/.test(text)) throw new Error('Bundle does not export loop');

    const manifest = {
        manifestVersion: 1,
        buildId: buildId,
        testBuild: isTest,
        contractVersion: domainVersion.CONTRACT_VERSION,
        schemaVersion: domainVersion.SCHEMA_VERSION,
        screepsModuleName: SCREEPS_MODULE_NAME,
        entry: ENTRY,
        output: { path: 'main.js', sha256: sha256(code), bytes: code.length },
        builder: optionsDigest(),
        moduleCount: inputs.length,
        inputs: inputs,
    };

    fs.mkdirSync(outdir, { recursive: true });
    const outFile = path.join(outdir, 'main.js');
    const manifestFile = path.join(outdir, 'manifest.json');
    fs.writeFileSync(outFile, code);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    return { outFile: outFile, manifestFile: manifestFile, manifest: manifest };
}

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--outdir' && i + 1 < argv.length) { options.outdir = argv[++i]; continue; }
        throw new Error('Unknown argument: ' + argv[i]);
    }
    return options;
}

if (require.main === module) {
    buildStrategy(parseArgs(process.argv.slice(2))).then(function (result) {
        const rel = toPosix(path.relative(ROOT, result.outFile));
        process.stdout.write(rel + ' ' + result.manifest.output.sha256 + ' buildId=' + result.manifest.buildId + ' modules=' + result.manifest.moduleCount + '\n');
    }).catch(function (error) {
        process.stderr.write('build-strategy failed: ' + (error && error.message ? error.message : String(error)) + '\n');
        if (error && error.errors) {
            for (const e of error.errors) process.stderr.write('  ' + e.text + (e.location ? ' at ' + e.location.file + ':' + e.location.line : '') + '\n');
        }
        process.exitCode = 1;
    });
}

module.exports = { buildStrategy, noNodeBuiltins, ALIASES, ROOT };
