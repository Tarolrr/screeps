// Stage-A wiring (part of the composition root; A5 owns its later edits).
//
// The only place where raw ports are handed out:
//   - ports.gameRead -> the Reader only, wrapped into `observe(frame, budget)` (A1);
//   - ports.memory.* -> the StateStore only (A2), exposed onwards as `openState`,
//     `stateApi` (no MemoryPort inside) and `faultStore`.
// Components returned by `components` must not capture gameRead/memory: they get
// values through frame.result(...) and frame.services ({clock, cpu, log, state}).
// Top level: declarations only.

const { createReader } = require('./observation/ScreepsReader');

/**
 * @param {ReturnType<typeof import('./app/ports').createRuntimePorts>} ports
 * @param {{buildId:string, contractVersion:string, schemaVersion:number}} buildInfo
 * @returns {{observe: (function(object, object): object)|null, openState: (function(object): (object|null))|null,
 *            stateApi: (object|null), faultStore: (object|null), components: Array<object>}}
 */
function wireStageA(ports, buildInfo) {
    void buildInfo;
    const reader = createReader({ gameRead: ports.gameRead, cpu: ports.cpu });
    // A0: nothing wired yet. A5 replaces this body, e.g.
    //   const reader = createReader({ gameRead: ports.gameRead, cpu: ports.cpu });
    //   const store = createStateStore({ memory: ports.memory, buildInfo, log: ports.log });
    //   return { observe: (frame, budget) => reader.capture(frame.tick, {rooms: 'ALL_VISIBLE', stage: 'FULL'}, budget),
    //            openState: (frame) => store.open(frame.tick), stateApi: store.api(), faultStore: store.faultStore(),
    //            components: createShadowComponents({ models, recorder }) };
    return { observe: function (frame, budget) { return reader.capture(frame.tick, { rooms: 'ALL_VISIBLE', stage: 'FULL' }, budget); }, openState: null, stateApi: null, faultStore: null, components: [] };
}

module.exports = { wireStageA };
