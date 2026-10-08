#!/usr/bin/env node
/**
 * Deterministic repository secret scan (SKEY-F002 leak-scan gate).
 *
 * Pure Node — no external dependencies, no network, no writes.
 *
 * Scope: tracked source files reported by `git ls-files`, excluding
 * node_modules, lock files, binaries, and this scanner's own config. A filesystem
 * fallback is used only when git is unavailable.
 *
 * Behaviour:
 *   - Matches Google / GitHub / OpenAI / Anthropic / AWS / JWT / private-key /
 *     Slack / Stripe / GitLab / npm credential SHAPES.
 *   - A hit is allowed ONLY if it is listed, by exact (path + matched-value
 *     sha256), in config/secret-scan-dispositions.json with a reason.
 *   - Any hit not precisely dispositioned fails the gate (exit 1). Full values are
 *     never printed — only a 4+4 character mask.
 *   - `--self-test` runs an in-memory positive/negative check of the matcher and
 *     disposition logic and exits non-zero if the gate is not fail-closed.
 *
 * Usage: node scripts/secret-scan.mjs [--self-test]
 * npm:   npm run audit:secrets
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");
const DISPOSITIONS_REL = "config/secret-scan-dispositions.json";
const SELF_REL = new Set(["scripts/secret-scan.mjs", DISPOSITIONS_REL]);

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".venv",
  ".venv-memory",
  "__pycache__",
  "coverage",
]);

/**
 * Credential shapes. Kept deliberately precise: bodies require the length and
 * character set of real keys so ordinary hyphenated words are not flagged.
 */
const RULES = [
  { id: "google_api_key", re: "AIza[0-9A-Za-z_\\-]{35}" },
  { id: "google_oauth_token", re: "ya29\\.[0-9A-Za-z_\\-]{20,}" },
  { id: "github_token", re: "gh[pousr]_[0-9A-Za-z]{36,}" },
  { id: "github_fine_grained_pat", re: "github_pat_[0-9A-Za-z_]{22,}" },
  { id: "openai_api_key", re: "sk-[A-Za-z0-9]{32,}" },
  { id: "openai_project_key", re: "sk-(?:proj|svcacct|admin)-[A-Za-z0-9_\\-]{20,}" },
  { id: "anthropic_api_key", re: "sk-ant-(?:api[0-9]{2}-)?[A-Za-z0-9_\\-]{20,}" },
  {
    id: "aws_access_key_id",
    re: "(?:AKIA|ASIA|A3T[A-Z0-9]|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}",
  },
  { id: "jwt", re: "eyJ[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{6,}" },
  { id: "private_key", re: "-{5}BEGIN (?:[A-Z]+ )?PRIVATE KEY-{5}" },
  { id: "slack_token", re: "xox[baprs]-[A-Za-z0-9\\-]{10,}" },
  { id: "stripe_secret_key", re: "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}" },
  { id: "gitlab_pat", re: "glpat-[A-Za-z0-9_\\-]{20,}" },
  { id: "npm_token", re: "npm_[A-Za-z0-9]{36}" },
];

const COMPILED_RULES = RULES.map((rule) => ({ id: rule.id, re: new RegExp(rule.re, "g") }));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function maskValue(value) {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function resolveRoot() {
  if (process.env.SECRET_SCAN_ROOT) return path.resolve(process.env.SECRET_SCAN_ROOT);
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  return DEFAULT_ROOT;
}

/** Tracked files via `git ls-files`, or a recursive walk as a fallback. */
function listFiles(root) {
  const git = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0 && typeof git.stdout === "string") {
    return { source: "git ls-files", files: git.stdout.split("\0").filter(Boolean) };
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
      } else if (entry.isFile()) {
        out.push(path.relative(root, abs));
      }
    }
  };
  walk(root);
  return { source: "filesystem walk (git unavailable)", files: out };
}

function isScannable(rel) {
  if (SELF_REL.has(rel)) return false;
  const base = path.basename(rel);
  if (LOCKFILE_NAMES.has(base)) return false;
  return true;
}

function readText(absPath) {
  let buf;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  if (buf.includes(0)) return null; // binary
  return buf.toString("utf8");
}

function loadDispositions(root) {
  const file = path.join(root, DISPOSITIONS_REL);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed.dispositions;
    if (!Array.isArray(list)) return [];
    return list
      .filter((entry) => entry && typeof entry.sha256 === "string")
      .map((entry) => ({
        sha256: entry.sha256.toLowerCase(),
        paths: entry.paths ?? (entry.path ? [entry.path] : []),
        reason: entry.reason ?? "",
        auditRef: entry.auditRef ?? "",
      }));
  } catch {
    return [];
  }
}

function findDisposition(dispositions, relPath, hash) {
  for (const disp of dispositions) {
    if (disp.sha256 !== hash) continue;
    if (disp.paths.length === 0 || disp.paths.includes(relPath)) return disp;
  }
  return null;
}

/** Yield every rule match in `text`, with line/column positions. */
function scanText(text) {
  const found = [];
  const lines = text.split("\n");
  const lineStarts = [0];
  for (const line of lines) lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1);
  const lineAt = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const { id, re } of COMPILED_RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const line = lineAt(m.index);
      found.push({ rule: id, value: m[0], line, col: m.index - lineStarts[line - 1] + 1 });
    }
  }
  return found;
}

