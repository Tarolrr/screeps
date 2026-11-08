// Public surface of the pure domain layer (contract A.2).
// Pure: no Game, Memory, RawMemory, console or legacy singletons.

const version = require('./version');
const canonical = require('./canonical');
const fingerprint = require('./fingerprint');
const reasonCodes = require('./reasonCodes');
const results = require('./results');
const enums = require('./enums');
const keys = require('./keys');
const freeze = require('./freeze');
const dtos = require('./dtos');
const stateLayout = require('./stateLayout');

module.exports = Object.assign({}, version, canonical, fingerprint, reasonCodes, results, enums, keys, freeze, dtos, stateLayout);
