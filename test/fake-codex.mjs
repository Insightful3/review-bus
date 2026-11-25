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
if (value("--sandbox") !== "read-only") fail("sandbox must be read-only");
for (const flag of ["--skip-git-repo-check", "--ephemeral"]) if (!args.includes(flag)) fail(`missing ${flag}`);
if (args.at(-1) !== "-") fail("prompt must come from stdin (-)");
const schemaFile = value("--output-schema");
const outFile = value("--output-last-message");
const cd = value("--cd");
if (!schemaFile || !existsSync(schemaFile)) fail("missing --output-schema file");
if (!outFile) fail("missing --output-last-message");
if (!cd || realpathSync(cd) !== realpathSync(process.cwd())) fail("--cd must match the working dir");
const effortArg = value("-c");
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
  if (!["<document>", "<diff>", "## Rendered pages"].some((m) => prompt.includes(m))) fail("prompt has no document, diff or pages");
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
