const { makeApiCall } = require('./api-client');

async function getRoomTerrain(roomName, shard = 'shard3') {
    try {
        const result = await makeApiCall('game.roomTerrain', roomName, true, shard);
        if (result.ok && result.terrain && result.terrain[0]) {
            return result.terrain[0].terrain;
        } else {
            throw new Error('Failed to get terrain data: ' + JSON.stringify(result));
        }
    } catch (error) {
        throw error;
    }
}

module.exports = { getRoomTerrain };

// If run directly, fetch and display terrain
if (require.main === module) {
    const roomName = process.argv[2] || 'W1N1';
    const shard = process.argv[3] || 'shard3';
    getRoomTerrain(roomName, shard).then(console.log).catch(console.error);
}
