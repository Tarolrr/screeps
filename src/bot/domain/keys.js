// Identity keys of contract A.2 (ARCHITECTURE §4, §5).
//
// operationKey = domain / ownerEpoch / demandStableKey / generation / action / occurrence
//   Text segments escape '%' -> '%25' and '/' -> '%2F' (only these two), so a
//   demandStableKey such as 'W1N1/feeding/spawn1' survives the round-trip.
//   ownerEpoch and generation are non-negative integers in decimal; occurrence is
//   a non-empty string ('0' for spawn; '<assignmentId>#<step>' for repeated work).
// eventKey = 'ev:' + roomName + ':' + effectTick + ':' + originalArrayIndex
// shortCreepName = prefix + first 12 hex chars of fnv1a64(operationKey); the full
//   key is stored in the binding; a different key with the same name is a
//   NAME_COLLISION (blocking), never reuse of another creep.
// position = { roomName, x, y } plain data, 0 <= x,y <= 49.

const { fnv1a64Hex } = require('./fingerprint');

const ROOM_NAME_PATTERN = /^(?:[WE](?:0|[1-9]\d{0,3})[NS](?:0|[1-9]\d{0,3})|sim)$/;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isRoomName(value) {
    return typeof value === 'string' && ROOM_NAME_PATTERN.test(value);
}

function isNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function escapeSegment(text) {
    return text.replace(/%/g, '%25').replace(/\//g, '%2F');
}

function unescapeSegment(text) {
    if (/%(?!25|2F)/.test(text)) throw new TypeError('Invalid escape in key segment: ' + text);
    return text.replace(/%(25|2F)/g, function (match, code) { return code === '25' ? '%' : '/'; });
}

function requireText(name, value) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(name + ' must be a non-empty string');
    return value;
}

function requireInt(name, value) {
    if (!isNonNegativeInteger(value)) throw new TypeError(name + ' must be a non-negative safe integer');
    return value;
}

function parseIntSegment(name, text) {
    if (!/^(?:0|[1-9]\d*)$/.test(text)) throw new TypeError(name + ' is not a canonical non-negative integer: ' + text);
    const value = Number(text);
    return requireInt(name, value);
}

/**
 * @typedef {Object} OperationKeyParts
 * @property {string} domain room name or global domain ('empire')
 * @property {number} ownerEpoch epoch of origin of the operation (fixed for its life)
 * @property {string} demandStableKey
 * @property {number} generation replacement generation of the demand
 * @property {string} action e.g. 'spawn', 'transfer', 'move'
 * @property {string} occurrence '0' for spawn, '<assignmentId>#<step>' for repeated work
 */

/**
 * @param {OperationKeyParts} parts
 * @returns {string}
 */
function buildOperationKey(parts) {
    if (parts === null || typeof parts !== 'object') throw new TypeError('operation key parts must be an object');
    const occurrence = typeof parts.occurrence === 'number' ? String(requireInt('occurrence', parts.occurrence)) : parts.occurrence;
    return [
        escapeSegment(requireText('domain', parts.domain)),
        String(requireInt('ownerEpoch', parts.ownerEpoch)),
        escapeSegment(requireText('demandStableKey', parts.demandStableKey)),
        String(requireInt('generation', parts.generation)),
        escapeSegment(requireText('action', parts.action)),
        escapeSegment(requireText('occurrence', occurrence)),
    ].join('/');
}

/**
 * @param {string} key
 * @returns {OperationKeyParts}
 * @throws {TypeError} for malformed keys
 */
function parseOperationKey(key) {
    requireText('operationKey', key);
    const segments = key.split('/');
    if (segments.length !== 6) throw new TypeError('operationKey must have 6 segments: ' + key);
    const parts = {
        domain: requireText('domain', unescapeSegment(segments[0])),
        ownerEpoch: parseIntSegment('ownerEpoch', segments[1]),
        demandStableKey: requireText('demandStableKey', unescapeSegment(segments[2])),
        generation: parseIntSegment('generation', segments[3]),
        action: requireText('action', unescapeSegment(segments[4])),
        occurrence: requireText('occurrence', unescapeSegment(segments[5])),
    };
    if (buildOperationKey(parts) !== key) throw new TypeError('operationKey is not canonical: ' + key);
    return parts;
}

/**
 * @param {*} key
 * @returns {boolean}
 */
