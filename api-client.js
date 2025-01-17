const { ScreepsAPI } = require('screeps-api');

async function initApi() {
    return ScreepsAPI.fromConfig();
}

async function makeApiCall(path, ...args) {
    try {
        const api = await initApi();
        const pathParts = path.split('.');
        let fn = api.raw;
        for (const part of pathParts) {
            fn = fn[part];
        }
        if (!fn || typeof fn !== 'function') {
            throw new Error('Invalid API path');
        }
        const result = await fn.apply(api, args);
        return result;
    } catch (error) {
        console.error('API call failed:', error);
        throw error;
    }
}

// Example usage:
async function main() {
    try {
        // Example: Get room overview
        const result = await makeApiCall('game.roomTerrain', 'W1N1', 'shard3', '1');
        console.log('API Response:', result);
    } catch (error) {
        console.error('Error:', error);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    makeApiCall,
    initApi
};
