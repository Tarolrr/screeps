'use strict';
// Control-only mod for the isolated cron experiment. It keeps every stock
// cronjob entry but wraps each function so a rejection or synchronous throw is
// logged as 'CRONJOB-FAIL <name> <error>' instead of crashing the backend with
// an unhandled rejection. This preserves firing order/timing and lets the
// surviving jobs produce observable writes; failures become named evidence,
// not hidden passes. Test use only — it must never run on a shared server.
module.exports = function install(config) {
  if (!config.backend || !config.cronjobs) return;
  for (const name of Object.keys(config.cronjobs)) {
    const entry = config.cronjobs[name];
    if (!Array.isArray(entry) || typeof entry[1] !== 'function') continue;
    const orig = entry[1];
    entry[1] = function (...args) {
      try {
        const out = orig.apply(this, args);
        if (out && typeof out.catch === 'function') {
          return out.catch(e => { console.error(`CRONJOB-FAIL ${name} ${e && e.message || e}`); });
        }
        return out;
      } catch (e) {
        console.error(`CRONJOB-FAIL ${name} ${e && e.message || e}`);
      }
    };
  }
};
