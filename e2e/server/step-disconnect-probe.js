'use strict';
// File-based controller: a timed-out command is an unknown result, not a retry.
const path=require('path'),fs=require('fs');
const {setTimeout:sleep}=require('timers/promises');
const {createIsolatedServer}=require('./instance');
const {StepClient}=require('./step-client');
const {Harness}=require('../harness');
(async()=>{
 const s=await createIsolatedServer({runId:`step-disconnect-${Date.now()}-${process.pid}`,httpPort:32213,cliPort:32214,mods:[path.join(__dirname,'step-mod.js')],preload:path.join(__dirname,'step-preload.js')});
 let h,failure;
 try {
  await s.start(); const gate=await StepClient.connect(s.root,{timeoutMs:15000});
  if(!fs.existsSync(path.join(s.root,'step-backend-cron-disabled.json'))) throw Error('cron exclusion missing');
  h=new Harness({cliHost:s.cliOptions.host,cliPort:s.cliOptions.port});await h.connect();
  await h.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])",5000);
  const room=await h.eval("storage.db['rooms.objects'].findOne({type:'controller'}).then(x=>x.room)",5000);
  const user=await h.createUser({username:`disconnect_${process.pid}`,roomName:room,spawn:true,modules:{main:"module.exports.loop=function(){Memory.count=(Memory.count||0)+1;}"}});
  const initial=Number(await h.eval("storage.env.get('gameTime')",5000));
  fs.writeFileSync(path.join(s.root,'step-control','activate-fault.json'),JSON.stringify({delayMs:1200,reject:false}),{flag:'wx',mode:0o600});
  let timedOut=false;try{await gate.step({timeoutMs:100});}catch(e){if(!/UNKNOWN.*deadline/.test(e.message))throw e;timedOut=true;}
  if(!timedOut || !gate.failed)throw Error('missing timeout quarantine');
  try{await gate.step({timeoutMs:100});throw Error('unsafe retry accepted');}catch(e){if(!/controller unavailable/.test(e.message))throw e;}
  const ackPath=path.join(s.root,'step-control','ack-1.json');
  const deadline=Date.now()+15000;while(!fs.existsSync(ackPath)&&Date.now()<deadline)await sleep(50);
  if(!fs.existsSync(ackPath))throw Error('no late ack within bounded observation');
  const ack=JSON.parse(fs.readFileSync(ackPath,'utf8'));if(ack.sequence!==1)throw Error('wrong late ack');
  // A newly constructed controller must also fail rather than reuse sequence 1.
  const reconnected=await StepClient.connect(s.root,{timeoutMs:2000});
  try{await reconnected.step({timeoutMs:1000});throw Error('unsafe reconnect accepted');}catch(e){if(!/EEXIST/.test(e.message))throw e;}
  await sleep(500);
  const time=Number(await h.eval("storage.env.get('gameTime')",5000));
  const mem=await h.eval(`storage.env.get(${JSON.stringify('memory:'+user)}).then(x=>JSON.parse(x||'null'))`,5000);
  if(time!==initial+1||!mem||mem.count!==1||fs.existsSync(path.join(s.root,'step-control','command-2.json')))throw Error('unexpected extra tick or command');
  console.log(JSON.stringify({status:'expected UNKNOWN/quarantine',initial,time,lateAck:ack.sequence,memoryCount:mem.count}));
  console.log(`quarantine retained: ${s.root}`);
 }catch(e){failure=e;}finally{if(h)h.close();try{await s.stop();}catch(e){failure=Error(`${failure?.message||''}; cleanup: ${e.message}`);}}
 if(failure)throw failure;
})().catch(e=>{console.error(e);process.exitCode=1});
