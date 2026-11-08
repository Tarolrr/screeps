// OwnershipRouter of contract A.2 (ARCHITECTURE §2, INTEGRATION "Владение").
//
// Input: the StateStore open result (or null when no StateStore is wired, as in
// A0) and the room names to route. Output: a JSON-safe RoutingTable.
//
// Per room:
//   no control record (or no StateStore)    -> owner legacy, new system OFF
//   requestedMode 'legacy'                   -> owner legacy, new system OFF
//   requestedMode 'shadow'                   -> owner legacy, new system SHADOW
//   requestedMode 'adaptive-v1'              -> owner legacy, new system OFF,
//                                               status REJECTED(UNSUPPORTED_CAPABILITY)
//   record blockedReason set                 -> owner as recorded, new system SUSPENDED
//   invalid record / record claims adaptive  -> owner 'unconfirmed', new system SUSPENDED
//   state not READY / StateView SUSPENDED    -> every room: owner 'unconfirmed', SUSPENDED
//   control key that is not a room name      -> quarantined (RoutingTable.quarantine), not routed
//
// Stage-A nuance: dist2 is a single global executor that existed before this
// router. The router NEVER turns an unknown/incompatible schema into a decision
// to (re)enable legacy: for such rooms it reports effectiveOwner 'unconfirmed'.
// The composition root keeps running legacy because it is the pre-existing
// executor (legacyExecution: 'PRE_EXISTING_EXECUTOR'), not because of routing.
// Fenced per-room legacy gating is a stage-B task.

const { READY, REJECTED, isResult } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { RoomMode, EffectiveOwner, NewSystemStatus, StateStatus } = require('../domain/enums');
const { validateControlRecord } = require('../domain/dtos');
const { fingerprint } = require('../domain/fingerprint');
const { isRoomName } = require('../domain/keys');

const LEGACY_EXECUTION = 'PRE_EXISTING_EXECUTOR';

function route(roomName, requestedMode, owner, newSystem, epoch, status) {
    return {
        roomName: roomName,
        requestedMode: requestedMode,
        effectiveOwner: owner,
        newSystem: newSystem,
        epoch: epoch,
        token: owner === EffectiveOwner.UNCONFIRMED || epoch === null ? null : { room: roomName, owner: owner, epoch: epoch },
        status: status,
    };
}

function okStatus(roomName, requestedMode, epoch) {
    return READY({ roomName: roomName, requestedMode: requestedMode }, fingerprint({ roomName: roomName, requestedMode: requestedMode, epoch: epoch }));
}

function routeRoom(roomName, record) {
    if (record === undefined) {
        return route(roomName, RoomMode.LEGACY, EffectiveOwner.LEGACY, NewSystemStatus.OFF, 0, okStatus(roomName, RoomMode.LEGACY, 0));
    }
    const check = validateControlRecord(record);
    if (!check.ok) {
        return route(roomName, null, EffectiveOwner.UNCONFIRMED, NewSystemStatus.SUSPENDED, null,
            REJECTED(ReasonCode.INVALID_RECORD, { roomName: roomName, errors: check.errors.slice(0, 5) }));
    }
    if (record.effectiveOwner !== EffectiveOwner.LEGACY) {
        // A record claiming adaptive (or unconfirmed) ownership cannot be honoured by a stage-A build.
        return route(roomName, record.requestedMode, EffectiveOwner.UNCONFIRMED, NewSystemStatus.SUSPENDED, null,
            REJECTED(ReasonCode.UNSUPPORTED_CAPABILITY, { roomName: roomName, recordedOwner: record.effectiveOwner }));
    }
    if (record.blockedReason !== null) {
        return route(roomName, record.requestedMode, EffectiveOwner.LEGACY, NewSystemStatus.SUSPENDED, record.epoch,
            REJECTED(record.blockedReason, { roomName: roomName, blockedReason: record.blockedReason }));
    }
    switch (record.requestedMode) {
        case RoomMode.SHADOW:
            return route(roomName, RoomMode.SHADOW, EffectiveOwner.LEGACY, NewSystemStatus.SHADOW, record.epoch, okStatus(roomName, RoomMode.SHADOW, record.epoch));
        case RoomMode.ADAPTIVE_V1:
            return route(roomName, RoomMode.ADAPTIVE_V1, EffectiveOwner.LEGACY, NewSystemStatus.OFF, record.epoch,
                REJECTED(ReasonCode.UNSUPPORTED_CAPABILITY, { roomName: roomName, requestedMode: RoomMode.ADAPTIVE_V1 }));
        default:
            return route(roomName, RoomMode.LEGACY, EffectiveOwner.LEGACY, NewSystemStatus.OFF, record.epoch, okStatus(roomName, RoomMode.LEGACY, record.epoch));
    }
}

