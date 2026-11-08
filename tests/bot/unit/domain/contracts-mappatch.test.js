// Contract A.2 domain tests with dist2/mapPatch.js active (as in the bundle).
const test = require('node:test');
const assert = require('node:assert/strict');
const { installMapPatch, isMapPatchActive } = require('../../support/mapPatch');

installMapPatch();
const { defineContractTests } = require('./contracts.suite');

test('mapPatch is active in this process', function () {
    assert.equal(isMapPatchActive(), true);
    assert.throws(function () { [].flat(); }, TypeError, 'patched flat throws on empty arrays');
    assert.deepEqual(new Map([['a', 1]]).toObject(), { a: 1 });
});

defineContractTests('mapPatch');
