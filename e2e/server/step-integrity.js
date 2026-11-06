'use strict';
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const MANIFEST=path.join(__dirname,'step-manifest.json');
const EXPECTED='de067ee781813c65105068e9910b897316347cf92a7dadc256df5f7e238adab9';
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function verifyDigest(bytes, expected) { if(hash(bytes)!==expected) throw Error('UNKNOWN: manifest drift'); }
function verifyManifest() {
  const bytes=fs.readFileSync(MANIFEST);
  verifyDigest(bytes,EXPECTED);
  const manifest=JSON.parse(bytes);
  for(const [name, expected] of Object.entries(manifest.files)) {
    if(hash(fs.readFileSync(path.join(manifest.base,name)))!==expected) throw Error(`UNKNOWN: dependency drift ${name}`);
  }
  return manifest;
}
function epoch(pid) {
  const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
  const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  if(fields[0]==='Z') throw Error('dead participant');
  return {pid, start:fields[19], boot:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
}
function register(root,type) {
  const record={type,...epoch(process.pid)};
  try {fs.writeFileSync(path.join(root,`step-participant-${type}.json`),JSON.stringify(record),{flag:'wx',mode:0o600});}
  catch(error) {console.error('participant registration failure:',error.message);process.exit(78);}
}
function participants(root,baseline) {
  const actual=['main','runner','processor'].map(type=>{
    const x=JSON.parse(fs.readFileSync(path.join(root,`step-participant-${type}.json`),'utf8'));
    const current=epoch(x.pid);
    if(x.type!==type || x.start!==current.start || x.boot!==current.boot) throw Error(`UNKNOWN: ${type} epoch changed`);
    return x;
  });
  if(new Set(actual.map(x=>x.pid)).size!==3) throw Error('UNKNOWN: invalid topology');
  if(baseline && JSON.stringify(actual)!==JSON.stringify(baseline)) throw Error('UNKNOWN: participant changed');
  return actual;
}
module.exports={verifyManifest,verifyDigest,epoch,register,participants};
