// MCP Tasks: review_submit, review_respond and review_wait called as tasks return at once and
// complete when the round finishes; plain calls behave as before.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "test/fixtures/proposal-bluefin.md");
let client: Client;

type Message = { type: string; task?: { taskId: string; status: string }; result?: { content: { type: string; text: string }[] }; error?: unknown };

/** Calls a tool as an MCP task and records each message with the time it arrived. */
async function asTask(name: string, args: Record<string, unknown>) {
  const started = Date.now();
  const seen: (Message & { at: number })[] = [];
  for await (const m of client.experimental.tasks.callToolStream({ name, arguments: args }, undefined, { task: { ttl: 60_000 } })) {
    seen.push({ ...(m as Message), at: Date.now() - started });
  }
  return seen;
}

const lastJson = (r: { content: { text: string }[] }) => JSON.parse(r.content.filter((c) => c.text.trim().startsWith("{")).at(-1)!.text);

before(async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "review-bus-tasks-"));
  const fake = (extra: string[]) => ({ type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs"), ...extra], timeout_seconds: 30 });
  const configFile = path.join(tmp, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      storage: { documents: path.join(tmp, "reviews") },
      default_reviewers: ["slowish"],
      adapters: { slowish: fake(["--sleep=2000"]), slower: fake(["--sleep=12000"]) },
      max_wait_seconds: 3,
    }),
  );
  client = new Client({ name: "task-author", version: "0.0.0" }, { capabilities: {} });
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

test("the server declares task support for tools/call, and which tools support tasks", async () => {
  assert.ok(client.getServerCapabilities()?.tasks?.requests?.tools?.call);
  const { tools } = await client.listTools();
  const support = Object.fromEntries(tools.map((t) => [t.name, (t as { execution?: { taskSupport?: string } }).execution?.taskSupport ?? "none"]));
  assert.deepEqual(
    [support.review_submit, support.review_respond, support.review_wait],
    ["optional", "optional", "optional"],
  );
  assert.notEqual(support.review_result, "optional");
});

test("review_submit as a task: the task is created at once and completes with the result when the round ends", async () => {
  const seen = await asTask("review_submit", { artifact: FIXTURE, rubric: "proposal", intent: "x" });
  const created = seen.find((m) => m.type === "taskCreated")!;
  const result = seen.find((m) => m.type === "result")!;
  assert.ok(created, JSON.stringify(seen));
  assert.ok(created.at < 1500, `task should be created at once, took ${created.at} ms`);
  assert.ok(result, JSON.stringify(seen));
  assert.ok(result.at >= 2000, "the result arrives when the reviewer (2 s) is done");
  const payload = lastJson(result.result!);
  assert.equal(payload.state, "changes_requested");
  assert.equal(payload.counts.blocking, 2);
});

test("review_wait as a task completes when the round ends, with no 50 s cap; plain calls are unchanged", async () => {
  const plain = (await client.callTool({ name: "review_submit", arguments: { artifact: FIXTURE, rubric: "proposal", intent: "x" } })) as { content: { text: string }[] };
  const { review_id, state } = JSON.parse(plain.content[0].text);
  assert.equal(state, "in_review"); // plain call, wait_seconds 0: returns at once as before
  const seen = await asTask("review_wait", { review_id, seconds: 1 });
  const result = seen.find((m) => m.type === "result")!;
  assert.ok(result, JSON.stringify(seen));
  assert.equal(lastJson(result.result!).state, "changes_requested"); // not capped at 1 s
});

test("review_respond with resubmit as a task completes with the next round's result", async () => {
  const first = await asTask("review_submit", { artifact: FIXTURE, rubric: "proposal", intent: "x" });
  const r1 = lastJson(first.find((m) => m.type === "result")!.result!);
  const responses = r1.findings.map((f: { finding_id: string }) => ({ finding_id: f.finding_id, status: "deferred", note: "Later." }));
  const seen = await asTask("review_respond", { review_id: r1.review_id, responses, resubmit: true });
  const payload = lastJson(seen.find((m) => m.type === "result")!.result!);
  assert.deepEqual([payload.round, payload.state], [2, "changes_requested"]);
});

test("errors in a task call come back as a tool error, not a hung task", async () => {
  const seen = await asTask("review_submit", { artifact: "/nope/missing.md", rubric: "proposal", intent: "x" });
  const result = seen.find((m) => m.type === "result")!;
  assert.ok(result, JSON.stringify(seen));
  assert.match(result.result!.content[0].text, /Artifact not found/);
});

test("a client that sends a progressToken can wait for the whole round; progress keeps the call alive", async () => {
  const args = { artifact: FIXTURE, rubric: "proposal", intent: "x", reviewers: ["slower"], wait_seconds: 600 };
  // Without a progress token: capped at max_wait_seconds (3 s here).
  const capped = (await client.callTool({ name: "review_submit", arguments: args })) as { content: { text: string }[] };
  assert.equal(JSON.parse(capped.content[0].text).state, "in_review");

  // With one: progress every 10 s, and the answer is the finished round.
  const progress: { progress: number; message?: string }[] = [];
  const started = Date.now();
  const done = (await client.callTool({ name: "review_submit", arguments: args }, undefined, {
    onprogress: (p) => progress.push(p),
    resetTimeoutOnProgress: true,
    timeout: 60_000,
  })) as { content: { text: string }[] };
  assert.equal(lastJson(done).state, "changes_requested");
  assert.ok(Date.now() - started >= 12_000);
  assert.ok(progress.length >= 1, "at least one progress notification");
  assert.match(progress[0].message ?? "", /Round 1: 0 of 1 reviewer\(s\) done; still working: slower:default:default \(1\d s\)/);
});
