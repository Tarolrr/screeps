'use strict';
// Two users, two owned rooms, actual runtime and spawn actions. Research only.
const fs=require('fs'), path=require('path');
const {createIsolatedServer}=require('./instance');
const {StepClient}=require('./step-client');
const {Harness}=require('../harness');
(async()=>{
  const server=await createIsolatedServer({runId:`step-multi-${Date.now()}-${process.pid}`,httpPort:32179,cliPort:32180,mods:[path.join(__dirname,'step-mod.js')],preload:path.join(__dirname,'step-preload.js')});
  let h,failure;
  try {
    await server.start(); await server.assertIdentity();
    const gate=await StepClient.connect(server.root,{timeoutMs:15000});
    h=new Harness({cliHost:server.cliOptions.host,cliPort:server.cliOptions.port}); await h.connect();
    await h.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])",5000);
    const rooms=(await h.eval("storage.db['rooms.objects'].find({type:'controller'}).then(a=>a.map(x=>x.room))",5000)).slice(0,2);
    if(rooms.length!==2 || rooms[0]===rooms[1]) throw Error('two distinct rooms unavailable');
    const users=[];
    for(let i=0;i<2;i++) users.push(await h.createUser({username:`multi${process.pid}x${i}`,roomName:rooms[i],spawn:true,modules:{main:"module.exports.loop=function(){Memory.count=(Memory.count||0)+1;Memory.tick=Game.time;if(Memory.count===1)Memory.code=Game.spawns.Spawn1.spawnCreep([MOVE],'probe-creep');};"}}));
    const initial=Number(await h.eval("storage.env.get('gameTime')",5000));
    for(let i=1;i<=3;i++) {
      const ack=await gate.step({timeoutMs:20000});
      if(users.some(u=>!ack.queuedUsers.includes(u)) || rooms.some(r=>!ack.queuedRooms.includes(r))) throw Error('missing user or room queue item');
      for(let j=0;j<2;j++) {
        const memory=await h.eval(`storage.env.get(${JSON.stringify('memory:'+users[j])}).then(x=>JSON.parse(x))`,5000);
        const objects=await h.eval(`storage.db['rooms.objects'].find(${JSON.stringify({room:rooms[j],user:users[j]})})`,5000);
        if(memory.count!==i || memory.tick!==initial+i-1 || memory.code!==0 || !objects.some(x=>x.name==='probe-creep')) throw Error(`missing user effect ${j} at ${i}`);
      }
      const time=Number(await h.eval("storage.env.get('gameTime')",5000));
      if(time!==initial+i) throw Error('unexpected time');
      const records=fs.readdirSync(server.root).filter(x=>/^step-runner-.*\.jsonl$/.test(x)).flatMap(x=>fs.readFileSync(path.join(server.root,x),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
      if(users.some(u=>records.filter(x=>x.user===u && x.stage==='start' && !x.error && x.hasMemory && x.hasIntents).length!==i)) throw Error('runner evidence incomplete');
      console.log(JSON.stringify({step:i,time,users:users.length,rooms:rooms.length}));
    }
  } catch(e) {failure=e;}
  finally {if(h)h.close();try{await server.stop();if(!failure)await server.destroy();else console.error(`quarantined artifacts: ${server.root}`);}catch(e){failure=Error(`${failure?failure.message+'; ':''}cleanup failed: ${e.message}`);}}
  if(failure)throw failure;
})().catch(e=>{console.error(e);process.exitCode=1;});
