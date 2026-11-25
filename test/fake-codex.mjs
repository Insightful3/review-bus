#!/usr/bin/env node
// Stands in for `codex exec` in tests. Checks the flags the adapter must pass,
// reads the prompt on stdin and writes reviewer output JSON to --output-last-message.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`fake codex: ${msg}`);
  process.exit(2);
};

if (args[0] !== "exec") fail("expected exec subcommand");
if (args[1] === "review") {
  // codex exec review --uncommitted: needs a git repo whose change is uncommitted; answers in text.
  if (!args.includes("--uncommitted")) fail("expected --uncommitted");
  if (args.includes("-") || args.includes("--output-schema") || args.includes("--cd")) fail("review takes no prompt, schema or --cd");
  const cv = args.filter((x, i) => args[i - 1] === "-c");
  if (!cv.some((x) => x.startsWith("permissions.review-bus.filesystem=")) || !cv.includes('default_permissions="review-bus"')) fail("review needs the read profile");
  for (const flag of ["--ephemeral", "--ignore-user-config"]) if (!args.includes(flag)) fail(`missing ${flag}`);
  const out = args[args.indexOf("--output-last-message") + 1];
  const { execFileSync } = await import("node:child_process");
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd() }).toString();
  const log = execFileSync("git", ["log", "--oneline"], { cwd: process.cwd() }).toString();
  if (!status.trim()) fail("no uncommitted change in the review copy");
  if (log.trim().split("\n").length !== 1) fail("expected exactly one base commit");
  console.error(`model: ${args[args.indexOf("-m") + 1] ?? "fake-default-model"}\nreasoning effort: medium`);
  writeFileSync(out, `The change has a problem.\n\nFull review comments:\n\n- [P1] Fake native finding (${status.trim().split("\n").length} changed) — ${process.cwd()}/index.html:1-1\n  Fake explanation.\n`);
  process.exit(0);
}
// Read-restricted profile instead of --sandbox (the two do not combine in Codex).
if (args.includes("--sandbox")) fail("--sandbox must not be passed with a permission profile");
const cValues = args.filter((x, i) => args[i - 1] === "-c");
const profile = cValues.find((x) => x.startsWith("permissions.review-bus.filesystem="));
if (!profile || !profile.includes('":root"="deny"') || !profile.includes('":workspace_roots"={"."="read"}') || /"write"/.test(profile)) fail(`bad reviewer permission profile: ${profile}`);
if (!cValues.includes('default_permissions="review-bus"')) fail("profile must be selected with default_permissions");
for (const flag of ["--skip-git-repo-check", "--ephemeral", "--ignore-user-config"]) if (!args.includes(flag)) fail(`missing ${flag}`);
for (const feature of ["apps", "plugins", "remote_plugin", "computer_use", "browser_use", "browser_use_external", "hooks", "image_generation"]) {
  if (!args.some((a, i) => a === "--disable" && args[i + 1] === feature)) fail(`feature ${feature} must be disabled`);
}
if (!args.some((a, i) => a === "-c" && args[i + 1] === 'web_search="disabled"')) fail("web search must be disabled");
if (args.at(-1) !== "-") fail("prompt must come from stdin (-)");
const schemaFile = value("--output-schema");
const outFile = value("--output-last-message");
const cd = value("--cd");
if (!schemaFile || !existsSync(schemaFile)) fail("missing --output-schema file");
if (!outFile) fail("missing --output-last-message");
if (!cd || realpathSync(cd) !== realpathSync(process.cwd())) fail("--cd must match the working dir");
const effortArg = args.find((a, i) => args[i - 1] === "-c" && a.startsWith("model_reasoning_effort="));
if (effortArg !== undefined && !/^model_reasoning_effort="(low|medium|high|xhigh|max|ultra)"$/.test(effortArg)) fail(`bad -c value: ${effortArg}`);
// Like real Codex: report the model and effort that ran, using its own defaults when not given.
const model = value("-m") ?? "fake-default-model";
const effort = effortArg ? effortArg.match(/"(.+)"/)[1] : "medium";
console.error(`model: ${model}\nprovider: openai\nreasoning effort: ${effort}`);
const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
if (schema.additionalProperties !== false) fail("schema is not strict");

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (!["<document>", "<diff>", "## Rendered pages", "<review>"].some((m) => prompt.includes(m))) fail("prompt has no document, diff, pages or review text");
  const images = args.filter((a) => a.startsWith("--image=")).map((a) => a.slice(8));
  for (const img of images) if (!existsSync(img)) fail(`image not found: ${img}`);
  writeFileSync(
    outFile,
    JSON.stringify({
      verdict: "changes_requested",
      summary: `Fake codex review. [images=${images.length}]`,
      findings: [
        {
          claim: "Summary total does not match the price table.",
          failure_scenario: "Client disputes the invoice.",
          evidence: "EUR 24,000 vs EUR 22,500.",
          location: { path: "artifact.md", line_start: null, line_end: null, section: "Summary", quote: "Total price: EUR 24,000 excluding VAT." },
          likelihood: "certain",
          impact: "critical",
          suggested_fix: null,
          assumption_challenge: false,
          confidence: 0.9,
        },
      ],
    }),
  );
  console.log("fake codex done");
});
