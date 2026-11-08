// TickRunner of contract A.2 (ARCHITECTURE §3).
//
// Explicit pipeline: components register into a phase; within a phase they run
// in registration order. Each component runs under WorkBudget (unless exempt)
// and under the FaultBoundary, so one component's exception or deferral only
// affects its own output. Components see earlier outputs of the same tick
// through frame.result(name) and return a Result.
//
// Phase order. The canonical order is PHASES (ARCHITECTURE §3). Stage A uses
// STAGE_A_PHASE_ORDER: BOOT, OBSERVE, CRITICAL, EXECUTE(legacy), then the shadow
// lane RECONCILE, FORECAST, PLAN, ADMIT and CLOSE. No shadow output feeds EXECUTE
// in stage A and the legacy CPU baseline must not depend on shadow work, so the
// only work before legacy is the built-in BOOT/OBSERVE (snapshot capture, so the
// snapshot shows the world before legacy touched Memory/JS objects this tick).
// StrategyApp rejects extra components in phases before EXECUTE.
//
// Components receive `frame.services` (values-only services chosen by the
// composition root: clock, cpu, log, state API) — never GameReadPort,
// MemoryPort or a gateway.

const { Phase, BudgetClass, isEnumValue } = require('../domain/enums');
const { REJECTED } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');

const PHASES = Object.freeze([Phase.BOOT, Phase.OBSERVE, Phase.RECONCILE, Phase.CRITICAL, Phase.FORECAST, Phase.PLAN, Phase.ADMIT, Phase.EXECUTE, Phase.CLOSE]);
const STAGE_A_PHASE_ORDER = Object.freeze([Phase.BOOT, Phase.OBSERVE, Phase.CRITICAL, Phase.EXECUTE, Phase.RECONCILE, Phase.FORECAST, Phase.PLAN, Phase.ADMIT, Phase.CLOSE]);

const COMPONENT_SPEC_KEYS = Object.freeze(['name', 'phase', 'budgetClass', 'estimateCpu', 'bypassCooldown', 'inputFingerprint', 'run']);

function checkPhaseOrder(order) {
    if (!Array.isArray(order) || order.length !== PHASES.length) throw new TypeError('phaseOrder must list every phase once');
    for (let i = 0; i < PHASES.length; i++) {
        if (order.indexOf(PHASES[i]) === -1) throw new TypeError('phaseOrder misses ' + PHASES[i]);
    }
    if (order[0] !== Phase.BOOT || order[1] !== Phase.OBSERVE || order[order.length - 1] !== Phase.CLOSE) {
        throw new TypeError('phaseOrder must start with BOOT, OBSERVE and end with CLOSE');
    }
}

/**
 * @typedef {Object} ComponentSpec
 * @property {string} name unique, stable (FaultBoundary key, report key)
 * @property {string} phase one of Phase
 * @property {string} [budgetClass] 'exempt' | 'critical' | 'optional' (default optional)
 * @property {number} [estimateCpu]
 * @property {boolean} [bypassCooldown] FaultBoundary never skips it (legacy executor, critical observation)
 * @property {function(object): (string|null)} [inputFingerprint] fingerprint of inputs for retry-on-change
 * @property {function(object): object} run returns a Result
 */

/**
 * @param {{faultBoundary: object, workBudget: object, log?: object, phaseOrder?: string[], services?: object}} deps
 *   services: frozen values-only services exposed to components as frame.services
 */
