// Test 6 (user repo): runs the user's real strategy from Tarolrr/screeps dist/
// ("last working solution") as a test user's modules on the live server.
// Criteria: >=1 creep spawned by the strategy, zero script error notifications.
const { runStrategyCase } = require('./user-strategy-runner');

runStrategyCase('dist').then(r => process.exit(r.ok ? 0 : 1))
    .catch(e => { console.error(e); process.exit(1); });
