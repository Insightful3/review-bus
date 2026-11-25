// Checks on this machine that a Codex reviewer can read its review folder and nothing private.
// Runs the reviewer's exact permission profile through `codex sandbox` (no model, no cost).
// Codex permission profiles are beta: run this after upgrading Codex.
// Run: npm run check:isolation
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_READ_PROFILE } from "../dist/src/adapters/index.js";

const root = path.join(os.homedir(), ".review-bus", `isolation-check-${process.pid}`);
const round = path.join(root, "round");
const elsewhere = path.join(root, "elsewhere");
mkdirSync(path.join(round, "tree"), { recursive: true });
mkdirSync(elsewhere, { recursive: true });
writeFileSync(path.join(round, "artifact.md"), "round file\n");
writeFileSync(path.join(round, "tree", "a.ts"), "export const x = 1\n");
writeFileSync(path.join(elsewhere, "secret.txt"), "CANARY\n");

const canRead = (file) => {
  const r = spawnSync("codex", ["sandbox", "-c", CODEX_READ_PROFILE, "-c", 'default_permissions="review-bus"', "-P", "review-bus", "-C", round, "--", "cat", file], { encoding: "utf8" });
  if (r.error) throw new Error(`codex not available: ${r.error.message}`);
  return r.status === 0;
};

const checks = [
  ["review folder: artifact.md", path.join(round, "artifact.md"), true],
  ["review folder: tree/a.ts", path.join(round, "tree", "a.ts"), true],
  ["another folder in ~/.review-bus", path.join(elsewhere, "secret.txt"), false],
  ["~/.codex/auth.json (Codex login)", path.join(os.homedir(), ".codex", "auth.json"), false],
  ["~/.ssh", path.join(os.homedir(), ".ssh", "known_hosts"), false],
  ["~/.review-bus/config.json", path.join(os.homedir(), ".review-bus", "config.json"), false],
];
let failed = 0;
try {
  for (const [label, file, expected] of checks) {
    const got = canRead(file);
    const ok = got === expected;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got ? "readable" : "denied"}${ok ? "" : ` (expected ${expected ? "readable" : "denied"})`}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failed) {
  console.error(`\n${failed} check(s) failed: Codex reviewers are not isolated as expected on this machine.`);
  process.exit(1);
}
console.log("\nCodex reviewers can read their review folder and nothing private.");
