const express = require('express');
const path = require('path');
const { getRoomTerrain } = require('./get-terrain');
require('./dist2/mock-game');  // Initialize game objects
const patterns = require('./dist2/constructionPatterns');
const { setTerrain } = require('./dist2/mock-game');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist2')));

app.get('/terrain/:room/:shard', async (req, res) => {
    try {
        const terrain = await getRoomTerrain(req.params.room, req.params.shard);
        res.json({ terrain });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/pattern', (req, res) => {
    const { pattern, subPattern, position, size, steps, terrain } = req.body;
    
    try {
        // Set up mock room with terrain
        setTerrain('W1N1', terrain);
        
        let result;
        if (pattern === 'patternPlacer') {
            result = patterns[pattern]({
                pattern: patterns[subPattern],
                patternArgs: { size },
                terrain,
                targetPos: position
            }, steps);
        } else {
            result = patterns[pattern]({ 
                startPos: position,
                size,
                steps
            });
        }
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
