// End-to-end: an MCP client spawns the server over stdio, submits a Markdown document,
// the fake command reviewer runs, and review_result returns the findings.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "test/fixtures/proposal-bluefin.md");

let tmp: string;
let client: Client;

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { res, markdown: res.content[0].text, json: JSON.parse(res.content.at(-1)!.text) };
}

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "review-bus-test-"));
  const fake = () => ({
    type: "command",
    command: process.execPath,
    args: [path.join(ROOT, "test/fake-reviewer.mjs"), "{model}", "{effort}"],
    timeout_seconds: 30,
    model: null as string | null,
  });
  // A rubric that overrides effort and the fake reviewer's model (SPEC 8a).
  mkdirSync(path.join(tmp, "rubrics"));
  writeFileSync(
    path.join(tmp, "rubrics", "effort-test.md"),
    '---\neffort: high\nmodels: {"fake": "rubric-model"}\n---\n# Effort test\n\nCheck anything.\n',
  );
  const config = {
    rubric_paths: [path.join(tmp, "rubrics")],
    storage: { documents: path.join(tmp, "reviews") },
    // The test client counts as an OpenAI author, so codex is filtered out of the defaults.
    default_reviewers: ["codex", "fake"],
    author_vendors: { "test-author": "openai" },
    adapters: {
      fake: fake(),
      broken: { ...fake(), command: "/nonexistent/reviewer" },
      codex: { type: "codex", command: path.join(ROOT, "test/fake-codex.mjs"), timeout_seconds: 30 },
      claude: { type: "claude", command: path.join(ROOT, "test/fake-claude.mjs"), timeout_seconds: 30 },
      claude_err: { type: "claude", command: path.join(ROOT, "test/fake-claude.mjs"), args: ["--fake-mode=error"], timeout_seconds: 30 },
    },
  };
  const configFile = path.join(tmp, "config.json");
  writeFileSync(configFile, JSON.stringify(config));
  client = new Client({ name: "test-author", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "dist/src/server.js")],
      env: { ...(process.env as Record<string, string>), REVIEW_BUS_CONFIG: configFile },
      stderr: "inherit",
    }),
  );
});

after(async () => {
  await client?.close();
});

