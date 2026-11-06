// Test harness for a live standalone Screeps server (python setup/teardown style).
// Uses the admin CLI socket to drive the server: load user code, manipulate the
// DB directly, read Memory/env metrics back. See test1-*.js / test2-*.js.
const { ScreepsCLI } = require('./cli-client');

const MEMORY_PREFIX = 'memory:';

class Harness {
    constructor(opts = {}) {
        this.cli = new ScreepsCLI(opts.cliHost || process.env.SCREEPS_CLI_HOST || '::1', opts.cliPort || Number(process.env.SCREEPS_CLI_PORT || 21026));
        this.roomBaseline = new Map();
    }

    async connect() { await this.cli.connect(); }
    close() { this.cli.close(); }

    // --- sandbox escape hatch -------------------------------------------------
    eval(code, timeoutMs) { return this.cli.eval(code, timeoutMs); }

    // --- env / world state ----------------------------------------------------
    gameTime() { return this.eval(`storage.env.get("gameTime")`); }
    getTickDuration() { return this.eval(`system.getTickDuration()`); }
    setTickDuration(ms) { return this.eval(`system.setTickDuration(${ms})`); }
    pauseSimulation() { return this.eval(`system.pauseSimulation()`); }
    resumeSimulation() { return this.eval(`system.resumeSimulation()`); }

    getMemory(userId) {
        return this.eval(`storage.env.get(${JSON.stringify(MEMORY_PREFIX + userId)})`)
            .then(raw => (raw ? JSON.parse(raw) : null));
    }

    // --- db helpers (evaluate expressions in the sandbox) ---------------------
    dbFind(coll, query) {
        return this.eval(`storage.db[${JSON.stringify(coll)}].find(${JSON.stringify(query)})`);
    }
    dbFindOne(coll, query) {
        return this.eval(`storage.db[${JSON.stringify(coll)}].findOne(${JSON.stringify(query)})`);
    }
    dbInsert(coll, obj) {
        return this.eval(`storage.db[${JSON.stringify(coll)}].insert(${JSON.stringify(obj)})`);
    }
    dbUpdate(coll, query, set) {
        return this.eval(`storage.db[${JSON.stringify(coll)}].update(${JSON.stringify(query)},{$set:${JSON.stringify(set)}})`);
    }
    dbRemove(coll, query) {
        return this.eval(`storage.db[${JSON.stringify(coll)}].removeWhere(${JSON.stringify(query)})`);
    }

