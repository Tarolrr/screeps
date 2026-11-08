// WorkBudget of contract A.2 (ARCHITECTURE §3).
//
// Checked before every block. Reads Game.cpu through the CpuPort at each call
// (getUsed changes during the tick). Missing CPU fields are UNKNOWN, never 0.
//
//   admit({name, budgetClass, estimateCpu, cursor}) ->
//     READY({name, used, ceiling, remaining}, fp)    the block may run
//     DEFERRED(cursor, BUDGET_DEFERRED)               not enough CPU; resume later
//     UNKNOWN(MISSING_FIELD, ['cpu.used', ...])       CPU not measurable
//
// Classes:
//   exempt   - never consulted (legacy executor keeps its pre-existing behaviour);
//   critical - allowed while used + estimate <= tickLimit - hardMarginCpu;
//              when CPU is unknown critical work is still allowed (caller sees UNKNOWN
//              and decides; TickRunner runs critical blocks on UNKNOWN);
//   optional - (all shadow work in stage A) never bursts into the bucket:
//              DEFERRED while bucket < minShadowBucket;
//              allowed while used + estimate <= min(limit, tickLimit) - hardMarginCpu - criticalReserveCpu;
//              never on UNKNOWN.
// createScopedBudget(base, cpuPort, ceilingCpu) additionally caps the CPU spent
// since the scope was opened (stage A: the OBSERVE snapshot gets observeCeilingCpu).
// Thresholds are initial settings, not an optimum (DESIGN §12).

const { READY, DEFERRED, UNKNOWN } = require('../domain/results');
const { ReasonCode } = require('../domain/reasonCodes');
const { BudgetClass } = require('../domain/enums');
const { fingerprint } = require('../domain/fingerprint');

const DEFAULT_BUDGET_SETTINGS = Object.freeze({
    hardMarginCpu: 2,
    criticalReserveCpu: 5,
    minShadowBucket: 1000,
    observeCeilingCpu: 3,
    defaultEstimateCpu: 0.5,
});

/**
 * @param {{read: function(): import('./ports').CpuReading}} cpuPort
 * @param {Partial<typeof DEFAULT_BUDGET_SETTINGS>} [settings]
 */
function createWorkBudget(cpuPort, settings) {
    const cfg = Object.assign({}, DEFAULT_BUDGET_SETTINGS, settings || {});

    /**
     * @param {{name:string, budgetClass:string, estimateCpu?:number, cursor?:*}} block
     */
    function admit(block) {
        const budgetClass = block.budgetClass || BudgetClass.OPTIONAL;
        const estimate = typeof block.estimateCpu === 'number' && isFinite(block.estimateCpu) && block.estimateCpu >= 0 ? block.estimateCpu : cfg.defaultEstimateCpu;
        const cursor = block.cursor === undefined ? null : block.cursor;
        const cpu = cpuPort.read();

        if (budgetClass === BudgetClass.EXEMPT) {
            return READY({ name: block.name, budgetClass: budgetClass, used: cpu.used, ceiling: null, remaining: null }, fingerprint({ name: block.name, budgetClass: budgetClass }));
        }

        let ceiling;
        let needed;
        let missing;
        if (budgetClass === BudgetClass.CRITICAL) {
            missing = cpu.missingFields.filter(function (f) { return f === 'cpu.used' || f === 'cpu.tickLimit'; });
            if (missing.length > 0) return UNKNOWN(ReasonCode.MISSING_FIELD, missing);
            ceiling = cpu.tickLimit - cfg.hardMarginCpu;
            needed = cpu.used + estimate;
        } else {
            missing = cpu.missingFields.slice();
            if (missing.length > 0) return UNKNOWN(ReasonCode.MISSING_FIELD, missing);
            if (cpu.bucket < cfg.minShadowBucket) return DEFERRED(cursor, ReasonCode.BUDGET_DEFERRED);
            ceiling = Math.min(cpu.limit, cpu.tickLimit) - cfg.hardMarginCpu - cfg.criticalReserveCpu;
            needed = cpu.used + estimate;
        }
        if (needed > ceiling) return DEFERRED(cursor, ReasonCode.BUDGET_DEFERRED);
        return READY(
            { name: block.name, budgetClass: budgetClass, used: cpu.used, ceiling: ceiling, remaining: ceiling - cpu.used },
            fingerprint({ name: block.name, budgetClass: budgetClass, ceiling: ceiling }));
    }

    return Object.freeze({ admit: admit, settings: Object.freeze(cfg) });
}

/**
 * Budget view with an extra ceiling on CPU spent inside the scope.
 * @param {{admit: function(object): object}} base WorkBudget
 * @param {{read: function(): import('./ports').CpuReading}} cpuPort
 * @param {number} ceilingCpu max CPU used between scope creation and a block's end
 */
function createScopedBudget(base, cpuPort, ceilingCpu) {
    const start = cpuPort.read().used;
    return Object.freeze({
        ceilingCpu: ceilingCpu,
        admit: function (block) {
            const result = base.admit(block);
            if (result.kind !== 'READY' || start === null) return result;
            const used = cpuPort.read().used;
            const estimate = typeof block.estimateCpu === 'number' && block.estimateCpu >= 0 ? block.estimateCpu : 0;
            if (used === null) return UNKNOWN(ReasonCode.MISSING_FIELD, ['cpu.used']);
            if (used - start + estimate > ceilingCpu) return DEFERRED(block.cursor === undefined ? null : block.cursor, ReasonCode.BUDGET_DEFERRED);
            return result;
        },
    });
}

module.exports = { DEFAULT_BUDGET_SETTINGS, createWorkBudget, createScopedBudget };
