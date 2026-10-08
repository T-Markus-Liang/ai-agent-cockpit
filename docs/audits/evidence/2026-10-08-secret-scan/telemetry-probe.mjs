import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import crypto from 'node:crypto';
const sourcePath = process.env.TELEMETRY_AUDIT_SOURCE || '/Users/markus/ai-agent-cockpit/vendor/wechat-acp/src/telemetry/index.ts';
const bytes = fs.readFileSync(sourcePath);
if (crypto.createHash('sha256').update(bytes).digest('hex') !== 'fccfc087f2f15d402bbf38ca311b65cbf5224bb39a3cce7cb9400472e4f6133a') {
  throw new Error('original sourceRef changed; replay the frozen original source, not the new repair');
}
const source = bytes.toString('utf8')
  .replace('createRequire(import.meta.url)', 'createRequire("file:///synthetic/telemetry.ts")');
const code = stripTypeScriptTypes(source)
  .replace(/import (\w+) from ("node:[^"]+");/g, 'const $1 = auditRequire($2);')
  .replace('import { createRequire } from "node:module";', 'const { createRequire } = auditRequire("node:module");')
  .replace(/export (?=(?:async )?function)/g, '')
  + '\nObject.assign(exports, {initTelemetry, trackException, trackEvent});';

function probe(env) {
  const observations = { sdkStarts: 0, writes: 0, exceptionHasSyntheticCanary: false, exceptionSameObject: false };
  const canary = 'TESTONLY-telemetry-error-canary';
  const error = new Error(canary);
  const client = {
    context: { tags: {}, keys: { cloudRole: 'role', userId: 'user' } },
    commonProperties: {},
    trackEvent() {},
    trackException(event) {
      observations.exceptionHasSyntheticCanary = event.exception.message.includes(canary);
      observations.exceptionSameObject = event.exception === error;
    },
    flush() {},
  };
  const chain = {};
  for (const name of ['setAutoCollectRequests','setAutoCollectPerformance','setAutoCollectExceptions','setAutoCollectDependencies','setAutoCollectConsole','setSendLiveMetrics','setInternalLogging'])chain[name]=()=>chain;
  chain.start = () => { observations.sdkStarts++; return chain; };
  const sdk = { setup: () => chain, defaultClient: client };
  const fakeFs = { existsSync: () => false, mkdirSync() {}, writeFileSync() { observations.writes++; } };
  const exports = {};
  const context = {
    exports, module: { exports }, Error,
    process: { env, version: 'synthetic', platform: 'synthetic', arch: 'synthetic' },
    setTimeout: () => ({ unref() {} }),
    auditRequire: name => {
      if(name==='node:fs')return fakeFs;
      if(name==='node:path')return path;
      if(name==='node:crypto')return { randomUUID: () => 'TESTONLY-install-id' };
      if(name==='node:module')return { createRequire: () => () => sdk };
      throw new Error('unexpected import');
    },
  };
  vm.runInNewContext(code, context, { timeout: 1000 });
  exports.initTelemetry({ version: 'synthetic', storageDir: '/synthetic-no-real-io' });
  exports.trackException(error, 'synthetic');
  return observations;
}

const result = { network: 'none; SDK completely stubbed', filesystem: 'in-memory fake', defaultEnvironment: probe({}), explicitDisabled: probe({ WECHAT_ACP_TELEMETRY: '0' }) };
if(result.defaultEnvironment.sdkStarts!==1||!result.defaultEnvironment.exceptionHasSyntheticCanary||result.explicitDisabled.sdkStarts!==0)throw new Error('probe expectation failed');
console.log(JSON.stringify(result, null, 2));
