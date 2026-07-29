#!/usr/bin/env node
// Power-up script eval runner.
//
// Runs the golden cases in src/utils/powerUpEvalCases.ts against the
// deterministic script engine (and, once the hosted tool-loop ships, against
// recorded agent tool-call transcripts) and produces a structured report.
//
// Usage:
//   node scripts/evalPowerUp.mjs                       # run, print, write report JSON
//   CANOPY_ADMIN_URL=http://localhost:3001 \
//   node scripts/evalPowerUp.mjs --post                # also POST to canopy-admin
//
// Reports land in scripts/eval-reports/ (git-ignored) and, when --post is
// given, in canopy-admin's eval store → visible on the admin Dashboard.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// ── Bundle the TS modules into a temp CJS file so node can run them. ──
const entry = `
export { buildPowerUpScript, findJargon, MAX_ASKS } from "${join(repoRoot, "src/utils/powerUpScript.ts").replace(/\\/g, "/")}";
export { POWER_UP_EVAL_CASES } from "${join(repoRoot, "src/utils/powerUpEvalCases.ts").replace(/\\/g, "/")}";
`;
const entryPath = join(tmpdir(), `powerup-eval-entry-${Date.now()}.ts`);
const bundlePath = join(tmpdir(), `powerup-eval-bundle-${Date.now()}.cjs`);
await writeFile(entryPath, entry);
execSync(
  `npx esbuild "${entryPath}" --bundle --platform=node --format=cjs --outfile="${bundlePath}"`,
  { cwd: repoRoot, stdio: "pipe" },
);
const { buildPowerUpScript, findJargon, MAX_ASKS, POWER_UP_EVAL_CASES } = await import(bundlePath);

// ── Run cases ──
const BUDGETED = new Set(["channel", "connection", "heartbeat"]);
const results = [];

for (const evalCase of POWER_UP_EVAL_CASES) {
  const failures = [];
  let asks = [];
  try {
    asks = buildPowerUpScript(evalCase.input);
  } catch (err) {
    failures.push(`threw: ${err?.message || err}`);
  }

  if (failures.length === 0) {
    const order = asks.map(a => a.type);
    if (JSON.stringify(order) !== JSON.stringify(evalCase.expect.askTypeOrder)) {
      failures.push(`ask order [${order}] != expected [${evalCase.expect.askTypeOrder}]`);
    }
    for (const ask of asks.filter(a => a.type === "connection")) {
      if (!evalCase.expect.allowedConnectionKeys.includes(ask.integrationKey)) {
        failures.push(`connection key "${ask.integrationKey}" outside allowed set`);
      }
      if (evalCase.expect.connectionSource && ask.source !== evalCase.expect.connectionSource) {
        failures.push(`connection source "${ask.source}" != "${evalCase.expect.connectionSource}"`);
      }
    }
    for (const forbidden of evalCase.expect.forbiddenConnectionKeys || []) {
      if (asks.some(a => a.integrationKey === forbidden)) {
        failures.push(`forbidden key "${forbidden}" was asked`);
      }
    }
    const budgeted = asks.filter(a => BUDGETED.has(a.type)).length;
    const cap = evalCase.expect.maxAsks ?? MAX_ASKS;
    if (budgeted > cap) failures.push(`${budgeted} budgeted asks > cap ${cap}`);
    for (const ask of asks) {
      const jargon = findJargon(ask.message);
      if (jargon.length) failures.push(`jargon in ${ask.id}: ${jargon.join(", ")}`);
    }
  }

  results.push({
    caseId: evalCase.id,
    description: evalCase.description,
    passed: failures.length === 0,
    failures,
    askCount: asks.length,
    connectionKeys: asks.filter(a => a.type === "connection").map(a => a.integrationKey),
  });
}

// ── Report ──
let gitSha = null;
try { gitSha = execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: "pipe" }).toString().trim(); } catch {}

// Tag the run with the currently-deployed onboarding-config variant (best
// effort) so the admin Dashboard can line eval runs up against funnel data.
let configVariant = "default";
try {
  const adminUrl = process.env.CANOPY_ADMIN_URL || "http://localhost:3001";
  const res = await fetch(`${adminUrl}/api/onboarding-config`, { signal: AbortSignal.timeout(3000) });
  if (res.ok) configVariant = (await res.json()).variant || "default";
} catch { /* offline is fine */ }

const report = {
  configVariant,
  suite: "powerup_script",
  // "script" today; the tool-loop harness will report engine: "agent_loop"
  engine: "script",
  runAt: new Date().toISOString(),
  gitSha,
  total: results.length,
  passed: results.filter(r => r.passed).length,
  failed: results.filter(r => !r.passed).length,
  results,
};

const reportDir = join(__dirname, "eval-reports");
await mkdir(reportDir, { recursive: true });
const reportPath = join(reportDir, `powerup-${report.runAt.replace(/[:.]/g, "-")}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2));

for (const r of results) {
  console.log(`${r.passed ? "✅" : "❌"} ${r.caseId}${r.failures.length ? "\n     " + r.failures.join("\n     ") : ""}`);
}
console.log(`\n${report.passed}/${report.total} passed → ${reportPath}`);

// ── Optional: POST to canopy-admin so results are observable in the Dashboard. ──
if (process.argv.includes("--post")) {
  const adminUrl = process.env.CANOPY_ADMIN_URL || "http://localhost:3001";
  try {
    const res = await fetch(`${adminUrl}/api/evals/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.CANOPY_ADMIN_KEY ? { "x-admin-key": process.env.CANOPY_ADMIN_KEY } : {}),
      },
      body: JSON.stringify(report),
    });
    console.log(res.ok ? `Posted to ${adminUrl} ✓` : `POST failed: ${res.status}`);
  } catch (err) {
    console.log(`POST failed: ${err?.message || err}`);
  }
}

process.exit(report.failed > 0 ? 1 : 0);
