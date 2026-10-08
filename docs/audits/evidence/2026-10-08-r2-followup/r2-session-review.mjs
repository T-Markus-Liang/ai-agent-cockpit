import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ControlPlaneStore } from '/tmp/personal-ai-os-review-r2-followup.Kw3IZt/input/control-plane/store.mjs';
import { acpPermissionPlan } from '/tmp/personal-ai-os-review-r2-followup.Kw3IZt/input/control-plane/acp-permission-broker.mjs';
import { createSessionPermissionBroker } from '/tmp/personal-ai-os-review-r2-followup.Kw3IZt/input/control-plane/session-permission-broker.mjs';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const flat=label=>({toolCallId:'synthetic-call',tool:{kind:'read'},rawInput:{path:label},options:[{kind:'allow_once',optionId:'once'}]});
const out=[];const operator={id:'synthetic-operator',role:'operator',authenticated:true};
async function scope(run){const dir=await fs.mkdtemp(path.join(process.cwd(),'r2-session-'));try{
 const store=new ControlPlaneStore({stateDir:path.join(dir,'state')});const t=await store.createTask({goal:'synthetic'},{idempotencyKey:'t'});const e=await store.createExecution(t.task.id,{workerId:'synthetic'},{idempotencyKey:'e'});
 const binding={ownerId:'u',source:'codex',accountId:'a',profileId:'p',nativeSessionId:'n',cwd:dir,taskId:t.task.id,executionId:e.execution.id};
 await store.attachExecutionRef(e.execution.id,{engine:'native-acp',id:'n',...binding},{idempotencyKey:'ref'});await store.updateExecutionStatus(e.execution.id,{status:'running'},{idempotencyKey:'run'});let n=0;
 const approve=async req=>{const plan=acpPermissionPlan(binding,{sessionId:'n',toolCall:{toolCallId:req.toolCallId,kind:req.tool.kind,rawInput:req.rawInput},options:req.options});const a=await store.createApproval({action:plan.action,target:plan.target,parametersDigest:plan.parametersDigest,expiresAt:new Date(Date.now()+60000).toISOString()},{idempotencyKey:'a'+(++n)});await store.decideApproval(a.approval.id,{decision:'approved',approvedBy:operator.id},{idempotencyKey:'d'+n,principal:operator});return a.approval.id;};
 await run({store,binding,approve});
}finally{await fs.rm(dir,{recursive:true,force:true});}}
await scope(async({store,binding,approve})=>{
 const req=flat('closed');const id=await approve(req);const entered=defer(),gate=defer();const b=createSessionPermissionBroker({store,findApprovalId:async()=>{entered.resolve();await gate.promise;return id;}});const{sessionId}=b.registerSession(binding);
 const pending=b.handlePermissionRequest({sessionId,...req});await entered.promise;b.closeSession(sessionId);gate.resolve();const r=await pending;
 assert.equal(r.outcome,'denied');assert.equal(r.reason,'session-closed');assert.equal((await store.getApproval(id)).usedAt,undefined);
 out.push({probe:'SP-F001-r2-resolver-window',outcome:r.outcome,reason:r.reason,approvalUnconsumed:true});
});
await scope(async({store,binding,approve})=>{
 const first=flat('first'),second=flat('second');const a=await approve(first),c=await approve(second);const entered=defer(),gate=defer();let calls=0;
 const b=createSessionPermissionBroker({store,findApprovalId:async()=>{calls++;entered.resolve();await gate.promise;return a;}});const{sessionId}=b.registerSession(binding);
 const one=b.handlePermissionRequest({sessionId,...first});await entered.promise;const two=await b.handlePermissionRequest({sessionId,...second});gate.resolve();const r=await one;
 assert.equal(two.reason,'conflict');assert.equal(r.outcome,'allow_once');assert.equal(calls,1);assert.ok((await store.getApproval(a)).usedAt);assert.equal((await store.getApproval(c)).usedAt,undefined);
 out.push({probe:'SP-F002-r2',secondReason:two.reason,allowResponses:1,resolverCalls:1,unusedSecondApproval:true});
});
console.log(JSON.stringify({realModels:false,productionTouched:false,observations:out}));
