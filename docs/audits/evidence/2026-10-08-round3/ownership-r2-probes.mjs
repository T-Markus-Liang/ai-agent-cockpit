import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createModels,fauxProvider,fauxAssistantMessage } from '/tmp/personal-ai-os-review-round3.ClxFrw/input/node_modules/@earendil-works/pi-ai/dist/index.js';
import { BACKGROUND_CONTEXT,withCancel } from '/tmp/personal-ai-os-review-round3.ClxFrw/input/node_modules/@earendil-works/chord/dist/context/index.js';
import { PiRuntimeAdapter } from '/tmp/personal-ai-os-review-round3.ClxFrw/input/runtime/pi-adapter.mjs';
import { openOwnedSqliteStorage } from '/tmp/personal-ai-os-review-round3.ClxFrw/input/runtime/owner-sqlite.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const req=(id,ownership)=>({ownerId:'synthetic-owner',sourceRequestId:id,content:'synthetic only',productTaskId:'synthetic-task',executionId:ownership?.executionId??'synthetic-execution',profileId:'synthetic-profile',authorizationDigest:'synthetic-reference',ownership});
async function until(f){const end=Date.now()+2000;while(!await f()){if(Date.now()>end)throw Error('audit fixture timeout');await sleep(5);}}
async function scope(run){const dir=await fs.mkdtemp(path.join(process.cwd(),'ownership-r2-'));try{await run(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
async function open(dir,faux,settings={}){const models=createModels();models.setProvider(faux.provider);const owned=await openOwnedSqliteStorage(path.join(dir,'runtime.sqlite'));return PiRuntimeAdapter.open(owned,{models,modelRef:{provider:'faux',modelId:'faux-1'},settings});}
const out=[];

await scope(async dir=>{
 const faux=fauxProvider({tokensPerSecond:80});faux.setResponses([fauxAssistantMessage('x'.repeat(6000)),fauxAssistantMessage('synthetic background done')]);
 const a=await open(dir,faux);
 try {
  const fg=await a.submit(req('fg',{kind:'foreground'}));await until(()=>faux.state.callCount===1);
  const bg=await a.submit(req('bg',{kind:'background',executionId:'synthetic-execution'}));
  const result=await a.abort({kind:'conversation',conversationId:fg.conversationId});
  assert.notEqual(result,'aborted');assert.equal((await a.observe(bg.submissionId)).status,'stalled');
  const {context,cancel}=withCancel(BACKGROUND_CONTEXT);const timer=setTimeout(cancel,300);let timeout=false;
  try{await a.wait(bg.submissionId,context);}catch{timeout=true;}finally{clearTimeout(timer);}
  const recovered=await a.recover();
  assert.ok(recovered.stalled.some(x=>x.submissionId===bg.submissionId));assert.equal(timeout,true);assert.equal(faux.state.callCount,1);
  out.push({probe:'F001-r2',returnResult:result.result,status:'stalled',durableRecoveryReportsStalled:true,backgroundStillNotAdvanced:true,modelCalls:1});
 } finally {await a.close();}
});

await scope(async dir=>{
 let releaseSeed,releaseMixed;const seedGate=new Promise(r=>releaseSeed=r),mixedGate=new Promise(r=>releaseMixed=r);
 const faux=fauxProvider();faux.setResponses([async()=>{await seedGate;return fauxAssistantMessage('seed');},async()=>{await mixedGate;return fauxAssistantMessage('mixed');}]);
 const a=await open(dir,faux,{followUpMode:'all'});
 try {
  const seed=await a.submit(req('seed',{kind:'background',executionId:'seed-execution'}));await until(()=>faux.state.callCount===1);
  const fg=await a.submit(req('mixed-fg',{kind:'foreground'}));const bg=await a.submit(req('mixed-bg',{kind:'background',executionId:'synthetic-execution'}));
  releaseSeed();await a.wait(seed.submissionId);await until(()=>faux.state.callCount===2);
  const result=await a.abort({kind:'conversation',conversationId:fg.conversationId});
  assert.equal(result.result,'unsupported');assert.equal((await a.observe(fg.submissionId)).status,'placed');
  releaseMixed();assert.equal((await a.wait(fg.submissionId)).status,'done');assert.equal((await a.wait(bg.submissionId)).status,'done');
  out.push({probe:'F002-r2',returnResult:result.result,noFalseAborted:true,foregroundEventually:'done',backgroundEventually:'done',preciseCancellationStillUnavailable:true});
 } finally {releaseSeed();releaseMixed();await a.close();}
});

await scope(async dir=>{
 const faux=fauxProvider({tokensPerSecond:80});faux.setResponses([fauxAssistantMessage('x'.repeat(6000))]);const a=await open(dir,faux);
 try {
  const missing=req('missing',{kind:'background'});delete missing.executionId;
  await assert.rejects(a.submit(missing),e=>e.code==='missing-execution-binding');
  const mismatch={...req('mismatch',{kind:'background',executionId:'nested'}),executionId:'different-top'};
  await assert.rejects(a.submit(mismatch),e=>e.code==='ownership-execution-conflict');
  assert.equal(faux.state.callCount,0);assert.equal((await a.observe()).requests.length,0);
  const bg=await a.submit(req('top-only',{kind:'background'}));await until(()=>faux.state.callCount===1);
  const result=await a.abort({kind:'execution',executionId:'synthetic-execution'});
  assert.equal(result,'aborted');assert.equal((await a.observe(bg.submissionId)).status,'unanswered');
  out.push({probe:'F003-r2',invalidAdmissionCreatesZeroRequests:true,invalidAdmissionCallsZeroModels:true,topBindingNormalized:true,executionCancellation:'aborted'});
 } finally {await a.close();}
});
console.log(JSON.stringify({realModels:false,productionTouched:false,observations:out}));
