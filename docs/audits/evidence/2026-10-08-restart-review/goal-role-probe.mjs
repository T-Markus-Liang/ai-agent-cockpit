import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGoalServer } from '/Users/markus/ai-agent-cockpit/gateway/goals.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'restart-goal-role-'));
const root=path.join(dir,'goals');
const authFile=path.join(root,'authority.json');
const oldOverride=process.env.GOALS_AUTH_FILE;
process.env.GOALS_AUTH_FILE=authFile;
let fakeMutationCalls=0;
const goals={stateDir:root,list:async()=>[],isPaused:async()=>false,
  controlAll:async action=>{fakeMutationCalls++;return{action,synthetic:true};}};
const runtime={active:new Map(),start:async()=>{},stop:async()=>{},tick:async()=>{},abort(){}};
const token=crypto.randomBytes(32).toString('base64url');
const wechatFile=path.join(dir,'wechat.json');
await fs.writeFile(wechatFile,JSON.stringify({lastActiveUserId:'TESTONLY-user',users:{'TESTONLY-user':{}}}),{mode:0o600});
let app;
try {
  app=await createGoalServer({goals,tasks:{},runtime,wechatStateFile:wechatFile});
  await fs.writeFile(authFile,JSON.stringify({version:1,principals:[{id:'TESTONLY-viewer',role:'viewer',tokenDigest:crypto.createHash('sha256').update(token).digest('hex')}]}),{mode:0o600});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const observations=[];
  for(const explicitActor of [false,true]) {
    const before=fakeMutationCalls;
    const response=await fetch(url+'/api/goals/pause-all',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(explicitActor?{'X-Goal-Actor':'local'}:{})},body:'{}',signal:AbortSignal.timeout(2000)});
    await response.arrayBuffer();
    observations.push({role:'viewer',actorHeader:explicitActor?'local':'omitted',expectedStatus:403,actualStatus:response.status,fakeMutationCalls:fakeMutationCalls-before});
  }
  console.log(JSON.stringify({syntheticOnly:true,productionWrites:0,modelCalls:0,realGoalsTouched:0,observations},null,2));
} finally {
  if(app){app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}
  if(oldOverride===undefined)delete process.env.GOALS_AUTH_FILE;else process.env.GOALS_AUTH_FILE=oldOverride;
  await fs.rm(dir,{recursive:true,force:true});
}

