import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createModels, fauxProvider, fauxAssistantMessage } from '/tmp/personal-ai-os-review-r1.bgwgKU/input/node_modules/@earendil-works/pi-ai/dist/index.js';
import { BACKGROUND_CONTEXT, withCancel } from '/tmp/personal-ai-os-review-r1.bgwgKU/input/node_modules/@earendil-works/chord/dist/context/index.js';
import { PiRuntimeAdapter } from '/tmp/personal-ai-os-review-r1.bgwgKU/input/runtime/pi-adapter.mjs';
import { openOwnedSqliteStorage } from '/tmp/personal-ai-os-review-r1.bgwgKU/input/runtime/owner-sqlite.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const req=(id,ownership)=>({ownerId:'synthetic-owner',sourceRequestId:id,content:'synthetic only',productTaskId:'synthetic-product',executionId:'synthetic-execution',profileId:'synthetic-profile',authorizationDigest:'reference-not-authority',ownership});
async function until(test){const end=Date.now()+2000;while(!await test()){if(Date.now()>end)throw new Error('audit fixture deadline');await sleep(10);}}
async function scope(run){const dir=await fs.mkdtemp(path.join(process.cwd(),'audit-m02-'));try{return await run(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
async function open(dir,faux,settings={}){const models=createModels();models.setProvider(faux.provider);const owned=await openOwnedSqliteStorage(path.join(dir,'runtime.sqlite'));return PiRuntimeAdapter.open(owned,{models,modelRef:{provider:'faux',modelId:'faux-1'},settings});}
const out=[];

await scope(async dir=>{
  const faux=fauxProvider({tokensPerSecond:80});faux.setResponses([fauxAssistantMessage('x'.repeat(6000)),fauxAssistantMessage('background done')]);
  const adapter=await open(dir,faux);
  try {
    const foreground=await adapter.submit(req('fg-active',{kind:'foreground'}));await until(()=>faux.state.callCount===1);
    const background=await adapter.submit(req('bg-queued',{kind:'background',executionId:'synthetic-execution'}));
    assert.equal((await adapter.observe(background.submissionId)).status,'queued');
    const result=await adapter.abort({kind:'conversation',conversationId:foreground.conversationId});
    const {context,cancel}=withCancel(BACKGROUND_CONTEXT);const timer=setTimeout(()=>cancel(),500);
    let waitTimedOut=false;try{await adapter.wait(background.submissionId,context);}catch{waitTimedOut=true;}finally{clearTimeout(timer);}
    const bgStatus=(await adapter.observe(background.submissionId)).status;
    assert.equal(bgStatus,'queued');assert.equal(faux.state.callCount,1);assert.equal(waitTimedOut,true);
    out.push({probe:'queued-background-after-foreground-stop',abortResult:result,foreground:(await adapter.observe(foreground.submissionId)).status,background:bgStatus,backgroundWaitTimedOut:waitTimedOut,modelCalls:faux.state.callCount});
  } finally {await adapter.close();}
});

await scope(async dir=>{
  let releaseSeed,releaseMixed;const seedGate=new Promise(r=>releaseSeed=r),mixedGate=new Promise(r=>releaseMixed=r);
  const faux=fauxProvider();faux.setResponses([async()=>{await seedGate;return fauxAssistantMessage('seed done');},async()=>{await mixedGate;return fauxAssistantMessage('mixed done');}]);
  const adapter=await open(dir,faux,{followUpMode:'all'});
  try {
    const seed=await adapter.submit(req('seed',{kind:'background',executionId:'seed-execution'}));await until(()=>faux.state.callCount===1);
    const foreground=await adapter.submit(req('mixed-fg',{kind:'foreground'}));
    const background=await adapter.submit(req('mixed-bg',{kind:'background',executionId:'synthetic-execution'}));
    releaseSeed();await adapter.wait(seed.submissionId);await until(()=>faux.state.callCount===2);
    assert.equal((await adapter.observe(foreground.submissionId)).status,'placed');assert.equal((await adapter.observe(background.submissionId)).status,'placed');
    const result=await adapter.abort({kind:'conversation',conversationId:foreground.conversationId});
    const fgAfter=(await adapter.observe(foreground.submissionId)).status;
    assert.equal(result,'aborted');assert.equal(fgAfter,'placed');
    releaseMixed();const settled=await adapter.wait(foreground.submissionId);
    assert.equal(settled.status,'done');
    out.push({probe:'mixed-run-foreground-stop',abortResult:result,foregroundAfterAbort:fgAfter,foregroundEventually:settled.status,backgroundEventually:(await adapter.wait(background.submissionId)).status});
  } finally {releaseSeed();releaseMixed();await adapter.close();}
});

await scope(async dir=>{
  let release;const gate=new Promise(r=>release=r);const faux=fauxProvider();faux.setResponses([async()=>{await gate;return fauxAssistantMessage('unbound done');}]);
  const adapter=await open(dir,faux);
  try {
    const sub=await adapter.submit(req('unbound-background',{kind:'background'}));await until(()=>faux.state.callCount===1);
    let executionError;try{await adapter.abort({kind:'execution',executionId:'synthetic-execution'});}catch(error){executionError=error.code;}
    const submissionAbort=await adapter.abort({kind:'submission',submissionId:sub.submissionId});
    const conversationAbort=await adapter.abort({kind:'conversation',conversationId:sub.conversationId});
    assert.equal(executionError,'unknown-execution');assert.equal(submissionAbort,'already_placed');assert.equal((await adapter.observe(sub.submissionId)).status,'placed');
    out.push({probe:'background-without-execution-id',admitted:true,executionError,submissionAbort,conversationAbort,stillRunning:(await adapter.observe(sub.submissionId)).status});
    release();await adapter.wait(sub.submissionId);
  } finally {release();await adapter.close();}
});

console.log(JSON.stringify({source:'frozen-M02-r1',realModels:false,productionTouched:false,observations:out}));