function isOperationKey(key) {
    try {
        parseOperationKey(key);
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Identity of a raw room event: (roomName, effectTick, originalArrayIndex) of the
 * unfiltered getEventLog() array observed at effectTick + 1.
 * @param {string} roomName
 * @param {number} effectTick
 * @param {number} originalArrayIndex
 * @returns {string}
 */
function eventKey(roomName, effectTick, originalArrayIndex) {
    if (!isRoomName(roomName)) throw new TypeError('eventKey roomName invalid: ' + String(roomName));
    requireInt('effectTick', effectTick);
    requireInt('originalArrayIndex', originalArrayIndex);
    return 'ev:' + roomName + ':' + effectTick + ':' + originalArrayIndex;
}

/**
 * @param {string} key
 * @returns {{roomName:string, effectTick:number, originalArrayIndex:number}}
 */
function parseEventKey(key) {
    requireText('eventKey', key);
    const segments = key.split(':');
    if (segments.length !== 4 || segments[0] !== 'ev') throw new TypeError('eventKey malformed: ' + key);
    const parsed = {
        roomName: segments[1],
        effectTick: parseIntSegment('effectTick', segments[2]),
        originalArrayIndex: parseIntSegment('originalArrayIndex', segments[3]),
    };
    if (!isRoomName(parsed.roomName)) throw new TypeError('eventKey roomName invalid: ' + key);
    return parsed;
}

const NAME_PREFIX_PATTERN = /^[a-z][a-z0-9]{0,3}$/;

/**
 * Deterministic short creep name derived from the full operation key.
 * @param {string} fullKey operationKey (or other full identity key)
 * @param {string} [prefix] 1-4 chars [a-z][a-z0-9]*, default 's'
 * @returns {string} e.g. 's_3fa1c2d4e5b6'
 */
function shortCreepName(fullKey, prefix) {
    requireText('fullKey', fullKey);
    const p = prefix === undefined ? 's' : prefix;
    if (typeof p !== 'string' || !NAME_PREFIX_PATTERN.test(p)) throw new TypeError('shortCreepName prefix invalid: ' + String(p));
    return p + '_' + fnv1a64Hex(fullKey).slice(0, 12);
}

/**
 * @typedef {Object} Position
 * @property {string} roomName
 * @property {number} x 0..49
 * @property {number} y 0..49
 */

function isCoordinate(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 49;
}

/**
 * @param {string} roomName
 * @param {number} x
 * @param {number} y
 * @returns {Position}
 */
function makePosition(roomName, x, y) {
    if (!isRoomName(roomName)) throw new TypeError('position roomName invalid: ' + String(roomName));
    if (!isCoordinate(x) || !isCoordinate(y)) throw new TypeError('position x/y must be integers 0..49');
    return { roomName: roomName, x: x, y: y };
}

/**
 * Plain {roomName,x,y} with exactly these keys and Object/null prototype.
 * @param {*} value
 * @returns {boolean}
 */
function isPosition(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Object.keys(value);
    return keys.length === 3 && isRoomName(value.roomName) && isCoordinate(value.x) && isCoordinate(value.y);
}

/**
 * @param {Position} position
 * @returns {string} 'W1N1:10:20'
 */
function positionKey(position) {
    if (!isPosition(position)) throw new TypeError('positionKey expects a Position');
    return position.roomName + ':' + position.x + ':' + position.y;
}

/**
 * Ledger node id of the aggregate spawn+extension energy pool of a room
 * ('spawnPool:W5N8'). spawnCreep draws from all spawns and extensions of the
 * room, so SPEND reservations for spawning use this node, not an individual
 * structure. The pool is a ledger node only: it is NOT an EnergyNode of the
 * Snapshot (that would count the same energy twice); its observed amount is
 * RoomSnapshot.energyAvailable.
 * @param {string} roomName
 * @returns {string}
 */
function spawnPoolNodeId(roomName) {
    if (!isRoomName(roomName)) throw new TypeError('spawnPoolNodeId roomName invalid: ' + String(roomName));
    return 'spawnPool:' + roomName;
}

/**
 * @param {*} nodeId
 * @returns {string|null} room name for a spawn pool node id, else null
 */
function spawnPoolRoom(nodeId) {
    if (typeof nodeId !== 'string' || nodeId.indexOf('spawnPool:') !== 0) return null;
    const room = nodeId.slice('spawnPool:'.length);
    return isRoomName(room) ? room : null;
}

module.exports = {
    ROOM_NAME_PATTERN,
    spawnPoolNodeId,
    spawnPoolRoom,
    isRoomName,
    isNonNegativeInteger,
    buildOperationKey,
    parseOperationKey,
    isOperationKey,
    eventKey,
    parseEventKey,
    shortCreepName,
    makePosition,
    isPosition,
    positionKey,
};
