'use strict';

const fs = require('fs');
const path = require('path');
const {setTimeout: sleep} = require('timers/promises');
const crypto=require('crypto');
const integrity=require('./step-integrity');

// One controller, fresh isolated server only. A timeout or disconnect means
// UNKNOWN and requires destroying the instance; commands must never be retried.
class StepClient {
  constructor(root, ready, token, baseline) { this.root = root; this.dir = path.join(root, 'step-control'); this.ready = ready; this.token=token; this.baseline=baseline; this.sequence = 0; this.failed = false; this.busy = false; }
  static async connect(root, {timeoutMs = 10000} = {}) {
    const ready = await waitJson(path.join(root, 'step-control', 'ready.json'), timeoutMs);
    const owner = JSON.parse(fs.readFileSync(path.join(root, 'ownership.json'), 'utf8'));
    if (owner.root !== root || owner.runId !== ready.runId || ready.protocol !== 1 || !ready.session) throw Error('gate identity mismatch');
    integrity.verifyManifest();
    let baseline; const deadline=Date.now()+timeoutMs;
    while (!baseline && Date.now()<deadline) {
      try { baseline=integrity.participants(root); } catch(error) { if(error.code!=='ENOENT') throw error; await sleep(20); }
    }
    if(!baseline) throw Error('UNKNOWN: missing participant');
    const dir=path.join(root,'step-control'), token=crypto.randomBytes(24).toString('hex');
    if(fs.existsSync(path.join(dir,'poisoned.json'))) throw Error('UNKNOWN: poisoned environment');
    fs.writeFileSync(path.join(dir,'controller.json'),JSON.stringify({token,session:ready.session,pid:process.pid}),{flag:'wx',mode:0o600});
    return new StepClient(root, ready, token, baseline);
  }
  async step({timeoutMs = 10000} = {}) {
    if (this.failed || this.busy) throw Error('controller unavailable');
    this.busy = true;
    const sequence = ++this.sequence;
    try {
      integrity.verifyManifest(); integrity.participants(this.root,this.baseline);
      const lease=JSON.parse(fs.readFileSync(path.join(this.dir,'controller.json'),'utf8'));
      if(lease.token!==this.token || lease.session!==this.ready.session || fs.existsSync(path.join(this.dir,'poisoned.json'))) throw Error('UNKNOWN: controller lease lost');
      const file = path.join(this.dir, `command-${sequence}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({session: this.ready.session, token:this.token, sequence, action: 'step'}), {flag: 'wx', mode: 0o600});
      // hard-link supplies atomic publication and refuses a pre-existing command
      fs.linkSync(tmp, file); fs.unlinkSync(tmp);
      const ack = await waitJson(path.join(this.dir, `ack-${sequence}.json`), timeoutMs);
      integrity.verifyManifest(); integrity.participants(this.root,this.baseline);
      if (ack.session !== this.ready.session || ack.token !== this.token || ack.sequence !== sequence || ack.status !== 'cycle-finished-unverified') throw Error('invalid or incomplete cycle');
      return ack;
    } catch (error) { this.failed = true; try { fs.writeFileSync(path.join(this.dir,'poisoned.json'),JSON.stringify({token:this.token,reason:String(error)}),{flag:'wx',mode:0o600}); } catch {} throw error; }
    finally { this.busy = false; }
  }
}
async function waitJson(file, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('invalid timeout');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  throw Error(`UNKNOWN: deadline waiting for ${path.basename(file)}`);
}
module.exports = {StepClient};
