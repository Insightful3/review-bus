#!/usr/bin/env node
// Stands in for `agy -p` (Antigravity CLI) in tests. Checks the flags the adapter must pass (the
// read-only deny rules above all), reads the prompt from -p or from the file it names, and prints a
// `--output-format json` envelope like agy 1.5.18: the answer is a string in "response", here with an
// earlier schema-invalid attempt on the line before it, as agy was seen to print.
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`fake agy: ${msg}`);
  process.exit(2);
};

if (value("--output-format") !== "json") fail("output format must be json");
for (const flag of ["--sandbox", "--disable-slash-commands"]) if (!args.includes(flag)) fail(`missing ${flag}`);
const settings = JSON.parse(value("--settings") ?? "null");
const deny = settings?.permissions?.deny ?? [];
for (const rule of ["write_file(/)", "command(regex:.*)", "mcp(*)"]) if (!deny.includes(rule)) fail(`missing deny rule ${rule}`);
const schemaFile = value("--json-schema");
if (!schemaFile || !existsSync(schemaFile) || JSON.parse(readFileSync(schemaFile, "utf8")).additionalProperties !== false) fail("missing or non-strict --json-schema file");
const effort = value("--effort");
if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) fail(`bad effort ${effort}`);
const arg = value("-p") ?? fail("missing -p");
// The work under review never goes on the command line, where other users can see it.
if (!arg.includes("agy-prompt.md") || ["<document>", "<diff>", "## Rendered pages"].some((m) => arg.includes(m))) fail("the prompt must be read from agy-prompt.md, not passed as an argument");
const prompt = readFileSync("agy-prompt.md", "utf8");
if (!["<document>", "<diff>", "## Rendered pages"].some((m) => prompt.includes(m))) fail("prompt has no document, diff or pages");
const mode = args.find((a) => a.startsWith("--fake-mode="))?.split("=")[1] ?? "ok";

if (mode === "denied") {
  console.log(JSON.stringify({ status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "Bash" }] }));
} else if (mode === "error") {
  console.log(JSON.stringify({ status: "ERROR", response: "", error: { message: "model not available" } }));
} else {
  const finding = {
    claim: "The total price in the summary does not match the price table.",
    failure_scenario: "The client disputes the first invoice.",
    evidence: "Summary and table differ.",
    location: { path: "artifact.md", line_start: null, line_end: null, section: "Summary", quote: null },
    likelihood: "certain",
    impact: "critical",
    suggested_fix: "Use one total.",
    assumption_challenge: false,
    confidence: 0.9,
  };
  const { failure_scenario: _f, ...invalid } = finding;
  const first = JSON.stringify({ verdict: "changes_requested", summary: "First attempt.", findings: [invalid] });
  const answer = JSON.stringify({ verdict: "changes_requested", summary: `Fake agy review. [prompt ${prompt.length} chars]`, findings: [finding] });
  console.log(JSON.stringify({ conversation_id: "fake", status: "SUCCESS", response: `${first}\n${answer}\n`, usage: { input_tokens: 1 } }));
}
