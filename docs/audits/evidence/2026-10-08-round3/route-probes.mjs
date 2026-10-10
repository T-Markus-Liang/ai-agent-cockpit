import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRouteBindingRegistry } from '/tmp/personal-ai-os-review-round3.ClxFrw/input/runtime/route-binding.mjs';
import { openBindingStore } from '/tmp/personal-ai-os-review-round3.ClxFrw/input/runtime/route-binding-store.mjs';

const binding=(id='synthetic-request')=>({requestKey:{ownerId:'synthetic-owner',sourceRequestId:id},runtime:'legacy',codeVersion:'synthetic-code',interfaceVersion:'synthetic-interface',modelRef:{provider:'synthetic',modelId:'model'},profileId:'synthetic-profile',cwd:process.cwd(),authorizationDigest:'synthetic-reference-only',effectKey:'synthetic-effect',legacyScope:{allowedTaskIds:['synthetic-task-1','synthetic-task-2']},createdAt:1,expiresAt:1000});
const out=[];
const registry=createRouteBindingRegistry({now:()=>10});const row=registry.bind(binding());
const first=registry.planEffect(row.requestKey,{effectKey:row.effectKey,taskId:'synthetic-task-1'});
const second=registry.planEffect(row.requestKey,{effectKey:row.effectKey,taskId:'synthetic-task-2'});
assert.equal(second,first);assert.equal(second.taskId,'synthetic-task-1');
const snapshot=JSON.parse(JSON.stringify(registry.toJSON()));
snapshot.intents.push({...snapshot.intents[0],taskId:'synthetic-task-2'});
const restored=createRouteBindingRegistry.fromJSON(snapshot,{now:()=>10});
assert.equal(restored.toJSON().intents[0].taskId,'synthetic-task-2');
out.push({probe:'changed-task-intent-is-not-conflict',requestedTask:'synthetic-task-2',returnedTask:second.taskId,restoreDuplicateSilentlyReplaced:true});

const dir=await fs.mkdtemp(path.join(process.cwd(),'audit-route-'));
try {
  const file=path.join(dir,'closed.sqlite');const store=openBindingStore(file,{now:()=>10});store.close();
  let firstError;try{store.bind(binding('synthetic-ghost'));}catch(e){firstError=e.code||e.name;}
  assert.ok(firstError);const ghost=store.bind(binding('synthetic-ghost'));
  assert.equal(store.resolve(ghost.requestKey).requestKey.sourceRequestId,'synthetic-ghost');
  const reopened=openBindingStore(file,{now:()=>10});
  assert.equal(reopened.size,0);reopened.close();
  out.push({probe:'failed-write-leaves-ghost-success',firstError,retryReportsBinding:true,memorySize:store.size,durableSize:0});

  // Same root defect without calling any API after close: force an INSERT
  // failure while an external synthetic corruption makes DB reload fail.
  const damaged=path.join(dir,'reload-failure.sqlite');const live=openBindingStore(damaged,{now:()=>10});
  let raw=new DatabaseSync(damaged);
  raw.exec("INSERT INTO bindings VALUES ('corrupt-owner','corrupt-request','not-json',1); CREATE TRIGGER synthetic_fail_insert BEFORE INSERT ON bindings BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END;");
  let insertError;try{live.bind(binding('synthetic-open-ghost'));}catch(e){insertError=e.code||e.name;}
  assert.ok(insertError);
  const retry=live.bind(binding('synthetic-open-ghost'));
  assert.equal(retry.requestKey.sourceRequestId,'synthetic-open-ghost');
  const durable=raw.prepare('SELECT count(*) AS n FROM bindings WHERE request_owner=? AND request_id=?').get('synthetic-owner','synthetic-open-ghost').n;
  assert.equal(durable,0);raw.close();live.close();
  out[out.length-1].openStoreReloadFailureAlsoReturnsGhost=true;
  out[out.length-1].openStoreGhostDurableRows=durable;

  const foreign=path.join(dir,'foreign.sqlite');let db=new DatabaseSync(foreign);db.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\x27synthetic\x27)');db.close();
  const adopted=openBindingStore(foreign,{now:()=>10});adopted.close();
  db=new DatabaseSync(foreign);const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);db.close();
  assert.deepEqual(tables,['bindings','intents','meta','unrelated']);
  out.push({probe:'unknown-existing-db-adopted',newTablesAdded:['bindings','intents','meta'],unrelatedDataRetained:true});
} finally {await fs.rm(dir,{recursive:true,force:true});}

console.log(JSON.stringify({realModels:false,productionTouched:false,observations:out}));
