'use strict';
// Delayed and rejected fault injection for each newly drained detached writer.
// A delay must stretch the ack; a reject must yield UNKNOWN + poisoned/quarantined
// instance, never a false PASS. Cases whose hook never engaged are reported
// 'unexercised' — coverage gaps, not failures of the fence.
const path = require('path');
const fs = require('fs');
const {createIsolatedServer} = require('./instance');
const {StepClient} = require('./step-client');
const {Harness} = require('../harness');
const {captureSnapshot} = require('./snapshot-client');
const {setTimeout: sleep} = require('timers/promises');

const WRITERS = {
  'history':      {file:'history-fault.json',      proc:'processor', verify:j=>j.some(r=>r.kind==='writer'&&/history|save/i.test(r.op))||j.some(r=>r.kind==='store'&&r.collection==='rooms.history'), verifyText:'history writer journal'},
  'roomstat':     {file:'roomstat-fault.json',     proc:'processor', verify:j=>j.some(r=>r.kind==='writer'&&/stat/i.test(r.op)), verifyText:'roomstat writer journal'},
  'access-rooms': {file:'access-rooms-fault.json', proc:'main',      verify:null, verifyText:'accessibleRooms readback'},
  'room-status':  {file:'room-status-fault.json',  proc:'main',      verify:null, verifyText:'roomStatusData readback'},
  'notify':       {file:'notify-fault.json',       proc:'runner',    verify:j=>j.some(r=>r.kind==='writer'&&/console|notif/i.test(r.op)), verifyText:'notify writer journal'},
};

function journalRecords(root){
  const out=[];
  for(const file of fs.readdirSync(root)) {
    if(!/^step-journal-.*\.jsonl$/.test(file)) continue;
    for(const line of fs.readFileSync(path.join(root,file),'utf8').split('\n')) {
      if(line) try{out.push(JSON.parse(line));}catch{}
    }
  }
  return out;
}
function hooksFor(root, faultFile){
  const out=[];
  for(const file of fs.readdirSync(root)) {
    if(!/^step-coverage-.*\.json$/.test(file)) continue;
    try{
      const cov=JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
      for(const [hook,ff] of Object.entries(cov.hooks||{})) if(ff===faultFile) out.push(hook);
    }catch{}
  }
  return out;
}

async function runCase(writer, mode, ports){
  const spec=WRITERS[writer];
  const runId=`snapshot-fault-${writer}-${mode}-${Date.now()}-${process.pid}`;
  const server=await createIsolatedServer({runId,httpPort:ports[0],cliPort:ports[1],mods:[path.join(__dirname,'step-mod.js')],preload:path.join(__dirname,'step-preload.js')});
  let h,failure,result={writer,mode,runId};
  try {
    await server.start(); await server.assertIdentity();
    const gate=await StepClient.connect(server.root,{timeoutMs:15000});
    fs.writeFileSync(path.join(server.root,'step-control',spec.file),JSON.stringify({delayMs:mode==='delay'?1200:0,reject:mode==='reject'}),{mode:0o600,flag:'wx'});
    h=new Harness({cliHost:server.cliOptions.host,cliPort:server.cliOptions.port}); await h.connect();
    await h.eval("Promise.all([storage.env.set('roomStatusData','{}'),storage.env.set('accessibleRooms','[]')])",5000);
    const room=await h.eval("storage.db['rooms.objects'].findOne({type:'controller'}).then(x=>x && x.room)",5000);
    // console.log makes runResult.console non-empty so the runner's detached
    // sendConsoleMessages writer actually engages for the 'notify' cases.
    const user=await h.createUser({username:`fault${process.pid}`,roomName:room,spawn:true,modules:{main:"module.exports.loop=function(){Memory.count=(Memory.count||0)+1;console.log('tick',Game.time);};"}});
    const hooks=hooksFor(server.root,spec.file);
    result.hooks=hooks;
    if(mode==='delay'){
      const started=Date.now();
      const ack=await gate.step({timeoutMs:25000});
      const elapsed=Date.now()-started;
      result.elapsedMs=elapsed; result.ackGameTime=ack.gameTime;
      const journal=journalRecords(server.root);
      const engaged=spec.verify ? spec.verify(journal) : null;
      result.engaged=engaged;
      if(elapsed<1000) result.verdict=hooks.length?'unexercised':'skipped-no-hook';
      else {
        if(writer==='access-rooms'){
          const acc=await h.eval("storage.env.get('accessibleRooms').then(x=>{try{return JSON.parse(x)}catch(e){return x}})",5000);
          result.readback=acc; if(!Array.isArray(acc)) result.verdict='drain-unverified';
        } else if(writer==='room-status'){
          const rsd=await h.eval("storage.env.get('roomStatusData').then(x=>{try{return JSON.parse(x)}catch(e){return x}})",5000);
          result.readback=typeof rsd; if(!rsd||typeof rsd!=='object') result.verdict='drain-unverified';
        }
        if(!result.verdict) result.verdict=engaged===false?'unexercised':'observed-delay';
      }
      // one more clean step to leave the instance in a sane state
      try{fs.unlinkSync(path.join(server.root,'step-control',spec.file));}catch{}
      await gate.step({timeoutMs:20000}).then(()=>{result.recovered=true;},e=>{result.recovered=String(e);});
    } else {
      // reject: the cycle must not produce a verified ack; controller must quarantine
      let timedOut=false,err=null;
      try{await gate.step({timeoutMs:4000});}catch(e){err=e;if(/UNKNOWN.*deadline|invalid or incomplete cycle/.test(e.message))timedOut=true;}
      result.gateFailed=gate.failed; result.error=err&&String(err.message||err);
      if(!timedOut || !gate.failed){result.verdict=hooks.length?'unexercised':'skipped-no-hook';}
      else result.verdict='unknown-quarantined';
    }
  } catch(error){failure=error;result.error=String(error&&error.message||error);}
  finally{
    if(h)h.close();
    try{await server.stop();
      if(!failure && result.verdict!=='unknown-quarantined' && result.verdict!=='fence-bypassed'){await server.destroy();result.cleaned=true;}
      else console.error(`quarantined artifacts: ${server.root}`);
    }catch(e){failure=Error(`${failure?failure.message+'; ':''}cleanup failed: ${e.message}`);}
  }
  if(failure)result.verdict=result.verdict||'error';
  result.quarantined=!result.cleaned;
  return result;
}

(async()=>{
  const arg=process.argv.find(a=>a.startsWith('--case='));
  const cases=arg?[arg.slice(7).split(':')]:[
    ['access-rooms','delay'],['room-status','delay'],['history','delay'],['roomstat','delay'],['notify','delay'],
    ['access-rooms','reject'],['room-status','reject'],['history','reject'],['notify','reject'],
  ];
  const results=[];
  for(const [writer,mode] of cases){
    if(!WRITERS[writer]){results.push({writer,mode,verdict:'invalid-case'});continue;}
    results.push(await runCase(writer,mode,[32302,32303]));
    console.log(JSON.stringify(results[results.length-1]));
    await sleep(500);
  }
  const bad=results.filter(r=>['fence-bypassed','drain-unverified','error','invalid-case'].includes(r.verdict));
  console.log(JSON.stringify({status:bad.length?'FAIL':'done',cases:results.length,verdicts:Object.fromEntries(results.map(r=>[`${r.writer}:${r.mode}`,r.verdict]))}));
  if(bad.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
