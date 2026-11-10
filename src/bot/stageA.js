// Stage-A wiring (part of the composition root; A5 owns its later edits).
//
// The only place where raw ports are handed out:
//   - ports.gameRead -> the Reader only, wrapped into `observe(frame, budget)` (A1);
//   - ports.memory.* -> the StateStore only (A2), exposed onwards as `openState`,
//     `stateApi` (no MemoryPort inside) and `faultStore`.
// Components returned by `components` must not capture gameRead/memory: they get
// values through frame.result(...) and frame.services ({clock, cpu, log, state}).
// Top level: declarations only.
//
// State access (A2, docs/strategy/STATE-A.md):
//   - frame.services.state = store.readOnlyApi(): {view, apply} where apply always
//     refuses; no component can write through the shared services object;
//   - each writing shadow component calls ONLY its own writer-bound handle (A5;
//     createShadowComponents keeps no dispatcher over several writers):
//         observation -> reconcile.shadow (A3 Reconciler)
//         finance     -> forecast.shadow  (A4 ForecastSummary)
//         planning    -> close.shadow (DecisionRecorder ring, proposals, replay export;
//                        plan/admit only read through it)
//     expectedRevision = revision of the view the component read at its start; after an
//     accepted batch the returned revision is the next expected one (no blind re-read).
//     store.api() itself (and writer 'state') never reaches a component; the CLOSE
//     step gets `closeTick(t) = store.close(t)` (lastClosedTick, internal meta write);
//   - faultStore persists FaultStatus in Memory.strategy.faults (heap fallback when
//     the store is suspended/frozen).
//
// Shadow scope (STRAT-A5, docs/strategy/SHADOW-A.md): only rooms whose router decision
// is SHADOW (operator: Memory.strategy.control.rooms[room].requestedMode = 'shadow').
// Default is legacy with NO shadow work: OBSERVE captures only shadow rooms and returns
// REJECTED(NOT_REQUESTED) when there are none (no snapshot CPU before legacy).

const { createStateStore } = require('./state/StateStore');
const { createReader } = require('./observation/ScreepsReader');
const { createShadowComponents, shadowRoomsOf } = require('./integration/ShadowAdapter');
const { REJECTED } = require('./domain/results');
const { ReasonCode } = require('./domain/reasonCodes');

/**
 * @param {ReturnType<typeof import('./app/ports').createRuntimePorts>} ports
 * @param {{buildId:string, contractVersion:string, schemaVersion:number}} buildInfo
 * @returns {{observe: (function(object, object): object)|null, openState: (function(object): (object|null))|null,
 *            stateApi: (object|null), faultStore: (object|null), components: Array<object>}}
 */
function wireStageA(ports, buildInfo) {
    const reader = createReader({ gameRead: ports.gameRead, cpu: ports.cpu });
    const store = createStateStore({ memory: ports.memory, buildInfo: buildInfo, log: ports.log, clock: ports.clock });
    const stateRoot = store.api();
    const components = createShadowComponents({
        state: {
            observation: stateRoot.forWriter('observation'),
            finance: stateRoot.forWriter('finance'),
            planning: stateRoot.forWriter('planning'),
        },
        closeTick: function (tick) { return store.close(tick); },
        buildInfo: buildInfo,
        log: ports.log,
    });
    return {
        observe: function (frame, budget) {
            const rooms = shadowRoomsOf(frame.result('boot.router'));
            if (rooms.length === 0) return REJECTED(ReasonCode.NOT_REQUESTED, { shadowRooms: 0 });
            return reader.capture(frame.tick, { rooms: rooms, stage: 'FULL' }, budget);
        },
        openState: function (frame) { return store.open(frame.tick); },
        stateApi: store.readOnlyApi(),
        faultStore: store.faultStore(),
        components: components,
    };
}

module.exports = { wireStageA };
