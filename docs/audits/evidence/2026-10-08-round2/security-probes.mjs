import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPairingAuthority, PRINCIPAL_TTL_MS } from '/tmp/personal-ai-os-review-r2.339QYo/input/control-plane/identity-pairing.mjs';
import { createRequestAuthority } from '/tmp/personal-ai-os-review-r2.339QYo/input/control-plane/request-authority.mjs';
import { createSessionPermissionBroker } from '/tmp/personal-ai-os-review-r2.339QYo/input/control-plane/session-permission-broker.mjs';
import { acpPermissionPlan } from '/tmp/personal-ai-os-review-r2.339QYo/input/control-plane/acp-permission-broker.mjs';
import { ControlPlaneStore } from '/tmp/personal-ai-os-review-r2.339QYo/input/control-plane/store.mjs';

const out=[];
const bounded=async promise=>{
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic audit deadline')),2000);})]);}
  finally {clearTimeout(timer);}
};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const OPERATOR={id:'synthetic-audit-operator',role:'operator',authenticated:true};
const flat=(label)=>({toolCallId:'synthetic-call',tool:{kind:'read'},rawInput:{path:label},options:[{kind:'allow_once',optionId:'once',name:'once'}]});
async function fixture(run){
  const dir=await fs.mkdtemp(path.join(process.cwd(),'audit-session-'));
  try {
    const store=new ControlPlaneStore({stateDir:path.join(dir,'state')});
    const task=await store.createTask({goal:'synthetic audit scope'},{idempotencyKey:'task'});
    const exec=await store.createExecution(task.task.id,{workerId:'synthetic-worker'},{idempotencyKey:'execution'});
    const binding={ownerId:'synthetic-owner',source:'codex',accountId:'synthetic-account',profileId:'synthetic-profile',nativeSessionId:'synthetic-session',cwd:dir,taskId:task.task.id,executionId:exec.execution.id};
    await store.attachExecutionRef(exec.execution.id,{engine:'native-acp',id:'synthetic-session',...binding},{idempotencyKey:'binding'});
    await store.updateExecutionStatus(exec.execution.id,{status:'running'},{idempotencyKey:'running'});
    let n=0;
    async function approval(request){
      const params={sessionId:binding.nativeSessionId,toolCall:{toolCallId:request.toolCallId,kind:request.tool.kind,rawInput:request.rawInput},options:request.options};
      const plan=acpPermissionPlan(binding,params);
      const created=await store.createApproval({action:plan.action,target:plan.target,parametersDigest:plan.parametersDigest,expiresAt:new Date(Date.now()+60000).toISOString()},{idempotencyKey:'approval-'+(++n)});
      await store.decideApproval(created.approval.id,{decision:'approved',approvedBy:OPERATOR.id},{idempotencyKey:'decision-'+n,principal:OPERATOR});
      return created.approval.id;
    }
    await run({store,binding,approval});
  } finally {await fs.rm(dir,{recursive:true,force:true});}
}

await fixture(async({store,binding,approval})=>{
  const request=flat('synthetic-close.txt');
  const approvalId=await approval(request);
  const entered=deferred(), gate=deferred();
  const broker=createSessionPermissionBroker({store,findApprovalId:async()=>{entered.resolve();await gate.promise;return approvalId;}});
  const {sessionId}=broker.registerSession(binding);
  const pending=broker.handlePermissionRequest({sessionId,...request});
  try {
    await bounded(entered.promise);
    broker.closeSession(sessionId);
    gate.resolve();
    const result=await bounded(pending);
    assert.equal(result.outcome,'allow_once');
    assert.equal(broker.toJSON().sessions[0].closed,true);
    assert.ok((await store.getApproval(approvalId)).usedAt);
    out.push({probe:'close-session-during-approval',closed:true,result:result.outcome,approvalConsumedAfterClose:true});
  } finally {gate.resolve();await pending;}
});

await fixture(async({store,binding,approval})=>{
  const first=flat('synthetic-first.txt'),second=flat('synthetic-second.txt');
  const a=await approval(first),b=await approval(second);
  const entered=deferred(),gate=deferred();let arrivals=0;
  const broker=createSessionPermissionBroker({store,findApprovalId:async plan=>{if(++arrivals===2)entered.resolve();await gate.promise;return plan.parameters.toolCall.rawInput.path===first.rawInput.path?a:b;}});
  const {sessionId}=broker.registerSession(binding);
  const pending=Promise.all([broker.handlePermissionRequest({sessionId,...first}),broker.handlePermissionRequest({sessionId,...second})]);
  try {
    await bounded(entered.promise);gate.resolve();
    const results=await bounded(pending);
    assert.deepEqual(results.map(r=>r.outcome),['allow_once','allow_once']);
    assert.ok((await store.getApproval(a)).usedAt);assert.ok((await store.getApproval(b)).usedAt);
    out.push({probe:'concurrent-same-tool-call-id',sameSession:true,sameToolCallId:true,differentParameters:true,allowResponses:2,consumedApprovals:2});
  } finally {gate.resolve();await pending;}
});

let now=1700000000000;
const pairing=createPairingAuthority({now:()=>now});
const {pairingCode}=pairing.beginPairing({role:'viewer',clientLabel:'synthetic-client'});
const {principalId,token}=pairing.completePairing(pairingCode);
const exported=createRequestAuthority(pairing.exportPrincipals());
const rotated=pairing.rotate(principalId).token;
assert.equal(pairing.authenticate(token),undefined);
assert.equal(exported.authenticate({authorization:'Bearer '+token}).role,'viewer');
const rotatedExport=createRequestAuthority(pairing.exportPrincipals());
pairing.revoke(principalId);
assert.equal(pairing.authenticate(rotated),undefined);
assert.equal(rotatedExport.authenticate({authorization:'Bearer '+rotated}).role,'viewer');
const p2=createPairingAuthority({now:()=>now});
const code2=p2.beginPairing({role:'viewer'}).pairingCode;
const token2=p2.completePairing(code2).token;
const expiryExport=createRequestAuthority(p2.exportPrincipals());
now+=PRINCIPAL_TTL_MS+1;
assert.equal(p2.authenticate(token2),undefined);
assert.equal(expiryExport.authenticate({authorization:'Bearer '+token2}).role,'viewer');
out.push({probe:'exported-http-authority-lifecycle',directAuthorityRejects:true,httpAcceptsOldAfterRotate:true,httpAcceptsAfterRevoke:true,httpAcceptsAfterExpiry:true,productionWiringTested:false});

console.log(JSON.stringify({frozenReview:'r2-new-batches-r1',realModels:false,productionTouched:false,observations:out}));
