// Same reader tests with dist2/mapPatch.js active.
const test = require('node:test');
const assert = require('node:assert/strict');
const { installMapPatch, isMapPatchActive } = require('../../support/mapPatch');
installMapPatch();
const { defineReaderTests } = require('./reader.suite');

test('mapPatch is active', function () { assert.equal(isMapPatchActive(), true); });
defineReaderTests('reader+mapPatch');
