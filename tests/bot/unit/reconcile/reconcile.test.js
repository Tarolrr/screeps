// A3 reconciliation tests (native prototypes).
const { defineEventTests, defineFlowTests } = require('./events.suite');
const { defineMatcherTests } = require('./matcher.suite');
const { defineReconcilerTests } = require('./reconciler.suite');

defineEventTests('native');
defineFlowTests('native');
defineMatcherTests('native');
defineReconcilerTests('native');
