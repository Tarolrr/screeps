// A4 finance tests with dist2/mapPatch.js active (as in the bundle).
const test = require('node:test');
const assert = require('node:assert/strict');
const { installMapPatch, isMapPatchActive } = require('../../support/mapPatch');

installMapPatch();
const { defineFinanceTests } = require('./finance.suite');

test('mapPatch is active in this process', function () {
    assert.equal(isMapPatchActive(), true);
});

defineFinanceTests('mapPatch');
