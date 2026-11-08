// A3 reconciliation tests with dist2/mapPatch.js active (as in the bundle).
const test = require('node:test');
const assert = require('node:assert/strict');
const { installMapPatch, isMapPatchActive } = require('../../support/mapPatch');

installMapPatch();
const { defineEventTests, defineFlowTests } = require('./events.suite');
const { defineMatcherTests } = require('./matcher.suite');
const { defineReconcilerTests } = require('./reconciler.suite');

test('mapPatch is active in this process', function () {
    assert.equal(isMapPatchActive(), true);
});

defineEventTests('mapPatch');
defineFlowTests('mapPatch');
defineMatcherTests('mapPatch');
defineReconcilerTests('mapPatch');
