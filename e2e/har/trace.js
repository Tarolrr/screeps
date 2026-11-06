'use strict';
// Per-tick trace recorder (trace schema version 1).
//
// One JSONL file per run: a 'meta' record first, then one record per captured
// frame. Every frame is bound to a verified step-gate ack (gameTime, barrier
// evidence) plus a coherent field-set snapshot. Supplemental reads (notifications,
// intents, user cpu) happen inside the same quiescent hold — they are reads,
// not field-set mutations, so they cannot break the barrier.
const fs = require('fs');
const path = require('path');

const TRACE_SCHEMA_VERSION = 1;
const REQUIRED = ['schemaVersion', 'runId', 'scenarioId', 'seedId', 'wallTs', 'gameTime',
    'phase', 'objects', 'memory', 'moduleHashes'];

function sha256File(file) {
    return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Compact per-object projection kept in every frame.
function projectObject(o) {
    const p = {
        id: o._id, type: o.type, user: o.user || null, room: o.room, x: o.x, y: o.y,
    };
    if (o.body) p.body = o.body.map(b => ({ type: b.type, hits: b.hits }));
    if (o.hits !== undefined) { p.hits = o.hits; p.hitsMax = o.hitsMax; }
    if (o.store !== undefined) p.store = o.store;
    if (o.storeCapacity !== undefined) p.storeCapacity = o.storeCapacity;
    if (o.storeCapacityResource !== undefined) p.storeCapacityResource = o.storeCapacityResource;
    if (o.spawning !== undefined) p.spawning = o.spawning;
    if (o.fatigue !== undefined) p.fatigue = o.fatigue;
    if (o.ageTime !== undefined) p.ageTime = o.ageTime;
    if (o.name !== undefined) p.name = o.name;
    if (o.energy !== undefined) { p.energy = o.energy; p.energyCapacity = o.energyCapacity; }
    if (o.ticksToRegeneration !== undefined) p.ticksToRegeneration = o.ticksToRegeneration;
    if (o.level !== undefined) p.level = o.level;
    if (o.progress !== undefined) p.progress = o.progress;
    if (o.progressTotal !== undefined) p.progressTotal = o.progressTotal;
    if (o.amount !== undefined) p.amount = o.amount; // dropped energy / ruins
    if (o.decayTime !== undefined) p.decayTime = o.decayTime;
    if (o.actionLog) p.actionLog = o.actionLog;
    return p;
}

class TraceRecorder {
    // meta: {runId, scenarioId, seedId, fixture, moduleHashes:{name:sha256}, budgets}
    constructor(runDir, meta) {
        this.runDir = runDir;
        this.file = path.join(runDir, 'trace.jsonl');
        fs.writeFileSync(this.file, JSON.stringify({ kind: 'meta', schemaVersion: TRACE_SCHEMA_VERSION, ...meta }) + '\n', { mode: 0o600, flag: 'wx' });
    }

    // Assemble + append one frame.
    //   phase: 'pre-step' | 'post-step' | 'final'
    //   snap: captureSnapshot() result {ok, snapshot, problems, evidence}
    //   ack: step-gate ack (null for pre-step)
    //   extra: {notifications, userCpu, intents, errors} supplemental reads
    record({ phase, stepIndex, ack, snap, extra, runId, scenarioId, seedId, moduleHashes }) {
        const objects = (snap.snapshot && snap.snapshot.objects) || {};
        const flat = [];
        for (const room of Object.keys(objects)) for (const o of objects[room]) flat.push(projectObject(o));
        const rec = {
            schemaVersion: TRACE_SCHEMA_VERSION,
            kind: 'frame',
            runId, scenarioId, seedId,
            wallTs: Date.now(),
            gameTime: snap.snapshot ? snap.snapshot.gameTime : null,
            ackGameTime: ack ? ack.gameTime : null,
            phase, stepIndex,
            snapshotOk: snap.ok,
            problems: snap.problems,
            evidence: snap.evidence && {
                bound: snap.evidence.bound, stable: snap.evidence.stable,
                postBarrierWrites: snap.evidence.postBarrierWrites.length,
                ttlOk: snap.evidence.ttlOk, coverageComplete: snap.evidence.coverage && snap.evidence.coverage.complete,
            },
            ack: ack && {
                sequence: ack.sequence, gameTime: ack.gameTime, barrierTs: ack.barrierTs,
                drainStartTs: ack.drainStartTs, drains: (ack.drains || []).length,
                postBarrierWrites: (ack.postBarrierWrites || []).length,
                queuedUsers: ack.queuedUsers, queuedRooms: ack.queuedRooms,
            },
            objects: flat,
            sources: flat.filter(o => o.type === 'source'),
            controller: flat.find(o => o.type === 'controller') || null,
            sites: flat.filter(o => o.type === 'constructionSite'),
            drops: flat.filter(o => ['energy', 'tombstone', 'ruin'].includes(o.type)),
            creeps: flat.filter(o => o.type === 'creep'),
            actionLog: flat.filter(o => o.actionLog).map(o => ({ id: o.id, name: o.name, actionLog: o.actionLog, phase })),
            memory: snap.snapshot ? snap.snapshot.memory : null,
            queue: 'asserted-by-protocol-not-read',
            intents: extra && extra.intents !== undefined ? extra.intents : null,
            errors: extra && extra.errors !== undefined ? extra.errors : null,
            notifications: extra && extra.notifications !== undefined ? extra.notifications : null,
            cpu: extra && extra.userCpu !== undefined ? extra.userCpu : null,
            moduleHashes,
        };
        for (const key of REQUIRED) {
            if (rec[key] === undefined) throw Error(`trace record missing ${key}`);
        }
        fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', { mode: 0o600 });
        return rec;
    }
}

module.exports = { TraceRecorder, TRACE_SCHEMA_VERSION, projectObject, sha256File };
