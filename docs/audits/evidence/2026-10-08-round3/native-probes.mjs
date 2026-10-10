// Controlled OS canaries. Parent uses only this staged source, system binaries
// and directories it creates. Seatbelt applies to children, not twice to parent.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildSandboxProfile, sandboxEnv, wrapWithSandbox } from '/tmp/personal-ai-os-review-round3.ClxFrw/input/control-plane/native-sandbox.mjs';

const run=(command,args,spec)=>new Promise((resolve,reject)=>{
  const wrapped=wrapWithSandbox(command,args,spec);
  const child=spawn(wrapped.command,wrapped.args,{cwd:'/',env:sandboxEnv(),stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
});
const dir=await fs.mkdtemp(path.join(process.cwd(),'audit-native-'));
let unlisted,server;const out=[];
try {
  const echo=await run('/bin/echo',['synthetic-ok'],{execLiterals:['/bin/echo']});
  assert.equal(echo.code,0,echo.stderr);
  const privateFile=path.join(dir,'private.txt');await fs.writeFile(privateFile,'synthetic-private');
  const blocked=await run('/bin/cat',[privateFile],{execLiterals:['/bin/cat']});
  const allowed=await run('/bin/cat',[privateFile],{execLiterals:['/bin/cat'],readLiterals:[privateFile]});
  assert.notEqual(blocked.code,0,blocked.stderr);assert.equal(allowed.code,0,allowed.stderr);assert.equal(allowed.stdout,'synthetic-private');
  out.push({probe:'private-read-control',deniedCode:blocked.code,allowedCode:allowed.code,positiveMatches:true});

  const ws=path.join(dir,'workspace');await fs.mkdir(ws);const link=path.join(ws,'alias.txt');await fs.symlink(privateFile,link);
  const linked=await run('/bin/cat',[link],{execLiterals:['/bin/cat'],workspaceDir:ws});
  out.push({probe:'workspace-symlink-read',exit:linked.code,outsideSyntheticContentReadable:linked.stdout==='synthetic-private'});

  const writeAllowed=path.join(dir,'write.txt'),writeDenied=path.join(dir,'not-granted.txt');
  const w1=await run('/bin/sh',['-c','printf synthetic > '+writeAllowed],{execLiterals:['/bin/sh','/bin/bash'],writeLiterals:[writeAllowed]});
  const w2=await run('/bin/sh',['-c','printf synthetic > '+writeDenied],{execLiterals:['/bin/sh','/bin/bash']});
  assert.equal(w1.code,0,w1.stderr);assert.equal(await fs.readFile(writeAllowed,'utf8'),'synthetic');assert.notEqual(w2.code,0);
  await assert.rejects(fs.stat(writeDenied),e=>e.code==='ENOENT');
  out.push({probe:'write-controls',allowedCode:w1.code,deniedCode:w2.code,ungrantedFileAbsent:true});

  const nonce=crypto.randomBytes(16).toString('hex');let requests=0;
  server=http.createServer((request,response)=>{requests++;response.writeHead(200);response.end(nonce);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url='http://127.0.0.1:'+server.address().port+'/synthetic-'+nonce;
  const netAllowed=await run('/usr/bin/curl',['-q','--max-time','2','-s','--noproxy','*',url],{execLiterals:['/usr/bin/curl'],denyNetwork:false});
  assert.equal(netAllowed.code,0,netAllowed.stderr);assert.equal(netAllowed.stdout,nonce);
  const before=requests;const netDenied=await run('/usr/bin/curl',['-q','--max-time','2','-s','--noproxy','*',url],{execLiterals:['/usr/bin/curl']});
  assert.notEqual(netDenied.code,0);assert.equal(requests,before);
  out.push({probe:'owned-ephemeral-network-control',allowedCode:netAllowed.code,deniedCode:netDenied.code,nonceMatches:true,deniedRequestNeverArrived:true,foreignPortUsed:false});

  unlisted=await fs.mkdtemp('/var/tmp/personal-ai-os-audit-native-');
  const file=path.join(unlisted,'synthetic-only.txt');await fs.writeFile(file,'synthetic-unlisted-private');
  const read=await run('/bin/cat',[file],{execLiterals:['/bin/cat']});
  assert.equal(read.code,0,read.stderr);assert.equal(read.stdout,'synthetic-unlisted-private');
  out.push({probe:'unlisted-private-temp-readable',exit:read.code,readWithoutGrant:true,pathClass:'/private/var/tmp (only own synthetic fixture)'});

  const malformed=buildSandboxProfile({execLiterals:['/bin/echo'],denyNetwork:0});
  assert.equal(malformed.includes('(deny network*)'),false);
  out.push({probe:'malformed-network-option',nonBooleanAccepted:true,networkDenyOmitted:true});
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  if(unlisted)await fs.rm(unlisted,{recursive:true,force:true});
  await fs.rm(dir,{recursive:true,force:true});
}
console.log(JSON.stringify({realModels:false,productionTouched:false,observations:out}));