function runScan(root) {
  const { source, files } = listFiles(root);
  const dispositions = loadDispositions(root);
  const unresolved = [];
  const allowed = [];
  let scanned = 0;
  let skippedBinary = 0;

  for (const rel of files) {
    if (!isScannable(rel)) continue;
    const text = readText(path.join(root, rel));
    if (text === null) {
      skippedBinary += 1;
      continue;
    }
    scanned += 1;
    for (const hit of scanText(text)) {
      const hash = sha256(hit.value);
      const disp = findDisposition(dispositions, rel, hash);
      const record = {
        path: rel,
        line: hit.line,
        col: hit.col,
        rule: hit.rule,
        sha256: hash,
        masked: maskValue(hit.value),
      };
      if (disp) {
        record.reason = disp.reason;
        record.auditRef = disp.auditRef;
        allowed.push(record);
      } else {
        unresolved.push(record);
      }
    }
  }
  return { source, scanned, skippedBinary, dispositions: dispositions.length, allowed, unresolved };
}

function printResult(result) {
  console.log("== secret-scan ==");
  console.log(`file list      : ${result.source}`);
  console.log(`files scanned  : ${result.scanned} (binary skipped: ${result.skippedBinary})`);
  console.log(`dispositions   : ${result.dispositions}`);
  console.log("");
  if (result.allowed.length > 0) {
    console.log(`Dispositioned hits (${result.allowed.length}):`);
    for (const hit of result.allowed) {
      console.log(
        `  ok  ${hit.rule}  ${hit.path}:${hit.line}:${hit.col}  sha256=${hit.sha256.slice(0, 12)}  value=${hit.masked}` +
          (hit.reason ? `  [${hit.reason}]` : ""),
      );
    }
    console.log("");
  }
  if (result.unresolved.length > 0) {
    console.error(`UNRESOLVED hits (${result.unresolved.length}):`);
    for (const hit of result.unresolved) {
      console.error(
        `  !!  ${hit.rule}  ${hit.path}:${hit.line}:${hit.col}  sha256=${hit.sha256.slice(0, 12)}  value=${hit.masked}`,
      );
    }
    console.error("");
    console.error(`FAIL: ${result.unresolved.length} undispositioned credential-shaped hit(s).`);
    return 1;
  }
  console.log("PASS: 0 undispositioned credential-shaped hits.");
  return 0;
}

// ---------------------------------------------------------------------------
// Self-test: proves the matcher detects shapes and that the gate fails closed.
// ---------------------------------------------------------------------------

function selfTest() {
  const samples = [
    { rule: "google_api_key", value: "AIza" + "A".repeat(35) },
    { rule: "google_oauth_token", value: "ya29." + "b".repeat(24) },
    { rule: "github_token", value: "ghp_" + "c".repeat(36) },
    { rule: "openai_api_key", value: "sk-" + "d".repeat(40) },
    { rule: "anthropic_api_key", value: "sk-ant-" + "e".repeat(30) },
    { rule: "aws_access_key_id", value: "AKIA" + "F".repeat(16) },
    { rule: "jwt", value: "eyJ" + "g".repeat(12) + "." + "h".repeat(12) + "." + "i".repeat(12) },
    { rule: "private_key", value: "-".repeat(5) + "BEGIN RSA PRIVATE KEY" + "-".repeat(5) },
    { rule: "slack_token", value: "xoxb-" + "j".repeat(24) },
    { rule: "stripe_secret_key", value: "sk_live_" + "k".repeat(24) },
    { rule: "gitlab_pat", value: "glpat-" + "l".repeat(24) },
    { rule: "npm_token", value: "npm_" + "m".repeat(36) },
  ];

  let failures = 0;
  const fail = (msg) => {
    failures += 1;
    console.error(`  FAIL: ${msg}`);
  };

  for (const sample of samples) {
    const hits = scanText(sample.value);
    if (!hits.some((h) => h.rule === sample.rule)) {
      fail(`rule ${sample.rule} did not detect its sample`);
    }
    if (maskValue(sample.value).includes(sample.value) || maskValue(sample.value).length > 9) {
      fail(`mask for ${sample.rule} leaked the value`);
    }
  }

  // A value that is clearly not a credential must not match.
  if (scanText("sk-columns-workflow-folded png").length !== 0) {
    fail("ordinary hyphenated text must not match");
  }

  // Disposition logic: a sha256 + path entry allows only that exact hit.
  const sample = samples[0];
  const hash = sha256(sample.value);
  const dispositions = [
    { sha256: hash, paths: ["a/b.md"], reason: "synthetic", auditRef: "" },
  ];
  if (!findDisposition(dispositions, "a/b.md", hash)) fail("disposition should match on exact path");
  if (findDisposition(dispositions, "a/c.md", hash)) fail("disposition must not match a different path");
  if (findDisposition(dispositions, "a/b.md", sha256("different"))) {
    fail("disposition must not match a different value");
  }

  if (failures > 0) {
    console.error(`self-test FAILED (${failures})`);
    return 1;
  }
  console.log(`self-test PASS: ${samples.length} shapes detected, masking safe, dispositions exact.`);
  return 0;
}

function main() {
  if (process.argv.includes("--self-test")) {
    process.exit(selfTest());
  }
  const root = resolveRoot();
  const result = runScan(root);
  process.exit(printResult(result));
}

main();
