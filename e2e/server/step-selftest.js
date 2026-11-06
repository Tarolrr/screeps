'use strict';
const fs=require('fs'), os=require('os'), path=require('path'), assert=require('assert');
const {spawn}=require('child_process'), {EventEmitter}=require('events');
const {StepClient}=require('./step-client'), integrity=require('./step-integrity'), install=require('./step-mod');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const old=process.cwd(), root=fs.mkdtempSync(path.join(os.tmpdir(),'screeps-step-test-'));
 const children=[];
 try {
  process.chdir(root);process.env.SCREEPS_E2E_ROOT=root;process.env.SCREEPS_E2E_MARKER='test-marker';
  fs.writeFileSync('ownership.json',JSON.stringify({root,marker:'test-marker',runId:'offline'}));
  integrity.verifyManifest(); assert.throws(()=>integrity.verifyDigest(Buffer.from('drift'),'bad'),/drift/);
  const engine=new EventEmitter(); let calls=0;
  engine.driver={notifyTickStarted:async()=>{calls++;},queue:{resetAll:()=>{}}}; engine.mainLoopCustomStage=async()=>{};
  global.__screepsStepPreload=true;install({engine});engine.emit('init','main');
  for(const type of ['runner','processor']) {const p=spawn('sleep',['30']);children.push(p);const record={type,...integrity.epoch(p.pid)};fs.writeFileSync(`step-participant-${type}.json`,JSON.stringify(record));}
  const client=await StepClient.connect(root);await assert.rejects(StepClient.connect(root),/EEXIST/);
  const baseline=integrity.participants(root), file='step-participant-runner.json', saved=fs.readFileSync(file,'utf8');
  const changed=JSON.parse(saved);changed.start='0';fs.writeFileSync(file,JSON.stringify(changed));assert.throws(()=>integrity.participants(root,baseline),/epoch/);fs.writeFileSync(file,saved);
  const cycle=(async()=>{await new Promise(r=>global.__screepsStepSchedule(r,0));engine.emit('mainLoopStage','start');await engine.driver.notifyTickStarted();for(const stage of ['getUsers','addUsersToQueue','waitForUsers','getRooms','addRoomsToQueue','waitForRooms','commit1','global','commit2','incrementGameTime','notifyRoomsDone','custom','finish']){engine.emit('mainLoopStage',stage,[]);if(stage==='custom')await engine.mainLoopCustomStage();}})();
  await sleep(80);assert.equal(calls,0);await client.step();await cycle;assert.equal(calls,1);
  await assert.rejects(client.step({timeoutMs:60}),/deadline/);await assert.rejects(StepClient.connect(root),/poisoned/);
  console.log('offline integrity, lease, epoch and timeout checks passed');
 } finally {for(const p of children)p.kill();process.chdir(old);fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