test("full loop: submit a Markdown proposal, fake reviewer finds issues, result comes back", async () => {
  const submit = await call("review_submit", {
    artifact: FIXTURE,
    rubric: "proposal",
    intent: "Win the Bluefin support assistant project at a fixed price.",
    assumptions: ["Bluefin gives API access by end of January"],
    wait_seconds: 30,
  });
  assert.equal(submit.res.isError, undefined, submit.markdown);
  const id = submit.json.review_id;
  assert.match(id, /^rv_[0-9a-z]{26}$/);
  assert.equal(submit.json.state, "changes_requested");

  const result = await call("review_result", { review_id: id, include_advisory: true });
  const { json } = result;
  assert.equal(json.state, "changes_requested");
  assert.equal(json.round, 1);
  assert.equal(json.reviewers[0].status, "done");
  assert.equal(json.reviewers[0].verdict, "changes_requested");
  // critical/certain and high/likely block; medium/possible and the one with no failure scenario do not.
  assert.deepEqual(
    json.findings.map((f: { finding_id: string; blocking: boolean }) => [f.finding_id, f.blocking]),
    [["r1.f1", true], ["r1.f2", true], ["r1.f3", false], ["r1.f4", false]],
  );
  assert.deepEqual(json.counts, { blocking: 2, advisory: 2, over_limit: 0 });
  assert.match(result.markdown, /State: \*\*changes_requested\*\*/);

  // Without include_advisory only blocking findings come back.
  const blockingOnly = await call("review_result", { review_id: id });
  assert.equal(blockingOnly.json.findings.length, 2);

  // Storage: snapshot copy, prompt, raw reviewer output and report, outside the repo.
  const dir = path.join(tmp, "reviews", id);
  const review = JSON.parse(readFileSync(path.join(dir, "review.json"), "utf8"));
  assert.equal(readFileSync(path.join(dir, "r1/artifact.md"), "utf8"), readFileSync(FIXTURE, "utf8"));
  assert.equal(review.rounds[0].snapshot.sha256.length, 64);
  assert.ok(existsSync(path.join(dir, "r1/prompt.md")));
  assert.ok(existsSync(path.join(dir, "r1/fake.json")));
  assert.match(readFileSync(path.join(dir, "report.md"), "utf8"), /## History/);
  assert.match(readFileSync(path.join(dir, "r1/prompt.md"), "utf8"), /## Rubric: proposal/);
});

test("submit without waiting returns in_review, then the result lands", async () => {
  const submit = await call("review_submit", { artifact: FIXTURE, rubric: "proposal", intent: "x" });
  assert.equal(submit.json.state, "in_review");
  let state = "in_review";
  for (let i = 0; i < 50 && state === "in_review"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    state = (await call("review_result", { review_id: submit.json.review_id })).json.state;
  }
  assert.equal(state, "changes_requested");
});

test("a reviewer that cannot start marks the round failed with the error", async () => {
  const { json } = await call("review_submit", { artifact: FIXTURE, rubric: "proposal", intent: "x", reviewers: ["broken"], wait_seconds: 10 });
  assert.equal(json.state, "failed");
  assert.match(json.reviewers[0].error, /ENOENT/);
});

test("codex adapter passes the right flags and reads the -o file", async () => {
  const { json } = await call("review_submit", { artifact: FIXTURE, rubric: "proposal", intent: "x", reviewers: ["codex"], wait_seconds: 10 });
  assert.equal(json.reviewers[0].status, "done", json.reviewers[0].error ?? "");
  assert.equal(json.state, "changes_requested");
  // No model or effort requested: the fake reports its own defaults, like real Codex.
  assert.equal(json.findings[0].reviewer, "codex:fake-default-model:medium");
  assert.equal(json.reviewers[0].model_source, "reported");
  assert.equal(json.reviewers[0].effort_source, "reported");
  assert.match(json.notes.join(" "), /same vendor as the author \(openai\)/);
});

test("per-call model and effort are passed to codex and recorded", async () => {
  const { json, markdown } = await call("review_submit", {
    artifact: FIXTURE,
    rubric: "proposal",
    intent: "x",
    reviewers: [{ name: "codex", model: "gpt-test", effort: "xhigh" }],
    wait_seconds: 10,
  });
  assert.equal(json.reviewers[0].status, "done", json.reviewers[0].error ?? "");
  assert.equal(json.reviewers[0].label, "codex:gpt-test:xhigh");
  assert.equal(json.findings[0].reviewer, "codex:gpt-test:xhigh");
  assert.match(markdown, /codex:gpt-test:xhigh \(codex, openai\)/);
});

test("default reviewers skip the author's vendor", async () => {
  const { json } = await call("review_submit", { artifact: FIXTURE, rubric: "proposal", intent: "x", wait_seconds: 10 });
  assert.deepEqual(json.author, { client: "test-author", vendor: "openai", vendor_source: "client" });
  assert.deepEqual(json.reviewers.map((r: { name: string }) => r.name), ["fake"]);
  assert.deepEqual(json.notes, []);

  const other = await call("review_submit", { artifact: FIXTURE, rubric: "proposal", intent: "x", author_vendor: "other", wait_seconds: 10 });
  assert.deepEqual(other.json.reviewers.map((r: { name: string }) => r.name), ["codex"]);
  assert.equal(other.json.author.vendor_source, "declared");
});

test("effort: stage defaults, rubric beats stage, call beats rubric", async () => {
  const run = async (args: Record<string, unknown>) =>
    (await call("review_submit", { artifact: FIXTURE, intent: "x", reviewers: ["fake"], wait_seconds: 10, ...args })).json.reviewers[0];

  const release = await run({ rubric: "proposal", stage: "release" });
  assert.equal(release.label, "fake:default:high");
  assert.equal(release.effort_source, "stage");
  assert.match(release.summary, /model= effort=high argv=,high images=0\]/);

  const draft = await run({ rubric: "proposal", stage: "draft" });
  assert.equal(draft.label, "fake:default:medium");

  const premerge = await run({ rubric: "proposal", stage: "pre-merge" });
  assert.equal(premerge.label, "fake:default:default");
  assert.equal(premerge.effort_source, "cli_default");

  const rubric = await run({ rubric: "effort-test", stage: "draft" });
  assert.equal(rubric.label, "fake:rubric-model:high");
  assert.deepEqual([rubric.model_source, rubric.effort_source], ["rubric", "rubric"]);
  assert.match(rubric.summary, /model=rubric-model effort=high argv=rubric-model,high images=0\]/);

  const callWins = await run({ rubric: "effort-test", reviewers: [{ name: "fake", model: "call-model", effort: "low" }] });
  assert.equal(callWins.label, "fake:call-model:low");
});

