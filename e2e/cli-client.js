// Minimal client for the Screeps admin CLI socket (TCP, localhost only).
// The sandbox exposes: storage (db/env/pubsub), map, bots, strongholds, system, print.
// We funnel structured data out via print(marker + JSON.stringify(x) + marker).
const net = require('net');

class ScreepsCLI {
    constructor(host = '::1', port = 21026) {
        this.host = host;
        this.port = port;
        this.buf = '';
        this.queue = Promise.resolve();
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.socket = net.connect(this.port, this.host);
            this.socket.setEncoding('utf8');
            this.socket.on('data', d => { this.buf += d; });
            this.socket.on('error', reject);
            const timeout = setTimeout(() => { clearInterval(wait); reject(new Error('CLI greeting timeout')); }, 10000);
            const wait = setInterval(() => {
                if (this.buf.includes('< ')) {
                    clearInterval(wait);
                    clearTimeout(timeout);
                    resolve();
                }
            }, 50);
        });
    }

    // Evaluate a JS expression in the server sandbox. Resolves with the
    // expression's value (promises are awaited server-side).
    eval(expr, timeoutMs = 60000) {
        const run = () => new Promise((resolve, reject) => {
            const marker = '@@' + Date.now() + '@@';
            // The CLI evaluates input line-by-line, so the expression is sent as
            // a JSON-encoded string and eval'd server-side (keeps newlines safe).
            // The payload is URI-encoded because sandbox print() runs
            // util.inspect on its arg (escapes quotes/backslashes).
            const wrapped =
                `Promise.resolve().then(()=>eval(${JSON.stringify(expr)})).then(` +
                `r=>print(${JSON.stringify(marker)}+encodeURIComponent(JSON.stringify(r===undefined?null:r))+${JSON.stringify(marker)}),` +
                `e=>print(${JSON.stringify(marker + 'ERR')} + encodeURIComponent(String(e && e.stack || e)) + ${JSON.stringify(marker)}))`;
            const started = Date.now();
            const check = setInterval(() => {
                let i = this.buf.indexOf(marker + 'ERR');
                if (i !== -1) {
                    const j = this.buf.indexOf(marker, i + 1);
                    if (j !== -1) {
                        clearInterval(check);
                        const payload = this.buf.slice(i + marker.length + 3, j);
                        this.buf = this.buf.slice(j + marker.length);
                        reject(new Error(decodeURIComponent(payload).slice(0, 1500)));
                        return;
                    }
                }
                i = this.buf.indexOf(marker);
                if (i !== -1) {
                    const j = this.buf.indexOf(marker, i + marker.length);
                    if (j !== -1) {
                        clearInterval(check);
                        const payload = this.buf.slice(i + marker.length, j);
                        this.buf = this.buf.slice(j + marker.length);
                        try { resolve(JSON.parse(decodeURIComponent(payload))); }
                        catch (e) { reject(new Error('bad payload: ' + payload.slice(0, 500))); }
                        return;
                    }
                }
                if (Date.now() - started > timeoutMs) {
                    clearInterval(check);
                    reject(new Error('eval timeout: ' + expr.slice(0, 120) +
                        ' | buf tail: ' + this.buf.slice(-300)));
                }
            }, 30);
            this.socket.write(wrapped + '\r\n');
        });
        // serialize commands — one in flight at a time
        const p = this.queue.then(run);
        this.queue = p.catch(() => {});
        return p;
    }

    close() { try { this.socket.end(); } catch (e) {} }
}

module.exports = { ScreepsCLI };
