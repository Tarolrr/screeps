// The test loader itself must behave like engine requireFn/evalCode.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScreepsSandbox } = require('../../support/screepsLoader');

test('strips leading ./ only, no path resolution', function () {
    const s = createScreepsSandbox({ modules: { a: "module.exports = require('./b') + 1;", b: 'module.exports = 41;', 'dir/c': 'module.exports = 1;' } });
    assert.equal(s.require('a'), 42);
    assert.equal(s.require('./a'), 42);
    assert.throws(function () { s.require('../a'); }, /Unknown module '\.\.\/a'/);
    assert.throws(function () { s.require('c'); }, /Unknown module 'c'/);
    assert.equal(s.require('dir/c'), 1, 'flat name lookup, slash is part of the name');
});

test('circular require is an error; throwing module is retried', function () {
    const s = createScreepsSandbox({ modules: { x: "require('y');", y: "require('x');", bad: "if (!globalThis.tries) globalThis.tries = 0; tries++; if (tries === 1) throw new Error('first'); module.exports = tries;" } });
    assert.throws(function () { s.require('x'); }, /Circular reference to module 'x'/);
    assert.throws(function () { s.require('bad'); }, /first/);
    assert.equal(s.require('bad'), 2);
    assert.equal(s.require('bad'), 2, 'cached after success');
});

test('modules are sloppy mode and share sandbox globals, not host globals', function () {
    const s = createScreepsSandbox({ modules: { m: 'leaked = 5; module.exports = typeof Game;' }, Game: { time: 1 } });
    assert.equal(s.require('m'), 'object');
    assert.equal(s.evaluate('leaked'), 5);
    assert.equal(typeof globalThis.leaked, 'undefined');
});