test("ultra effort is refused for a non-codex reviewer", async () => {
  const args = { artifact: FIXTURE, rubric: "proposal", intent: "x", reviewers: [{ name: "fake", effort: "ultra" }] };
  const res = (await client.callTool({ name: "review_submit", arguments: args })) as ToolResult;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /does not support effort "ultra"/);
});

test("claude adapter: read-only flags, structured output, model from modelUsage", async () => {
  const plain = await call("review_submit", { artifact: FIXTURE, rubric: "proposal", intent: "x", reviewers: ["claude"], wait_seconds: 10 });
  const r = plain.json.reviewers[0];
  assert.equal(r.status, "done", r.error ?? "");
  assert.deepEqual([r.vendor, r.label, r.model_source, r.effort_source], ["anthropic", "claude:claude-fake-default:default", "reported", "cli_default"]);
  assert.equal(plain.json.findings[0].reviewer, "claude:claude-fake-default:default");

  const tuned = await call("review_submit", {
    artifact: FIXTURE,
    rubric: "proposal",
    intent: "x",
    reviewers: [{ name: "claude", model: "claude-test-model", effort: "high" }],
    wait_seconds: 10,
  });
  const t = tuned.json.reviewers[0];
  assert.deepEqual([t.label, t.model_source, t.effort_source], ["claude:claude-test-model:high", "reported", "call"]);
  assert.match(tuned.markdown, /effort high \(requested, from call\)/);
});

test("claude adapter surfaces an error envelope as a failed reviewer", async () => {
  const { json } = await call("review_submit", { artifact: FIXTURE, rubric: "proposal", intent: "x", reviewers: ["claude_err"], wait_seconds: 10 });
  assert.equal(json.state, "failed");
  assert.match(json.reviewers[0].error, /error_max_turns/);
});

test("rejects unknown rubric, unknown reviewer and unsupported file type", async () => {
  const bad = [
    { artifact: FIXTURE, rubric: "nope", intent: "x" },
    { artifact: FIXTURE, rubric: "proposal", intent: "x", reviewers: ["ghost"] },
    { artifact: path.join(ROOT, "package.json"), rubric: "proposal", intent: "x" },
  ];
  for (const args of bad) {
    const res = (await client.callTool({ name: "review_submit", arguments: args })) as ToolResult;
    assert.equal(res.isError, true, JSON.stringify(args));
  }
});

test("the same reviewer named twice is refused", async () => {
  const res = (await client.callTool({ name: "review_submit", arguments: { artifact: FIXTURE, rubric: "proposal", intent: "x", reviewers: ["fake", { name: "fake", model: "other" }] } })) as ToolResult;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Reviewer "fake" is named twice/);
});
