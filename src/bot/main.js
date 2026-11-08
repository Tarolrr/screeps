// Composition root of the Screeps strategy bundle (loaded as Screeps module `main`).
//
// Top level contains declarations only: requiring this module (or the bundle)
// reads no Game/Memory, creates no orders and evaluates no dist2 module. All
// wiring happens on the first loop() after a global reset; `app` lives in heap
// and is rebuilt after every reset (correctness does not depend on heap).
//
// Stage-A extension points (write scopes in docs/strategy/CONTRACTS-A.md §10):
// ./stageA.js wireStageA(ports, buildInfo) hands gameRead to the Reader (A1) and
// MemoryPorts to the StateStore (A2) only; shadow components (A3-A5) get
// frame.services = {clock, cpu, log, state} and never a raw port or gateway.

const { createRuntimePorts } = require('./app/ports');
const { createStrategyApp } = require('./app/StrategyApp');
const { createLegacyAdapter } = require('./integration/LegacyAdapter');
const { wireStageA } = require('./stageA');
const { CONTRACT_VERSION, SCHEMA_VERSION } = require('./domain/version');

/* global __STRATEGY_BUILD_ID__ */
const BUILD_ID = typeof __STRATEGY_BUILD_ID__ === 'string' ? __STRATEGY_BUILD_ID__ : 'unbundled';
/** createApp failures are logged on the first failure and then once per this many loops. */
const APP_FAULT_LOG_EVERY = 100;

/** @type {ReturnType<typeof createStrategyApp>|null} */
let app = null;
/** @type {ReturnType<typeof createLegacyAdapter>|null} one adapter per global: legacy init happens once */
let legacy = null;
/** Loop counter of this global; the legacy adapter runs at most once per value. */
let loopCount = 0;
let appFaults = 0;

function createApp(legacyAdapter) {
    const ports = createRuntimePorts();
    const buildInfo = { buildId: BUILD_ID, contractVersion: CONTRACT_VERSION, schemaVersion: SCHEMA_VERSION };
    const wiring = wireStageA(ports, buildInfo);
    return createStrategyApp({
        ports: { clock: ports.clock, cpu: ports.cpu, log: ports.log },
        legacy: legacyAdapter,
        listRoomNames: function () { return ports.gameRead.roomNames(); },
        openState: wiring.openState,
        stateApi: wiring.stateApi,
        observe: wiring.observe,
        faultStore: wiring.faultStore,
        components: wiring.components,
        buildInfo: buildInfo,
    });
}

function loop() {
    loopCount += 1;
    if (legacy === null) legacy = createLegacyAdapter();
    if (app === null) {
        try {
            app = createApp(legacy);
        } catch (error) {
            // Wiring defect of the new system must not stop the pre-existing executor.
            if (appFaults % APP_FAULT_LOG_EVERY === 0 && typeof console !== 'undefined') {
                console.log('[strategy] ERROR APP_CREATE_FAULT (failures=' + (appFaults + 1) + ') ' + String(error && error.stack ? error.stack : error).slice(0, 1000));
            }
            appFaults += 1;
        }
    }
    if (app !== null) {
        app.tick(loopCount);
        return;
    }
    legacy.runTick(loopCount);
}

module.exports.loop = loop;
