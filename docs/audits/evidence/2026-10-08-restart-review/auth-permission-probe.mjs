import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createLiveRequestAuthority} from '/Users/markus/ai-agent-cockpit/control-plane/request-authority.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'restart-auth-mode-'));
const file=path.join(dir,'authority.json');
const token=crypto.randomBytes(32).toString('base64url');
try {
  await fs.writeFile(file,JSON.stringify({version:1,principals:[{id:'TESTONLY-client',role:'operator',tokenDigest:crypto.createHash('sha256').update(token).digest('hex')}]}),{mode:0o600});
  const authority=createLiveRequestAuthority({file,required:true});
  const before=authority.authenticate({authorization:'Bearer '+token});
  const initial=await fs.stat(file);
  await fs.chmod(file,0o644);
  const after=await fs.stat(file);
  let accepted=false,errorCode=null;
  try {accepted=authority.authenticate({authorization:'Bearer '+token}).authenticated===true;}catch(e){errorCode=e.code;}
  console.log(JSON.stringify({syntheticOnly:true,productionWrites:0,modelCalls:0,initialAuthenticated:before.authenticated,initialMode:(initial.mode&0o777).toString(8),newMode:(after.mode&0o777).toString(8),cacheKeyMetadataUnchanged:initial.ino===after.ino&&initial.mtimeMs===after.mtimeMs&&initial.size===after.size,expectedError:'AUTH_CONFIGURATION',actualError:errorCode,acceptedAfterPermissionsWidened:accepted},null,2));
} finally {await fs.rm(dir,{recursive:true,force:true});}

