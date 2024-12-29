class Logger {
    constructor() {
        this.severityLevels = {
            'trace': 0,
            'debug': 1,
            'info': 2,
            'warn': 3,
            'error': 4
        };
        this.currentLevel = 'trace'; // Default severity level
        this.save();
    }

    load() {
        if (Memory.loggerState) {
            this.currentLevel = Memory.loggerState.currentLevel;
        }
    }

    save() {
        if (!Memory.loggerState) {
            Memory.loggerState = {
                currentLevel: this.currentLevel
            };
        }
    }

    setLevel(level) {
        if (this.severityLevels[level] !== undefined) {
            this.currentLevel = level;
        } else {
            console.log("Invalid log level");
        }
    }

    trace(message) {
        this.log('trace', message);
    }

    debug(message) {
        this.log('debug', message);
    }

    info(message) {
        this.log('info', message);
    }

    warn(message) {
        this.log('warn', message);
    }

    error(message) {
        this.log('error', message);
    }

    log(level, message) {
        if (this.severityLevels[level] >= this.severityLevels[this.currentLevel]) {
            console.log(`[${level.toUpperCase()}] ${message}`);
        }
    }
}

// Create a singleton instance of Logger and export it
const logger = new Logger();
module.exports = logger;