import assert from 'node:assert/strict';
import { createFallbackPolicy } from '/tmp/personal-ai-os-review-round3.ClxFrw/input/runtime/fallback-policy.mjs';
import { createBudgetPolicy } from '/tmp/personal-ai-os-review-round3.ClxFrw/input/runtime/budget-policy.mjs';
import { assembleContext } from '/tmp/personal-ai-os-review-round3.ClxFrw/input/runtime/context-assembler.mjs';

const chain=[{ref:'synthetic/primary',provider:'synthetic',modelId:'primary'},{ref:'synthetic/backup',provider:'synthetic',modelId:'backup'}];
const policy=createFallbackPolicy({chain,now:()=>100});
const dirty=[];
for(const kind of ['protocol_error','rate_limit','startup_error']){
  const failure={kind,hasProducedMessage:true,hasUsedTools:true};
  const classification=policy.classifyFailure(failure);
  const result=policy.nextAttempt('synthetic-'+kind,failure);
  assert.equal(classification.eligible,true);assert.equal(result.action,'fallback');
  dirty.push({kind,eligible:classification.eligible,action:result.action});
}

const original={turns:[{role:'user',text:'synthetic original'}],sourceTime:new Date(1234)};
const copied=policy.buildFallbackContext({originalContext:original,fromRef:chain[0].ref,toRef:chain[1].ref,attempt:1});
assert.deepEqual(copied.sourceTime,{});
assert.equal(Object.isFrozen(copied),true);assert.equal(Object.isFrozen(copied.turns[0]),false);
copied.turns[0].text='synthetic changed after provenance';
assert.equal(original.turns[0].text,'synthetic original');

const assembled=assembleContext({facts:Array.from({length:64},()=>({text:'x'.repeat(1024),source:'s'.repeat(2048)}))});
const factBlock=assembled.blocks.find(b=>b.kind==='facts').text;
assert.ok(factBlock.length>190000);assert.deepEqual(assembled.meta.truncated,[]);

let budgetClock=100;
const budget=createBudgetPolicy({now:()=>budgetClock});
budget.grant({scopeKey:'synthetic-clock',maxTokens:10,maxDurationMs:1000,maxCalls:2});
budgetClock=NaN; // fault AFTER a valid grant, not an initially malformed grant
const remaining=budget.assertActive('synthetic-clock');
budget.charge('synthetic-clock',{tokens:1,calls:1});
assert.ok(Number.isNaN(remaining.remainingMs));
assert.equal(budget.toJSON().grants[0].chargedCalls,1);

console.log(JSON.stringify({realModels:false,productionTouched:false,observations:[
 {probe:'dirty-failure-still-falls-back',cases:dirty,missingProtocolFlagsEligible:policy.classifyFailure({kind:'protocol_error'}).eligible},
 {probe:'fallback-context-clone',unsupportedDateSilentlyDropped:true,nestedCopyMutable:true,originalNotMutated:true},
 {probe:'context-not-globally-bounded',factCount:64,outputChars:factBlock.length,truncatedSections:assembled.meta.truncated},
 {probe:'budget-invalid-clock',initialGrantTimeValid:true,activeAfterClockBroke:true,activeWithNaNRemainingMs:true,chargeAccepted:true,callsCharged:1}
]}));
