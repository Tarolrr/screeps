class PriorityCalculator {
    static calculatePriorityFromId(id, offset = 0) {
        const priorityBase = parseInt(id.substring(id.length - 6), 16);
        return Math.floor(priorityBase * PriorityCalculator.HARVESTER_PRIORITY_MULTIPLIER) - offset;
    }
}

PriorityCalculator.HARVESTER_PRIORITY_MULTIPLIER = 100;

module.exports = PriorityCalculator;
