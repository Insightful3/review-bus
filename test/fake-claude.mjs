#!/usr/bin/env node
// Stands in for `claude -p` in tests. Checks the read-only flags the adapter must pass,
// reads the prompt on stdin and prints a `--output-format json` envelope like Claude Code.
const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`fake claude: ${msg}`);
  process.exit(2);
};

if (!args.includes("-p")) fail("missing -p");
if (value("--output-format") !== "json") fail("output format must be json");
if (value("--tools") !== "Read,Grep,Glob") fail(`tools must be read-only, got ${value("--tools")}`);
if (value("--permission-prompts") !== "none") fail("permission prompts must be none");
for (const flag of ["--restricted", "--strict-mcp-config", "--no-session-persistence"]) if (!args.includes(flag)) fail(`missing ${flag}`);
const schema = JSON.parse(value("--json-schema") ?? "null");
if (!schema || schema.additionalProperties !== false) fail("missing or non-strict --json-schema");
const effort = value("--effort");
if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) fail(`bad effort ${effort}`);
const model = value("--model") ?? "claude-fake-default";
// Test-only: an extra arg from the adapter config picks a failure mode.
const mode = args.find((a) => a.startsWith("--fake-mode="))?.split("=")[1] ?? "ok";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (!["<document>", "<diff>", "## Rendered pages"].some((m) => prompt.includes(m))) fail("prompt has no document, diff or pages");
  if (mode === "error") {
    console.log(JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns", result: "ran out of turns" }));
    return;
  }
  const output = {
    verdict: "changes_requested",
    summary: "Fake claude review.",
    findings: [
      {
        claim: "The 70% resolution rate is promised as a result.",
        failure_scenario: "The client withholds payment when the rate is lower.",
        evidence: "Results section.",
        location: { path: "artifact.md", line_start: null, line_end: null, section: "Results", quote: "The assistant will resolve 70%" },
        likelihood: "likely",
        impact: "high",
        suggested_fix: null,
        assumption_challenge: false,
        confidence: 0.8,
      },
    ],
  };
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(output),
      structured_output: output,
      modelUsage: { [model]: { inputTokens: 1, outputTokens: 1 } },
    }),
  );
});
