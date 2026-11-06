'use strict';
// Empty-world exploratory probe, not admission for snapshots or user actions.
const path = require('path');
const fs = require('fs');
const {createIsolatedServer} = require('./instance');
const {StepClient} = require('./step-client');
const {ScreepsCLI} = require('../cli-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const runId = `step-${Date.now()}-${process.pid}`;
  const server = await createIsolatedServer({runId, httpPort: 32175, cliPort: 32176, mods:[path.join(__dirname,'step-mod.js')], preload:path.join(__dirname,'step-preload.js')});
  let cli, failure;
  try {
    await server.start(); await server.assertIdentity();
    if (!fs.existsSync(path.join(server.root,'step-backend-cron-disabled.json'))) throw Error('backend cron disable marker missing');
    const gate = await StepClient.connect(server.root, {timeoutMs:15000});
    cli = new ScreepsCLI(server.cliOptions.host, server.cliOptions.port); await cli.connect();
    const time = () => cli.eval("storage.env.get('gameTime')", 5000);
    const before = Number(await time()); await sleep(6500); const zero = Number(await time());
    if (!Number.isFinite(before) || zero !== before) throw Error(`zero-step time mismatch: ${before}, ${zero}`);
    const room=await cli.eval("storage.db['rooms.objects'].findOne({type:'controller'}).then(x=>x.room)",5000);
    const results=[];
    for (let i=0;i<3;i++) {
      // Neutral rooms do not reactivate themselves; seed input before the step.
      await cli.eval(`storage.env.sadd('activeRooms',${JSON.stringify(room)})`,5000);
      const ack=await gate.step({timeoutMs:15000}); const now=Number(await time());
      if(now !== before+i+1) throw Error(`unexpected time ${now}`);
      results.push({sequence:ack.sequence,time:now,stages:ack.stages});
      if (i === 0) { await sleep(6500); if (Number(await time()) !== now) throw Error('time advanced during hold'); }
    }
    const mainLog=fs.readFileSync(path.join(server.root,'logs','engine_main.log'),'utf8');
    if (fs.readFileSync(path.join(server.root,'logs','backend.log'),'utf8').includes('Running cronjob')) throw Error('unexpected backend cron execution');
    if (mainLog.includes('Main loop reset!')) throw Error('main loop reset during hold');
    console.log(JSON.stringify({status:'experimental-only',runId,before,zero,results}));
  } catch (error) { failure=error; }
  finally {
    if (cli) cli.close();
    try { await server.stop(); if (!failure) await server.destroy(); else console.error(`quarantined artifacts: ${server.root}`); }
    catch (error) { failure=Error(`${failure ? failure.message+'; ' : ''}cleanup failed: ${error.message}`); }
  }
  if(failure) throw failure;
})().catch(error => {console.error(error); process.exitCode=1;});
