'use strict';
// Negative controls: deliberately untracked field-set writes must be detected,
// proving the quiescence check is not vacuous.
// Case A (journal/ack path): an in-engine detached write injected after the
//   drain barrier must flip the ack to 'unknown' (or lose it entirely) — never
//   a verified PASS.
// Case B (stability path): a CLI write between the two snapshot reads must make
//   captureSnapshot report ok:false.
const path = require('path');
const fs = require('fs');
const {createIsolatedServer} = require('./instance');
const {StepClient} = require('./step-client');
const {Harness} = require('../harness');
const {captureSnapshot} = require('./snapshot-client');
(async () => {
  const runId=`snapshot-negative-${Date.now()}-${process.pid}`;
  const server=await createIsolatedServer({runId,httpPort:32304,cliPort:32305,mods:[path.join(__dirname,'step-mod.js')],preload:path.join(__dirname,'step-preload.js')});
  let h,failure;
  const out={runId};
  try {
    await server.start(); await server.assertIdentity();
    const gate=await StepClient.connect(server.root,{timeoutMs:15000});
    h=new Harness({cliHost:server.cliOptions.host,cliPort:server.cliOptions.port}); await h.connect();
    await h.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])",5000);
    const room=await h.eval("storage.db['rooms.objects'].findOne({type:'controller'}).then(x=>x && x.room)",5000);
    const user=await h.createUser({username:`neg${process.pid}`,roomName:room,spawn:true,modules:{main:"module.exports.loop=function(){Memory.count=(Memory.count||0)+1;};"}});
    const fixture={rooms:[room],users:[user]};

    // Case B: untracked CLI write inside the double-read window must break stability.
    const ack1=await gate.step({timeoutMs:20000});
    const snap=await captureSnapshot(h.cli,server.root,ack1,fixture,{settleMs:250,betweenReads:async()=>{
      await h.eval(`storage.env.set(${JSON.stringify('memory:'+user)},${JSON.stringify(JSON.stringify({tampered:true}))})`,5000);
      await h.eval(`storage.db['rooms.objects'].insert({type:'flag',room:${JSON.stringify(room)},x:25,y:25,name:'e2e-untracked-flag',user:${JSON.stringify(user)}})`,5000);
    }});
    out.caseB={ok:snap.ok,problems:snap.problems,journalWrites:snap.evidence.postBarrierWrites.length};
    if(snap.ok) throw Error('stability control vacuous: between-reads write undetected');
    if(!snap.problems.some(p=>/double-read|post-barrier/.test(p))) throw Error(`unexpected detection shape: ${snap.problems.join('; ')}`);

    // Case A: in-engine untracked write after the barrier must be detected.
    fs.writeFileSync(path.join(server.root,'step-control','injected-write.json'),JSON.stringify({op:'env.set',key:'memory:e2e-untracked',value:'{}'}),{mode:0o600,flag:'wx'});
    let stepError=null;
    try{await gate.step({timeoutMs:15000});}catch(e){stepError=e;}
    const ackFile=path.join(server.root,'step-control','ack-2.json');
    let ack=null;
    try{ack=JSON.parse(fs.readFileSync(ackFile,'utf8'));}catch(e){ack={readError:String(e)};}
    out.caseA={stepError:stepError&&String(stepError.message||stepError),gateFailed:gate.failed,ackStatus:ack&&ack.status,postBarrier:ack&&ack.postBarrierWrites};
    if(!stepError || !gate.failed) throw Error('injected untracked write accepted: false PASS');
    if(ack && ack.status==='cycle-finished-unverified') throw Error('ack verified despite post-barrier write: false PASS');
    out.detected=(ack && ack.status==='unknown' && (ack.postBarrierWrites||[]).length>0)?'journal+ack':
      (stepError?'ack-loss/timeout':'NONE');
    if(out.detected==='NONE') throw Error('injection produced no detection and no failure');
    console.log(JSON.stringify({status:'expected-detection',...out}));
  } catch(error){failure=error;}
  finally{if(h)h.close();try{await server.stop();console.error(`quarantined artifacts: ${server.root}`);}catch(e){failure=Error(`${failure?failure.message+'; ':''}cleanup failed: ${e.message}`);}}
  if(failure)throw failure;
})().catch(e=>{console.error(e);process.exitCode=1;});
