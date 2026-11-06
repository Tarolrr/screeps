// Test 7 (user repo, WIP): runs dist2/ — the unfinished rearch — to see
// whether it even boots on a live server. Same criteria as test 6.
const { runStrategyCase } = require('./user-strategy-runner');

runStrategyCase('dist2').then(r => process.exit(r.ok ? 0 : 1))
    .catch(e => { console.error(e); process.exit(1); });
