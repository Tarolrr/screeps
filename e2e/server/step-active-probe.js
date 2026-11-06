'use strict';
// Exploratory calibration; evidence, not an admitted snapshot fence.
const path = require('path');
const fs = require('fs');
const {createIsolatedServer} = require('./instance');
const {StepClient} = require('./step-client');
const {Harness} = require('../harness');
(async () => {
  const runId=`step-active-${Date.now()}-${process.pid}`;
  const server=await createIsolatedServer({runId,httpPort:32177,cliPort:32178,mods:[path.join(__dirname,'step-mod.js')], preload:path.join(__dirname,'step-preload.js')});
  let h, failure;
  try {
    await server.start(); await server.assertIdentity();
    const gate=await StepClient.connect(server.root,{timeoutMs:15000});
    const memoryDelay=process.argv.includes('--memory-delay'), memoryReject=process.argv.includes('--memory-reject');
    if(memoryDelay || memoryReject) fs.writeFileSync(path.join(server.root,'step-control','memory-fault.json'),JSON.stringify({delayMs:memoryDelay?1200:0,reject:memoryReject}),{mode:0o600,flag:'wx'});
    const delayTest=process.argv.includes('--delay'), resetTest=process.argv.includes('--reset-delay'), rejectTest=process.argv.includes('--reject');
    if(process.argv.includes('--processor-error')) fs.writeFileSync(path.join(server.root,'step-control','processor-fault.json'),'{}',{mode:0o600,flag:'wx'});
    if(delayTest || rejectTest || resetTest) fs.writeFileSync(path.join(server.root,'step-control','activate-fault.json'),JSON.stringify({delayMs:resetTest?6500:delayTest?1200:0,reject:rejectTest}),{mode:0o600,flag:'wx'});
    h=new Harness({cliHost:server.cliOptions.host,cliPort:server.cliOptions.port}); await h.connect();
    await h.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])",5000);
    const room=await h.eval("storage.db['rooms.objects'].findOne({type:'controller'}).then(x=>x && x.room)",5000);
    if (!room) throw Error('missing controller');
    const user=await h.createUser({username:`probe${process.pid}`,roomName:room,spawn:true,modules:{main:process.argv.includes('--runner-error') ? "module.exports.loop = function() { throw new Error('injected runtime error'); };" : "module.exports.loop = function() { Memory.count = (Memory.count || 0) + 1; Memory.tick = Game.time; if (Memory.count === 1) Memory.returnCode = Game.spawns.Spawn1.spawnCreep([MOVE], 'probe-creep'); };"}});
    const snapshot=async()=>({time:Number(await h.eval("storage.env.get('gameTime')",5000)),memory:await h.eval(`storage.env.get(${JSON.stringify('memory:'+user)}).then(x=>x ? JSON.parse(x) : null)`,5000),objects:await h.eval(`storage.db['rooms.objects'].find(${JSON.stringify({room})})`,5000)});
    const initial=await snapshot();
    let prev=initial;
    for(let i=1;i<=3;i++) {
      const started=Date.now(); const ack=await gate.step({timeoutMs:rejectTest?3000:20000});
      if((delayTest || memoryDelay) && Date.now()-started < 1000) throw Error('activation drain did not wait for injected delay'); console.log(JSON.stringify({ack})); const snap=await snapshot();
      if(snap.time !== initial.time+i || !snap.memory || snap.memory.count !== i || snap.memory.tick !== snap.time - 1) throw Error(`unexpected runtime at step ${i}: ${JSON.stringify(snap.memory)}`);
      const records=fs.readdirSync(server.root).filter(x=>/^step-runner-.*\.jsonl$/.test(x)).flatMap(x=>fs.readFileSync(path.join(server.root,x),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)).filter(x=>x.user===user && x.stage==='start');
      if(records.length!==i || records.some(x=>x.error || !x.hasMemory || !x.hasIntents)) throw Error(`runner evidence incomplete: ${JSON.stringify(records)}`);
      const processor=fs.readdirSync(server.root).filter(x=>/^step-processor-.*\.jsonl$/.test(x)).flatMap(x=>fs.readFileSync(path.join(server.root,x),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
      if(processor.some(x=>x.stage==='error') || processor.filter(x=>x.stage==='saveRoom' && x.room===room).length!==i) throw Error(`processor evidence incomplete: ${JSON.stringify(processor)}`);
      const spawn=snap.objects.find(o=>o.type==='spawn' && o.user===user);
      if(!spawn) throw Error('spawn missing');
      if(i===1 && (snap.memory.returnCode!==0 || !(spawn.spawning || snap.objects.some(o=>o.name==='probe-creep')))) throw Error('spawn action effect missing');
      console.log(JSON.stringify({step:i,time:snap.time,memory:snap.memory,spawn:{id:spawn._id,store:spawn.store,spawning:spawn.spawning},creeps:snap.objects.filter(o=>o.name==='probe-creep').map(o=>({_id:o._id,spawning:o.spawning}))}));
      prev=snap;
    }
    console.log(JSON.stringify({status:'experimental-only',runId,room,user,initialTime:initial.time,finalTime:prev.time}));
  } catch(error) { failure=error; }
  finally { if(h) h.close(); try { await server.stop(); if (!failure) await server.destroy(); else console.error(`quarantined artifacts: ${server.root}`); } catch(error) { failure=Error(`${failure?failure.message+'; ':''}cleanup failed: ${error.message}`); } }
  if(failure) throw failure;
})().catch(error=>{console.error(error);process.exitCode=1;});
