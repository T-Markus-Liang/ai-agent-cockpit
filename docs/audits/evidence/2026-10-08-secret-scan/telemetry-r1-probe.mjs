import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const sourcePath=process.env.TELEMETRY_AUDIT_SOURCE||'/Users/markus/ai-agent-cockpit/vendor/wechat-acp/src/telemetry/index.ts';
const source=fs.readFileSync(sourcePath,'utf8');
const sourceSha256=crypto.createHash('sha256').update(source).digest('hex');
if(sourceSha256!=='4b2a7abc99469d12e3f04475624c19d4ca5f87e05608f60d31de7469540541da')throw new Error('r1 sourceRef changed; replay the frozen r1 source');
const code=stripTypeScriptTypes(source.replace('createRequire(import.meta.url)','createRequire("file:///synthetic/telemetry.ts")'))
  .replace(/import (\w+) from ("node:[^"]+");/g,'const $1 = auditRequire($2);')
  .replace('import { createRequire } from "node:module";','const {createRequire}=auditRequire("node:module");')
  .replace(/export (?=(?:async )?(?:function|const))/g,'')
  +'\nObject.assign(exports,{createTelemetry});';
const events=[],exceptions=[];
const canary='sk-'+'TESTONLY'.repeat(4);
const client={context:{tags:{},keys:{cloudRole:'role',userId:'user'}},commonProperties:{},
  trackEvent:x=>events.push(x),trackException:x=>exceptions.push(x),flush(){}};
const chain={};let sdkLoads=0,fakeWrites=0;
for(const k of ['setAutoCollectRequests','setAutoCollectPerformance','setAutoCollectExceptions','setAutoCollectDependencies','setAutoCollectConsole','setSendLiveMetrics','setInternalLogging'])chain[k]=()=>chain;
chain.start=()=>chain;
const sdk={setup:()=>chain,defaultClient:client};
const exports={};
vm.runInNewContext(code,{exports,Error,process:{env:{},version:'synthetic',platform:'synthetic',arch:'synthetic'},setTimeout:()=>({unref(){}}),auditRequire:name=>{
  if(name==='node:fs')return{existsSync:()=>false,mkdirSync(){},writeFileSync(){fakeWrites++;}};
  if(name==='node:path')return path;
  if(name==='node:crypto')return{randomUUID:()=> 'TESTONLY-install-id',createHash:crypto.createHash};
  if(name==='node:module')return{createRequire:()=>()=>{sdkLoads++;return sdk;}};
  throw new Error('unexpected module');
}},{timeout:1000});
const noOpt=exports.createTelemetry({getEnv:()=>({}),sdkLoader:()=>{sdkLoads++;return sdk;}});
noOpt.init({version:'synthetic',storageDir:'/synthetic'});
const defaultOff=sdkLoads===0&&fakeWrites===0;
const active=exports.createTelemetry({getEnv:()=>({WECHAT_ACP_TELEMETRY:'1',WECHAT_ACP_TELEMETRY_CONNECTION_STRING:'TESTONLY-no-real-connection'}),sdkLoader:()=>{sdkLoads++;return sdk;}});
active.init({version:'synthetic',storageDir:'/synthetic',agentPreset:canary});
active.trackEvent('command.acp_config.set',{configId:canary,optionValue:canary,optionType:'select'},canary);
active.trackException(new Error(canary),'prompt',canary);
const result={sourceSha256,network:'none; fake SDK',filesystem:'fake only',defaultOff,
  rawExceptionMessageDropped:exceptions[0]?.exception?.message?.includes(canary)===false,
  rawExceptionStackDropped:exceptions[0]?.exception?.stack===undefined,
  eventPropertyCanaryLeaked:events[0]?.properties?.optionValue===canary,
  eventTagCanaryLeaked:events[0]?.tagOverrides?.['ai.session.id']===canary,
  exceptionTagCanaryLeaked:exceptions[0]?.tagOverrides?.['ai.session.id']===canary,
  commonPropertyCanaryLeaked:client.commonProperties.agentPreset===canary};
console.log(JSON.stringify(result,null,2));
if(!defaultOff||!result.rawExceptionMessageDropped)process.exitCode=1;
