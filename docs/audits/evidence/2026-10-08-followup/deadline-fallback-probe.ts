import {EventEmitter} from 'node:events';
import {SessionManager} from '/Users/markus/ai-agent-cockpit/vendor/wechat-acp/src/acp/session.ts';

let primaryPrompts=0,fallbackPrompts=0,createdFallbackSessions=0;
let firstPromptAt=0,fallbackPromptAt=0;
const replies:string[]=[],notices:string[]=[];
const deadlineMs=30;
function makeSession(id:string,prompt:()=>Promise<{stopReason:string}>,produced:boolean):any {
  const child=new EventEmitter();Object.assign(child,{killed:false,exitCode:null,signalCode:null});
  return {userId:'TESTONLY-user',contextToken:'TESTONLY-delivery',client:{beginTurn:async()=>{},flush:async()=>id+'-reply',hasProducedMessage:produced,hasUsedTools:false},
    agentInfo:{process:child,connection:{closed:new Promise(()=>{}),prompt,cancel:async()=>{}},sessionId:id,configOptions:[],sessionOutcome:'new'},
    configOptions:[],queue:[],processing:false,createdAt:Date.now(),lastActivity:Date.now(),lifecycleGeneration:0};
}
const manager=new SessionManager({agentCommand:'unused',agentArgs:[],agentCwd:process.cwd(),maxConcurrentUsers:1,idleTimeoutMs:0,foregroundWaitMs:5,grantDeadlineMs:deadlineMs,
  fallbackAgents:[{label:'TESTONLY-fallback',command:'unused',args:[]}],showThoughts:false,killAgentProcess:async()=>{},sendTyping:async()=>{},log:()=>{},
  onReply:async(_u,_t,text)=>{replies.push(text);},onNotice:async(_u,_t,text)=>{notices.push(text);}});
const internals=manager as any;
let finish!:(value:string)=>void;
const terminal=new Promise<string>(resolve=>{finish=resolve;});
const primary=makeSession('TESTONLY-primary',async()=>{primaryPrompts++;firstPromptAt=Date.now();return new Promise(()=>{});},false);
primary.processing=true;
primary.queue=[{prompt:[{type:'text',text:'TESTONLY task'}],contextToken:'TESTONLY-delivery',completion:{resolve:()=>finish('resolved'),reject:()=>finish('rejected')}}];
internals.sessions.set(primary.userId,primary);
internals.createSession=async()=>{createdFallbackSessions++;return makeSession('TESTONLY-fallback',async()=>{fallbackPrompts++;fallbackPromptAt=Date.now();return{stopReason:'end_turn'};},true);};
let timer:ReturnType<typeof setTimeout>|undefined;
try {
  await internals.processQueue(primary);
  const outcome=await Promise.race([terminal,new Promise<string>(resolve=>{timer=setTimeout(()=>resolve('probe-timeout'),1000);})]);
  console.log(JSON.stringify({syntheticOnly:true,realModels:0,productionTouched:false,configuredGrantDeadlineMs:deadlineMs,primaryPrompts,fallbackPrompts,createdFallbackSessions,
    fallbackStartedAfterFirstDeadline:fallbackPromptAt-firstPromptAt>=deadlineMs,terminalOutcome:outcome,replies:replies.length,grantDeadlineNotices:notices.filter(x=>x.includes('Grant')).length},null,2));
} finally {if(timer)clearTimeout(timer);await manager.stop();}

