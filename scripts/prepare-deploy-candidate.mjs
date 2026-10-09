#!/usr/bin/env node
// Personal AI OS 0.3.0 S02 — candidate deployment package generator (CLI).
//
// Registered migrator entry point required by
// docs/plans/0.3.0-remediation-2026-10-09.md §4 ("具体迁移器入口由执行方交付
// 后登记"). It builds the candidate deployment package under an explicit
// --out directory and NEVER writes a live path:
//
//   node scripts/prepare-deploy-candidate.mjs --out <candidateDir> \
//        [--config config/wechat-acp.json] [--dry-run]
//
//   --config   source wechat-acp config (default: <repo>/config/wechat-acp.json)
//   --dry-run  run the config migration twice, prove byte-identical output,
//              print the summary, write NOTHING (the --out dir is not created)
//
// Safety: --out resolving into ~/.local/state or ~/.wechat-acp is refused with
// exit code 2. Plaintext tokens are NEVER printed — only tokenDigest prefixes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  migrateWechatAcpConfig,
  generateAuthorityCandidates,
  resolveServiceAuthorityPaths,
  DeployCandidateError,
} from '../control-plane/deploy-candidate.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error('usage: node scripts/prepare-deploy-candidate.mjs --out <candidateDir> [--config config/wechat-acp.json] [--dry-run]');
}

function parseArgs(argv) {
  const parsed = { out: undefined, config: undefined, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--out') { parsed.out = argv[++index]; }
    else if (arg === '--config') { parsed.config = argv[++index]; }
    else if (arg === '-h' || arg === '--help') { usage(); process.exit(0); }
    else { console.error(`unknown argument: ${arg}`); usage(); process.exit(2); }
  }
  if (typeof parsed.out !== 'string' || parsed.out.length === 0) { usage(); process.exit(2); }
  if (parsed.config !== undefined && typeof parsed.config !== 'string') { usage(); process.exit(2); }
  return parsed;
}

function refuseLivePaths(outDir) {
  const homeDir = os.homedir();
  const resolved = path.resolve(outDir);
  const forbidden = [path.join(homeDir, '.local/state'), path.join(homeDir, '.wechat-acp')];
  for (const prefix of forbidden) {
    if (resolved === prefix || resolved.startsWith(prefix + path.sep)) {
      console.error(`refused: --out ${resolved} resolves into the live path ${prefix}`);
      process.exit(2);
    }
  }
  return resolved;
}

function printReport({ report, bytes, rollbackPath }) {
  console.log('== config migration (wechat-acp) ==');
  console.log(`  migrated:        ${report.migrated}`);
  console.log(`  candidate bytes: ${bytes}`);
  console.log(`  source sha256:   ${report.sourceSha256}`);
  console.log(`  candidate sha256:${report.candidateSha256 ? ' ' + report.candidateSha256 : ''}`);
  if (rollbackPath) console.log(`  rollback file:   ${rollbackPath} (byte-identical copy of the source, mode 0600)`);
  for (const entry of report.deprecations) console.log(`  deprecation:     ${entry}`);
  for (const entry of report.warnings) console.log(`  warning:         ${entry}`);
  if (!report.deprecations.length) console.log('  deprecations:    none');
  if (!report.warnings.length) console.log('  warnings:        none');
}

function printGeneration({ mapping, tokenFiles, authorityFiles }) {
  console.log('== authority candidates ==');
  for (const client of mapping) {
    console.log(`  ${client.name}  service=${client.service} role=${client.role}`);
    console.log(`    principalId=${client.principalId} expiresAt=${new Date(client.expiresAt).toISOString()} tokenDigest=${client.tokenDigest.slice(0, 12)}…`);
  }
  console.log('  authority files:');
  for (const file of authorityFiles) console.log(`    ${file}`);
  console.log(`  mapping:         ${path.join(tokenFiles[0] ? path.dirname(tokenFiles[0]) : '', '..', 'mapping.json')}`);
  console.log('  token files (mode 0600, plaintext never printed):');
  for (const file of tokenFiles) console.log(`    ${file}`);
}

function printResolution(resolved) {
  console.log('== resolved service authority paths ==');
  console.log(`  goals : ${resolved.goals.path}  (source: ${resolved.goals.source})`);
  console.log(`  memory: ${resolved.memory.path}  (source: ${resolved.memory.source})`);
}

function readPlistIfPresent(name) {
  try { return fs.readFileSync(path.join(repoRoot, 'launchd', name), 'utf8'); }
  catch { return undefined; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = refuseLivePaths(args.out);
  const sourcePath = path.resolve(args.config ?? path.join(repoRoot, 'config', 'wechat-acp.json'));

  if (args.dryRun) {
    // Two dry runs must be byte-identical (deterministic output contract).
    const first = migrateWechatAcpConfig({ sourcePath, targetPath: path.join(outDir, 'wechat-acp.json'), dryRun: true });
    const second = migrateWechatAcpConfig({ sourcePath, targetPath: path.join(outDir, 'wechat-acp.json'), dryRun: true });
    const consistent = first.bytes === second.bytes && JSON.stringify(first.report) === JSON.stringify(second.report);
    console.log(`dry-run: no files written (candidate dir ${outDir} not created)`);
    console.log(`source: ${sourcePath}`);
    printReport(first);
    console.log(`== determinism ==`);
    console.log(`  two dry runs byte-identical: ${consistent}`);
    process.exit(consistent ? 0 : 1);
  }

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const migrated = migrateWechatAcpConfig({ sourcePath, targetPath: path.join(outDir, 'wechat-acp.json') });
  printReport(migrated);

  const generated = await generateAuthorityCandidates({ candidateDir: outDir });
  printGeneration(generated);

  const resolved = resolveServiceAuthorityPaths({
    env: process.env,
    homeDir: os.homedir(),
    plistTexts: {
      goalsPlist: readPlistIfPresent('com.markus.personal-ai-os.goals.plist'),
      memoryPlist: readPlistIfPresent('com.markus.personal-ai-os.memory.plist'),
    },
  });
  printResolution(resolved);
  console.log('candidate package complete (NOT deployed; no live path was written).');
}

main().catch(error => {
  if (error instanceof DeployCandidateError) {
    console.error(`refused [${error.code}]: ${error.reason ?? error.message}`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
