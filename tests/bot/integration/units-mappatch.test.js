// STRAT-A5 pure-module checks with dist2/mapPatch.js active (as in the bundle).
const test = require('node:test');
const assert = require('node:assert/strict');
const { installMapPatch, isMapPatchActive } = require('../support/mapPatch');

installMapPatch();
const { defineUnitTests } = require('./units.suite');

test('mapPatch is active in this process', function () {
    assert.equal(isMapPatchActive(), true);
});

defineUnitTests('mapPatch');