    async waitTicks(n, pollMs = 500, timeoutMs = 300000) {
        const t0 = await this.gameTime();
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const t = await this.gameTime();
            if (t - t0 >= n) return t;
            await sleep(pollMs);
        }
        throw new Error(`waitTicks(${n}) timed out`);
    }

    // Wait until cond(ctx) resolves truthy; returns its value.
    async waitUntil(cond, { pollMs = 1000, timeoutMs = 180000, label = 'condition' } = {}) {
        const deadline = Date.now() + timeoutMs;
        let lastErr;
        while (Date.now() < deadline) {
            try {
                const v = await cond();
                if (v) return v;
            } catch (e) { lastErr = e; }
            await sleep(pollMs);
        }
        throw new Error(`waitUntil(${label}) timed out` + (lastErr ? `: ${lastErr.message}` : ''));
    }

    // --- user lifecycle --------------------------------------------------------
    // Creates a test user with uploaded code, optionally spawning it into a room
    // (claims the controller + places a spawn, like bots.spawn but with our code).
    // Refuse to touch a room containing player state, reservations, or structures.
    async assertSafeRoom(roomName) {
        const objects = await this.roomObjects(roomName);
        const controllers = objects.filter(o => o.type === 'controller');
        const unsafe = objects.filter(o => !['source', 'mineral', 'controller'].includes(o.type) || o.user || o.reservation);
        if (controllers.length !== 1 || unsafe.length) {
            throw new Error(`Room ${roomName} is not empty and unreserved; refusing live test`);
        }
        this.roomBaseline.set(roomName, { ids: objects.map(o => o._id), controller: controllers[0] });
    }

    async createUser({ username, modules, roomName, cpu = 100, spawn = false, spawnPos = null }) {
        if (spawn) await this.assertSafeRoom(roomName);
        // translate module names like the server does (dots in keys break on insert)
        const translated = {};
        for (const k in modules) {
            translated[k.replace(/\./g, '$DOT$').replace(/\//g, '$SLASH$').replace(/\\/g, '$BACKSLASH$')] = modules[k];
        }
        const modulesJson = JSON.stringify(translated);
        const script = `(function(){
            var db = storage.db, env = storage.env;
            return db.users.findOne({username: ${JSON.stringify(username)}}).then(function(exists){
                if (exists) throw 'username taken';
                return db.users.insert({username: ${JSON.stringify(username)},
                    usernameLower: ${JSON.stringify(username.toLowerCase())},
                    cpu: ${cpu}, cpuAvailable: 10000, gcl: 0,
                    registeredDate: new Date(), bot: 'e2e', active: 10000000});
            }).then(function(u){
                var p = db['users.code'].insert({user: u._id, branch: 'default',
                    activeWorld: true, activeSim: true, modules: ${modulesJson}})
                .then(function(){ return env.set(${JSON.stringify(MEMORY_PREFIX)} + u._id, '{}'); });
                ${spawn ? `
                p = p.then(function(){
                    return db['rooms.objects'].findOne({$and: [{room: ${JSON.stringify(roomName)}},{type: 'controller'}]});
                }).then(function(ctrl){
                    if (!ctrl) throw 'no controller in ' + ${JSON.stringify(roomName)};
                    if (ctrl.user) throw 'controller in ' + ${JSON.stringify(roomName)} + ' already owned';
                    return db['rooms.terrain'].findOne({room: ${JSON.stringify(roomName)}});
                }).then(function(t){
                    var pos = ${JSON.stringify(spawnPos)} || findFree(t.terrain);
                    return db['rooms.objects'].insert({type: 'spawn', room: ${JSON.stringify(roomName)},
                        x: pos.x, y: pos.y, name: 'Spawn1', user: u._id,
                        store: {energy: 300}, storeCapacityResource: {energy: 300},
                        hits: 5000, hitsMax: 5000, spawning: null, notifyWhenAttacked: false});
                }).then(function(){
                    return storage.env.get('gameTime');
                }).then(function(gt){
                    return db['rooms.objects'].update({$and: [{room: ${JSON.stringify(roomName)}},{type: 'controller'}]},
                        {$set: {user: u._id, level: 1, progress: 0, downgradeTime: null, safeMode: gt + 20000}});
                }).then(function(){ return env.sadd('activeRooms', ${JSON.stringify(roomName)}); });
                ` : ''}
                return p.then(function(){ return u._id; }).catch(function(err){
                    return db['rooms.objects'].update({user:u._id, type:'controller'}, {$set:{user:null, level:0, progress:0, downgradeTime:null, safeMode:null}}).then(function(){ return db['rooms.objects'].removeWhere({user:u._id}); }).then(function(){ return db['users.code'].removeWhere({user:u._id}); })
                        .then(function(){ return env.del('memory:' + u._id); })
                        .then(function(){ return db.users.removeWhere({_id:u._id}); })
                        .then(function(){ throw err; });
                });
            });

            function findFree(terrain){
                for (var y = 5; y < 45; y++) for (var x = 5; x < 45; x++) {
                    var c = terrain.charAt(y * 50 + x);
                    if (c !== '1' && c !== '3') return {x: x, y: y};
                }
                throw 'no free pos';
            }
        })()`;
        return this.eval(script);
    }

    async setUserCode(userId, modules, branch = 'default') {
        return this.eval(
            `storage.db['users.code'].update({$and:[{user:${JSON.stringify(userId)}},{branch:${JSON.stringify(branch)}}]},` +
            `{$set:{modules:${JSON.stringify(modules)},timestamp:Date.now()}}).then(r=>` +
            `r? true : storage.db['users.code'].insert({user:${JSON.stringify(userId)},branch:'default',activeWorld:true,activeSim:true,modules:${JSON.stringify(modules)}}).then(()=>true))`
        );
    }

    // First non-wall tile near (x,y); returns {x,y} or null.
    async findFreePos(roomName, nearX, nearY, radius = 5) {
        return this.eval(`(function(){
            return storage.db['rooms.terrain'].findOne({room: ${JSON.stringify(roomName)}}).then(function(t){
                var objs = [];
                return storage.db['rooms.objects'].find({room: ${JSON.stringify(roomName)}}).then(function(o){
                    var busy = {};
                    o.forEach(function(i){ busy[i.x + ',' + i.y] = true; });
                    var cx = ${JSON.stringify(nearX)}, cy = ${JSON.stringify(nearY)}, r = ${JSON.stringify(radius)};
                    for (var d = 0; d <= r; d++)
                        for (var dx = -d; dx <= d; dx++) for (var dy = -d; dy <= d; dy++) {
                            var x = cx + dx, y = cy + dy;
                            if (x < 2 || x > 47 || y < 2 || y > 47) continue;
                            var c = t.terrain.charAt(y * 50 + x);
                            if (c !== '1' && c !== '3' && !busy[x + ',' + y]) return {x: x, y: y};
                        }
                    return null;
                });
            });
        })()`);
    }

    // Insert a live creep object directly into rooms.objects.
    async insertCreep({ userId, room, x, y, name = 't1', parts = ['work', 'carry', 'move', 'move'],
                        store = {}, capacity = 50, age = 1500 }) {
        const body = parts.map(p => ({ type: p, hits: 100 }));
        const creep = {
            type: 'creep', room, x, y, name, user: userId,
            body, store, storeCapacity: capacity,
            hits: parts.length * 100, hitsMax: parts.length * 100,
            fatigue: 0, spawning: false, notifyWhenAttacked: true,
            actionLog: {
                attacked: null, healed: null, attack: null, rangedAttack: null,
                rangedMassAttack: null, rangedHeal: null, harvest: null, heal: null,
                repair: null, build: null, say: null, upgradeController: null,
                reserveController: null
            }
        };
        return this.eval(`(function(){
            return storage.env.get('gameTime').then(function(gt){
                var c = ${JSON.stringify(creep)};
                c.ageTime = gt + ${JSON.stringify(age)};
                return storage.db['rooms.objects'].insert(c);
            });
        })()`);
    }

    // Remove test user: objects in rooms, code, memory, account. Resets the
    // controller back to neutral if it was owned by this user. When roomName is
    // given, also clears built structures in that room — completed build()
    // products (roads, containers, walls) have no `user` field, so a plain
    // {user:uid} removal would leave test artifacts behind.
    async destroyUser(userId, roomName = null) {
        const baseline = this.roomBaseline.get(roomName);
        const script = `(function(){
            var db = storage.db, env = storage.env, uid = ${JSON.stringify(userId)};
            return db['rooms.objects'].find({user: uid, type: 'controller'}).then(function(ctrls){
                var p = Promise.resolve();
                ctrls.forEach(function(c){
                    p = p.then(function(){
                        return db['rooms.objects'].update({_id: c._id},
                            {$set: {user: null, level: 0, progress: 0, downgradeTime: null, safeMode: null}});
                    });
                });
                return p;
            }).then(function(){ return db['rooms.objects'].removeWhere({user: uid}); })
            .then(function(){ return db['users.code'].removeWhere({user: uid}); })
            .then(function(){ return db['users.power_creeps'].removeWhere({user: uid}); })
            .then(function(){ return env.del(${JSON.stringify(MEMORY_PREFIX)} + uid); })
            .then(function(){ return db.users.removeWhere({_id: uid}); })
            ${roomName && baseline ? `.then(function(){
                return db['rooms.objects'].removeWhere({$and: [
                    {room: ${JSON.stringify(roomName)}},
                    {_id: {$nin: ${JSON.stringify(baseline ? baseline.ids : [])}}},
                    {type: {$in: ['constructionSite','road','container','constructedWall','rampart','extension','tower','storage','link','extractor','lab','terminal','factory','observer','powerSpawn','nuker','energy']}},
                    {user: {$aeq: null}}
                ]});
            })` : ''}
            .then(function(){ return true; });
        })()`;
        // cleanup is retried — a transient CLI stall shouldn't strand a test user
        let lastErr;
        for (let i = 0; i < 3; i++) {
            try { return await this.eval(script, 120000); }
            catch (e) { lastErr = e; await sleep(2000); }
        }
        throw lastErr;
    }

    // --- metrics ---------------------------------------------------------------
    async userCpuAvailable(userId) {
        const u = await this.dbFindOne('users', { _id: userId });
        return u && u.cpuAvailable;
    }

    roomObjects(roomName, extraQuery = {}) {
        return this.dbFind('rooms.objects', Object.assign({ room: roomName }, extraQuery));
    }

    // --- test runner -------------------------------------------------------------
    async runCase(name, { setup, test, teardown, timeoutMs = 180000 } = {}) {
        const ctx = { h: this, metrics: {}, log: [] };
        const t0 = Date.now();
        ctx.metrics.startGameTime = await this.gameTime();
        console.log(`\n=== ${name} ===`);
        try {
            if (setup) await setup(ctx);
            const result = await test(ctx);
            ctx.metrics.endGameTime = await this.gameTime();
            ctx.metrics.wallMs = Date.now() - t0;
            console.log(`PASS ${name} | ticks: ${ctx.metrics.endGameTime - ctx.metrics.startGameTime}, wall: ${ctx.metrics.wallMs}ms`);
            if (Object.keys(ctx.metrics).length > 3) console.log('  metrics:', JSON.stringify(ctx.metrics));
            return { ok: true, result, metrics: ctx.metrics };
        } catch (e) {
            ctx.metrics.endGameTime = await this.gameTime().catch(() => null);
            ctx.metrics.wallMs = Date.now() - t0;
            console.log(`FAIL ${name}: ${e.message}`);
            if (Object.keys(ctx.metrics).length > 3) console.log('  metrics:', JSON.stringify(ctx.metrics));
            return { ok: false, error: e, metrics: ctx.metrics };
        } finally {
            if (teardown) {
                try { await teardown(ctx); }
                catch (e) { console.error(`  teardown error: ${e.message}`); throw e; }
            }
        }
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { Harness, sleep };
