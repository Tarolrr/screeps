'use strict';

// The bundled backend prints SERVER_PASSWORD verbatim at startup. Viewer
// instances may be reachable beyond loopback, so redact that one upstream log
// line before any launcher child starts. The secret still reaches the backend
// through its environment, but never enters launcher/backend log files.
const originalLog = console.log.bind(console);
console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('Server password is ')) {
        return originalLog('Server password is configured (redacted)');
    }
    return originalLog(...args);
};
