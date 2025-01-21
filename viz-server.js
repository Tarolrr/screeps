const express = require('express');
const path = require('path');
const { getRoomTerrain } = require('./get-terrain');
require('./dist2/mock-game');  // Initialize game objects
const { patterns } = require('./dist2/constructionPatterns');
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
        console.log(`Processing pattern request:
    Pattern: ${pattern}
    SubPattern: ${subPattern || 'none'}
    Position: (${position.x}, ${position.y})
    Size: ${size}
    Steps: ${steps}`);

        // Set up mock room with terrain
        setTerrain('W1N1', terrain);
        
        let result;
        if (pattern === 'patternPlacer') {
            console.log(`Using pattern placer with ${subPattern}`);
            result = patterns[pattern].getPositions({
                pattern: subPattern,
                patternArgs: { 
                    size,
                    startPos: position  
                },
                terrain,
                targetPos: position
            }, undefined);
        } else {
            console.log(`Using direct pattern ${pattern}`);
            result = patterns[pattern].getPositions({ 
                startPos: position,
                size,
                steps
            }, undefined);  
        }
        
        const positions = result.positions || [];
        console.log(`Generated ${positions.length} positions`);
        res.json(positions);  
    } catch (error) {
        console.error('Pattern generation error:', {
            error: error.message,
            stack: error.stack,
            request: {
                pattern,
                subPattern,
                position,
                size,
                steps
            }
        });
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