/**
 * @typedef {Object} RoomRoute
 * @property {string} roomName
 * @property {string|null} requestedMode
 * @property {'legacy'|'adaptive-v1'|'unconfirmed'} effectiveOwner
 * @property {'OFF'|'SHADOW'|'SUSPENDED'} newSystem
 * @property {number|null} epoch
 * @property {{room:string, owner:string, epoch:number}|null} token
 * @property {object} status Result: READY or REJECTED(reason)
 *
 * @typedef {Object} RoutingTable
 * @property {'PRE_EXISTING_EXECUTOR'} legacyExecution
 * @property {'NO_STATE_STORE'|'OPEN'|'SUSPENDED'} stateSource
 * @property {Object<string, RoomRoute>} rooms
 * @property {Array<{namespace:string, key:string, reasonCode:string}>} quarantine invalid control entries (not routed)
 */

/**
 * @param {{state: (object|null), roomNames: string[]}} input
 *   state: null (no StateStore wired) or the Result of StateStore.open
 *   (READY(StateView) | REJECTED | UNKNOWN | DEFERRED)
 * @returns {RoutingTable}
 */
function routeRooms(input) {
    const state = input.state === undefined ? null : input.state;
    const names = [];
    const addName = function (name) { if (isRoomName(name) && names.indexOf(name) === -1) names.push(name); };
    (input.roomNames || []).forEach(addName);

    let suspendedBy = null;
    let controlRooms = {};
    const quarantine = [];
    let stateSource = 'NO_STATE_STORE';
    if (state !== null) {
        if (!isResult(state)) {
            suspendedBy = REJECTED(ReasonCode.INVALID_RECORD, { what: 'state open result' });
        } else if (state.kind !== 'READY') {
            const reason = state.kind === 'REJECTED' ? state.reasonCode : state.reason;
            suspendedBy = REJECTED(reason, { stateResult: state.kind });
        } else if (!state.value || state.value.status === StateStatus.SUSPENDED) {
            suspendedBy = REJECTED(state.value && state.value.blockedReason ? state.value.blockedReason : ReasonCode.INCOMPATIBLE_SCHEMA, { stateStatus: StateStatus.SUSPENDED });
        } else {
            stateSource = 'OPEN';
            const strategy = state.value.strategy;
            controlRooms = strategy && strategy.control && strategy.control.rooms ? strategy.control.rooms : {};
            Object.keys(controlRooms).forEach(function (key) {
                if (isRoomName(key)) addName(key);
                else quarantine.push({ namespace: 'strategy', key: 'control.rooms.' + key, reasonCode: ReasonCode.INVALID_RECORD });
            });
        }
        if (suspendedBy !== null) stateSource = 'SUSPENDED';
    }
    names.sort();

    const rooms = {};
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (suspendedBy !== null) {
            rooms[name] = route(name, null, EffectiveOwner.UNCONFIRMED, NewSystemStatus.SUSPENDED, null, suspendedBy);
        } else {
            rooms[name] = routeRoom(name, Object.prototype.hasOwnProperty.call(controlRooms, name) ? controlRooms[name] : undefined);
            if (rooms[name].status.kind === 'REJECTED' && rooms[name].status.reasonCode === ReasonCode.INVALID_RECORD) {
                quarantine.push({ namespace: 'strategy', key: 'control.rooms.' + name, reasonCode: ReasonCode.INVALID_RECORD });
            }
        }
    }
    quarantine.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    return { legacyExecution: LEGACY_EXECUTION, stateSource: stateSource, rooms: rooms, quarantine: quarantine };
}

module.exports = { LEGACY_EXECUTION, routeRooms };
