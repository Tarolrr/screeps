// Contract and schema versions shared by every stage-A module.
// Changing CONTRACT_VERSION (or any DTO/enum in src/bot/domain) is a coordinator
// decision: see docs/strategy/CONTRACTS-A.md "Правила изменения".

/** Version of the stage-A shared contracts (docs/strategy/CONTRACTS-A.md). */
const CONTRACT_VERSION = 'A.4';

/** Memory.strategy schema version planned for StateStore schema1 (ARCHITECTURE §6). */
const SCHEMA_VERSION = 1;

/** Prefix used by fingerprints produced by domain/fingerprint.js. */
const FINGERPRINT_ALGORITHM = 'fnv1a64';

module.exports = {
    CONTRACT_VERSION,
    SCHEMA_VERSION,
    FINGERPRINT_ALGORITHM,
};
