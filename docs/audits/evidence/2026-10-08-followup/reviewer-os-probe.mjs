import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { nativeAcpSandboxSpec, applyReviewerReadonlyConstraint } from '/Users/markus/ai-agent-cockpit/control-plane/native-acp-executor.mjs';
import { wrapWithSandbox, sandboxEnv } from '/Users/markus/ai-agent-cockpit/control-plane/native-sandbox.mjs';

const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reviewer-os-audit-')));
const artifact=path.join(dir,'artifact.txt');
try {
  await fs.writeFile(artifact,'TESTONLY-original',{mode:0o600});
  const initial=nativeAcpSandboxSpec({command:process.execPath,cwd:dir,grant:{writeLiterals:[artifact],denyNetwork:true}});
  const constrained=applyReviewerReadonlyConstraint(initial,'reviewer');
  const wrapped=wrapWithSandbox(process.execPath,['-e','require("node:fs").writeFileSync(process.argv[1],"TESTONLY-modified")',artifact],constrained.spec);
  const child=spawnSync(wrapped.command,wrapped.args,{cwd:dir,env:sandboxEnv(),encoding:'utf8',timeout:3000});
  const body=await fs.readFile(artifact,'utf8');
  console.log(JSON.stringify({syntheticOnly:true,realSeatbelt:true,realNativeAgent:false,networkDenied:true,productionTouched:false,models:0,
    readonlyMarker:constrained.readonly.applied,writeLiterals:constrained.spec.writeLiterals,
    sandboxExit:child.status,artifactModified:body!=='TESTONLY-original',expectedArtifactModified:false,
    stdoutBytes:child.stdout?.length??0,stderrBytes:child.stderr?.length??0,
    diagnostic:child.status===0?null:(child.stderr??'').replaceAll(dir,'<synthetic-tmp>')},null,2));
} finally {await fs.rm(dir,{recursive:true,force:true});}