function createTickRunner(deps) {
    const order = deps.phaseOrder || PHASES;
    checkPhaseOrder(order);
    const services = Object.freeze(Object.assign({}, deps.services || {}));
    const components = [];
    const names = {};

    /** @param {ComponentSpec} spec */
    function register(spec) {
        if (!spec || typeof spec.name !== 'string' || spec.name === '') throw new TypeError('component needs a name');
        for (const key in spec) {
            if (COMPONENT_SPEC_KEYS.indexOf(key) === -1) throw new TypeError('component ' + spec.name + ' has unknown key ' + key + ' (dependencies go through closures/frame.services)');
        }
        if (names[spec.name]) throw new TypeError('duplicate component name ' + spec.name);
        if (!isEnumValue(Phase, spec.phase)) throw new TypeError('component ' + spec.name + ' has unknown phase ' + String(spec.phase));
        if (typeof spec.run !== 'function') throw new TypeError('component ' + spec.name + ' needs run(frame)');
        const budgetClass = spec.budgetClass || BudgetClass.OPTIONAL;
        if (!isEnumValue(BudgetClass, budgetClass)) throw new TypeError('component ' + spec.name + ' has unknown budgetClass');
        names[spec.name] = true;
        components.push(Object.freeze({
            name: spec.name,
            phase: spec.phase,
            budgetClass: budgetClass,
            estimateCpu: spec.estimateCpu,
            bypassCooldown: !!spec.bypassCooldown,
            inputFingerprint: spec.inputFingerprint || null,
            run: spec.run,
        }));
    }

    /**
     * Run one tick.
     * @param {{tick:(number|null), tickToken:number}} tickInput
     * @returns {{tick:(number|null), tickToken:number, entries:Array<{component:string, phase:string, kind:string, reason:(string|null)}>, results:Object<string, object>}}
     */
    function runTick(tickInput) {
        const results = {};
        const entries = [];
        if (deps.log && typeof deps.log.beginTick === 'function') deps.log.beginTick();
        for (let p = 0; p < order.length; p++) {
            const phase = order[p];
            const frame = Object.freeze({
                tick: tickInput.tick,
                tickToken: tickInput.tickToken,
                phase: phase,
                services: services,
                result: function (name) { return Object.prototype.hasOwnProperty.call(results, name) ? results[name] : null; },
            });
            for (let c = 0; c < components.length; c++) {
                const component = components[c];
                if (component.phase !== phase) continue;
                let result;
                try {
                    result = runComponent(component, frame);
                } catch (error) {
                    // Only a defect of the runner/budget itself lands here.
                    result = REJECTED(ReasonCode.COMPONENT_FAULT, { component: component.name, errorName: 'RunnerError', message: String(error && error.message).slice(0, 200), tick: tickInput.tick });
                }
                results[component.name] = result;
                entries.push({ component: component.name, phase: phase, kind: result.kind, reason: result.kind === 'REJECTED' ? result.reasonCode : (result.reason || null) });
            }
        }
        return { tick: tickInput.tick, tickToken: tickInput.tickToken, entries: entries, results: results };
    }

    function runComponent(component, frame) {
        if (component.budgetClass !== BudgetClass.EXEMPT) {
            const admission = deps.workBudget.admit({ name: component.name, budgetClass: component.budgetClass, estimateCpu: component.estimateCpu, cursor: null });
            if (admission.kind === 'DEFERRED') return admission;
            if (admission.kind === 'UNKNOWN' && component.budgetClass !== BudgetClass.CRITICAL) return admission;
        }
        let inputFingerprint = null;
        if (component.inputFingerprint) {
            try { inputFingerprint = component.inputFingerprint(frame); } catch (error) { inputFingerprint = null; }
        }
        return deps.faultBoundary.run(component.name, { tick: frame.tick, inputFingerprint: inputFingerprint, bypassCooldown: component.bypassCooldown }, function () {
            return component.run(frame);
        });
    }

    return Object.freeze({
        register: register,
        runTick: runTick,
        phaseOrder: order,
        /** @returns {Array<{name:string, phase:string}>} registered components in execution order */
        plan: function () {
            const list = [];
            for (let p = 0; p < order.length; p++) {
                for (let c = 0; c < components.length; c++) if (components[c].phase === order[p]) list.push({ name: components[c].name, phase: order[p] });
            }
            return list;
        },
    });
}

module.exports = { PHASES, STAGE_A_PHASE_ORDER, COMPONENT_SPEC_KEYS, createTickRunner };
