// JSDoc type declarations of contract A.2 (no runtime code).
// Authoritative field lists and invariants: src/bot/domain/dtos.js validators and
// docs/strategy/CONTRACTS-A.md §4. Import types with
//   /** @typedef {import('../domain/types').Snapshot} Snapshot */

/**
 * @typedef {{value:(number|null), quality:('OBSERVED'|'DERIVED'|'ESTIMATED'|'STALE'|'UNKNOWN'), reason:(string|null)}} Measured
 * @typedef {{roomName:string, x:number, y:number}} Position
 * @typedef {{type:string, boost:(string|null), hits:number}} BodyPart
 *
 * @typedef {Object} CreepSnapshot
 * @property {string} name
 * @property {string|null} id
 * @property {string|null} roomName
 * @property {Position|null} pos
 * @property {boolean} spawning
 * @property {BodyPart[]} body
 * @property {Measured} ticksToLive
 * @property {{energy:Measured, capacity:Measured}} store
 * @property {string|null} legacyRole
 * @property {{operationKey:string, homeRoom:string, ownerEpoch:number}|null} strategyEnvelope
 *
 * @typedef {Object} EnergyNode
 * @property {string} nodeId object id | 'creep:<name>' | 'remote:<room>:<sourceId>'
 * @property {'SPAWN_EXTENSION'|'STORAGE_CONTAINER'|'CARGO'|'PILE'|'REMOTE'} nodeClass
 * @property {string} objectType see ENERGY_NODE_OBJECT_TYPES
 * @property {string} roomName
 * @property {Position|null} pos
 * @property {Measured} amount
 * @property {Measured} capacity
 *
 * @typedef {{originalArrayIndex:number, event:number, objectId:(string|null), data:(object|null)}} RawEventEntry
 * @typedef {{effectTick:number, observedAt:number, status:('CAPTURED'|'NOT_VISIBLE'|'UNAVAILABLE'), rawLength:(number|null), rawFingerprint:(string|null), entries:(RawEventEntry[]|null)}} EventLogCapture
 *
 * @typedef {Object} RoomSnapshot
 * @property {string} roomName
 * @property {number} tick
 * @property {'VISIBLE'|'NOT_VISIBLE'} visibility
 * @property {object|null} controller ControllerSnapshot
 * @property {Measured} energyAvailable
 * @property {Measured} energyCapacityAvailable
 * @property {EnergyNode[]} energyNodes sorted by nodeId
 * @property {object[]} spawns SpawnSnapshot[] sorted by id
 * @property {object[]} sources SourceSnapshot[] sorted by id
 * @property {object[]} hostiles HostileSnapshot[] sorted by id
 * @property {object[]} constructionSites ConstructionSiteSnapshot[] sorted by id
 * @property {EventLogCapture} eventLog
 * @property {string[]} missingFields sorted, unique
 *
 * @typedef {Object} Snapshot
 * @property {'Snapshot'} dtoType
 * @property {string} contractVersion 'A.2'
 * @property {number} tick
 * @property {string|null} shard
 * @property {'CRITICAL'|'FULL'} captureStage
 * @property {{used:Measured, limit:Measured, tickLimit:Measured, bucket:Measured}} cpu
 * @property {Object<string, RoomSnapshot>} rooms
 * @property {Object<string, CreepSnapshot>} ownCreeps
 * @property {string[]} missingFields
 * @property {string} fingerprint snapshotFingerprint(snapshot without this field)
 *
 * @typedef {Object} NormalizedEvent
 * @property {string} eventKey eventKey(roomName, effectTick, originalArrayIndex)
 * @property {string} roomName
 * @property {number} effectTick observedAt - 1
 * @property {number} observedAt
 * @property {number} originalArrayIndex index in the unfiltered getEventLog() array
 * @property {string} type NormalizedEventType
 * @property {number} rawEvent raw EVENT_* code
 * @property {string|null} actorId
 * @property {string|null} sourceId energy leaves this object (withdraw reversed)
 * @property {string|null} targetId energy enters this object
 * @property {string|null} resourceType
 * @property {Measured} amount effect/progress of the event (see CONTRACTS-A §4 table)
 * @property {Measured} energyAmount energy moved/consumed by the event
 * @property {string} rawFingerprint fingerprint of the raw room log array
 *
 * @typedef {{kind:'RETURNED'|'THREW', commandId:string, operationKey:string, action:string, actorRef:string, targetRef:(string|null), tick:number, code:(number|null), errorCode:(string|null)}} CallReceipt
 * @typedef {{kind:'CONFIRMED'|'NO_EFFECT'|'UNKNOWN', operationKey:string, commandId:(string|null), evaluatedAt:number, confirmedAmount:(number|null), effect:(object|null), evidence:(object|null), reason:(string|null), eventKeys:string[]}} EffectResult
 *
 * @typedef {Object} Operation
 * @property {string} operationKey
 * @property {'PREPARED'|'ISSUED'|'CONFIRMED'|'NO_EFFECT'|'UNKNOWN'|'UNKNOWN_RETIRED'} state
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number|null} issuedAt
 * @property {string|null} lastCommandId
 * @property {string|null} actorRef
 * @property {string|null} targetRef
 * @property {number|null} requestedAmount
 * @property {number} confirmedAmount
 * @property {string[]} reservationIds
 * @property {CallReceipt|null} lastReceipt
 * @property {EffectResult|null} lastEffect
 * @property {string|null} reasonCode
 *
 * @typedef {Object} Reservation
 * @property {string} reservationId
 * @property {'SPEND'|'MOVE'|'CAPACITY'} kind
 * @property {'RESERVED'|'ISSUED'|'SETTLED'|'PARTIAL'|'RELEASED'|'RETIRED'} state
 * @property {string|null} missionId
 * @property {string|null} operationKey
 * @property {string} roomName
 * @property {string} nodeId
 * @property {string|null} targetNodeId required for MOVE
 * @property {string} resourceType
 * @property {number} amount
 * @property {number} settledAmount
 * @property {number} releasedAmount
 * @property {number} unknownAmount disputed part (outcome unknown)
 * @property {number|null} dueAt
 * @property {number} createdAt
 * @property {number} updatedAt
 *
 * @typedef {Object} Demand
 * @property {string} stableKey
 * @property {number} generation
 * @property {string|null} missionId
 * @property {string} roomName
 * @property {string} capability
 * @property {'energy/tick'|'work/tick'|'coverage'} measurementUnit
 * @property {number} amount
 * @property {Position|null} location
 * @property {number|null} requiredBy
 * @property {number|null} earliestStart
 * @property {'CRITICAL'|'REQUIRED'|'OPTIONAL'} criticality
 * @property {DemandOption[]} options
 * @property {number} createdAt
 *
 * @typedef {Object} Proposal
 * @property {string} proposalId
 * @property {'shadow'|'adaptive-v1'} mode
 * @property {string|null} roomName
 * @property {string|null} missionId
 * @property {number} tick
 * @property {string} inputFingerprint
 * @property {number|null} expectedRevision
 * @property {string} reasonCode
 * @property {Demand[]} demands
 * @property {Array} missionPatches always [] in stage A
 * @property {Array<{kind:string, nodeId:string, targetNodeId:(string|null), resourceType:string, amount:number, dueAt:(number|null)}>} reservationRequests
 * @property {string[]} dependencies
 *
 * @typedef {Object} DecisionRecord
 * @property {string} decisionId
 * @property {number} tick
 * @property {string|null} roomName
 * @property {'legacy'|'shadow'|'adaptive-v1'} mode
 * @property {string} reasonCode
 * @property {string} inputFingerprint
 * @property {object} inputs bounded metrics used for the decision
 * @property {Array<{label:string, proposalId:(string|null), reasonCode:string, accepted:boolean}>} alternatives
 * @property {string|null} selectedProposalId
 * @property {object|null} expectedNextFact
 * @property {'READY'|'DEFERRED'|'UNKNOWN'|'REJECTED'} resultKind
 * @property {boolean} executed always false in shadow
 *
 * @typedef {{requestedMode:string, effectiveOwner:string, epoch:number, transitionPhase:(string|null), transitionId:(string|null), previousOwner:(string|null), blockedReason:(string|null)}} ControlRecord
 *
 * @typedef {Object} StateView
 * @property {'StateView'} dtoType
 * @property {'OPEN'|'READ_ONLY'|'SUSPENDED'} status
 * @property {number} sessionTick
 * @property {string|null} blockedReason
 * @property {Array<{namespace:string, key:string, reasonCode:string}>} quarantine
 * @property {object} strategy Memory.strategy schema1 tree (stateLayout StrategyRoot)
 * @property {object|null} shadow Memory.strategyShadow tree (stateLayout ShadowRoot)
 *
 * @typedef {Object} ReplayFixtureHeader
 * @property {'ReplayFixture'} fixtureType
 * @property {1} fixtureVersion
 * @property {string} contractVersion
 * @property {string} buildId
 * @property {number} schemaVersion
 * @property {string|null} policyVersion
 * @property {number|null} seed
 * @property {number} tickFrom
 * @property {number} tickTo
 * @property {string[]} rooms
 * @property {string} contentFingerprint
 * @property {string[]} expectedReasonCodes
 *
 * @typedef {{kind:'READY', value:*, inputFingerprint:string}} ReadyResult
 * @typedef {{kind:'DEFERRED', cursor:*, reason:string}} DeferredResult
 * @typedef {{kind:'UNKNOWN', reason:string, missingFields:string[]}} UnknownResult
 * @typedef {{kind:'REJECTED', reasonCode:string, evidence:(object|null)}} RejectedResult
 * @typedef {ReadyResult|DeferredResult|UnknownResult|RejectedResult} Result
 *
 * --- A.2 cross-worker DTOs (validators in dtos.js / stateLayout.js) ---
 * @typedef {{body:string[], cost:number, spawnTime:number, provides:number, travelTime:Measured}} DemandOption
 * @typedef {{roomName:string, processedThroughTick:number, lastObservedAt:number, lastRawFingerprint:(string|null)}} EventCursor
 * @typedef {{roomName:string, fromTick:number, toTick:number, reasonCode:string}} EventGap
 * @typedef {{harvest:Measured, externalIn:Measured, externalOut:Measured, spawnSpend:Measured, build:Measured, repair:Measured, upgrade:Measured, decayLoss:Measured, internalTransfer:Measured, unexplained:Measured}} Flows
 * @typedef {{roomName:string, fromTick:number, toTick:number, flows:Flows, quality:string, reasonCodes:string[]}} FlowDelta
 * @typedef {{roomName:string, windowStart:number, windowEnd:number, ticksCovered:number, complete:boolean, topologyVersion:(string|null), flows:Flows, quality:string, reasonCodes:string[]}} FlowWindow
 * @typedef {{homeRoom:string, ownerEpoch:number, originEpoch:number, legacyOrderId:(string|null), operationKey:(string|null), demandKey:(string|null), generation:(number|null), assignmentId:(string|null), observedLifeState:string}} Binding
 * @typedef {{homeRoom:(string|null), homeSource:string, homeQuality:string, legacyRole:(string|null), legacyOrderId:(string|null), body:string[], bodyCost:number, firstSeen:number, lastSeen:number, lifeState:string}} ObservedBinding
 * @typedef {{observationKey:string, kind:string, roomName:string, actorRef:(string|null), targetRef:(string|null), firstSeen:number, lastSeen:number, effect:string, amount:Measured, energyAmount:Measured, eventKeys:string[]}} ObservedOperation
 * @typedef {{tick:number, roomName:string, kind:('INCOME'|'PAYMENT'|'DEADLINE'), amount:Measured, stableKey:string, reasonCode:(string|null)}} CalendarEntry
 * @typedef {{roomName:string, fromTick:number, horizon:number, entries:CalendarEntry[], quality:string, reasonCodes:string[]}} Calendar
 * @typedef {{nodeId:string, observed:Measured, reserved:number, disputed:number, free:Measured}} LedgerNodeView
 * @typedef {{roomName:string, tick:number, nodes:LedgerNodeView[]}} LedgerView
 * @typedef {{stableKey:string, roomName:string, currentCreepName:(string|null), ticksToLive:Measured, body:string[], bodyCost:number, spawnTime:number, travelTime:Measured, startBy:(number|null), deadline:(number|null), criticality:string, reasonCode:(string|null), quality:string}} ReplacementPlanEntry
 * @typedef {{roomName:string, tick:number, horizon:number, entries:ReplacementPlanEntry[]}} ReplacementPlan
 * @typedef {{roomName:string, computedAt:number, horizon:number, freeEnergyNow:Measured, incomeLowerPerTick:Measured, committedPayments:Measured, nextDeficitTick:(number|null), calendarFingerprint:(string|null), quality:string, reasonCodes:string[]}} ForecastSummary
 * @typedef {{patchId:string, writer:('state'|'observation'|'finance'|'planning'), namespace:('strategy'|'strategyShadow'), path:string[], op:('set'|'delete'), value:(*|undefined)}} StatePatch
 * @typedef {{tick:number, patches:StatePatch[], gaps:EventGap[], domainStatus:Object<string,('OK'|'UNCERTAIN_FUNDING')>, reasonCodes:string[]}} ReconciliationPatch
 * @typedef {{snapshots:Snapshot[], state:{revision:number, control:{rooms:Object<string,ControlRecord>}, shadowRooms:Object<string,{eventCursor:(EventCursor|null), flowWindows:FlowWindow[]}>}, events:NormalizedEvent[], expectedReasonCodes:string[], expectedForecast:Object<string,ForecastSummary>}} ReplayFixtureBody
 * @typedef {{header:ReplayFixtureHeader, body:ReplayFixtureBody}} ReplayFixture
 */

module.exports = {};
