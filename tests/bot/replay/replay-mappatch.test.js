// Replay tests with dist2/mapPatch.js active.
const { installMapPatch } = require('../support/mapPatch');
installMapPatch();
const { defineReplayTests } = require('./replay.suite');
defineReplayTests('replay+mapPatch');
