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
//   - each writing component receives ONLY its writer-bound handle, captured in its
//     closure here, e.g. (A5):
//         const stateRoot = store.api();
//         const observationState = stateRoot.forWriter('observation');   // A3 reconcile
//         const financeState = stateRoot.forWriter('finance');           // A4 forecast/admit
//         const planningState = stateRoot.forWriter('planning');         // A5 recorder
//     store.api() itself (and writer 'state') never reaches a component;
//   - faultStore persists FaultStatus in Memory.strategy.faults (heap fallback when
//     the store is suspended/frozen).

const { createStateStore } = require('./state/StateStore');

const { createReader } = require('./observation/ScreepsReader');

/**
 * @param {ReturnType<typeof import('./app/ports').createRuntimePorts>} ports
 * @param {{buildId:string, contractVersion:string, schemaVersion:number}} buildInfo
 * @returns {{observe: (function(object, object): object)|null, openState: (function(object): (object|null))|null,
 *            stateApi: (object|null), faultStore: (object|null), components: Array<object>}}
 */
function wireStageA(ports, buildInfo) {
    const reader = createReader({ gameRead: ports.gameRead, cpu: ports.cpu });
    const store = createStateStore({ memory: ports.memory, buildInfo: buildInfo, log: ports.log, clock: ports.clock });
    // A3-A5 components still to be wired (A5):
    //   components: createShadowComponents({ models, recorder, state: {observation, finance, planning} handles above })
    return {
        observe: function (frame, budget) { return reader.capture(frame.tick, { rooms: 'ALL_VISIBLE', stage: 'FULL' }, budget); },
        openState: function (frame) { return store.open(frame.tick); },
        stateApi: store.readOnlyApi(),
        faultStore: store.faultStore(),
        components: [],
    };
}

module.exports = { wireStageA };
