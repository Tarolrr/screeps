'use strict';
// Snapshot coherence probe: S(T) -> one step -> S(T+1) bound to the ack's
// calibrated gameTime, with memory advance, double-read stability, journal
// cross-check and coverage verification. Research only.
const path = require('path');
const fs = require('fs');
const {createIsolatedServer} = require('./instance');
const {StepClient} = require('./step-client');
const {Harness} = require('../harness');
const {captureSnapshot} = require('./snapshot-client');
(async () => {
  const runId=`snapshot-basic-${Date.now()}-${process.pid}`;
  const server=await createIsolatedServer({runId,httpPort:32300,cliPort:32301,mods:[path.join(__dirname,'step-mod.js')],preload:path.join(__dirname,'step-preload.js')});
  let h,failure;
  try {
    await server.start(); await server.assertIdentity();
    if (!fs.existsSync(path.join(server.root,'step-backend-cron-disabled.json'))) throw Error('backend cron disable marker missing');
    const gate=await StepClient.connect(server.root,{timeoutMs:15000});
    h=new Harness({cliHost:server.cliOptions.host,cliPort:server.cliOptions.port}); await h.connect();
    await h.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])",5000);
    const room=await h.eval("storage.db['rooms.objects'].findOne({type:'controller'}).then(x=>x && x.room)",5000);
    if(!room) throw Error('missing controller');
    const user=await h.createUser({username:`snap${process.pid}`,roomName:room,spawn:true,modules:{main:"module.exports.loop=function(){Memory.count=(Memory.count||0)+1;Memory.tick=Game.time;if(Memory.count===1)Memory.returnCode=Game.spawns.Spawn1.spawnCreep([MOVE],'probe-creep');};"}});
    const fixture={rooms:[room],users:[user]};
    const initial=Number(await h.eval("storage.env.get('gameTime')",5000));
    const results=[];
    for(let i=1;i<=3;i++){
      const ack=await gate.step({timeoutMs:20000});
      if(!Number.isFinite(ack.gameTime)) throw Error(`ack ${i} lacks gameTime binding`);
      if(ack.gameTime!==initial+i) throw Error(`ack gameTime ${ack.gameTime} != ${initial+i}`);
      const snap=await captureSnapshot(h.cli,server.root,ack,fixture,{settleMs:250});
      console.log(JSON.stringify({step:i,ack:{sequence:ack.sequence,gameTime:ack.gameTime,barrierTs:ack.barrierTs,drainStartTs:ack.drainStartTs,postBarrier:ack.postBarrierWrites.length,drains:ack.drains.length},snapshotOk:snap.ok,problems:snap.problems}));
      if(!snap.ok) throw Error(`snapshot ${i} not coherent: ${snap.problems.join('; ')}`);
      const mem=snap.snapshot.memory[user];
      if(snap.snapshot.gameTime!==initial+i || !mem || mem.count!==i || mem.tick!==initial+i-1) throw Error(`memory binding broken at step ${i}: ${JSON.stringify(mem)}`);
      const objects=snap.snapshot.objects[room]||[];
      if(!objects.some(o=>o.type==='spawn'&&o.user===user)) throw Error('spawn missing in snapshot');
      if(i===1 && mem.returnCode!==0) throw Error('spawn intent effect missing');
      results.push({step:i,gameTime:snap.snapshot.gameTime,count:mem.count,tick:mem.tick,activeRooms:snap.snapshot.activeRooms});
    }
    console.log(JSON.stringify({status:'PASS',runId,room,user,initialTime:initial,results}));
  } catch(error){failure=error;}
  finally{if(h)h.close();try{await server.stop();if(!failure)await server.destroy();else console.error(`quarantined artifacts: ${server.root}`);}catch(e){failure=Error(`${failure?failure.message+'; ':''}cleanup failed: ${e.message}`);}}
  if(failure)throw failure;
})().catch(e=>{console.error(e);process.exitCode=1;});
