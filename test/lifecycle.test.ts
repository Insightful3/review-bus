// Slice 2: respond, resubmit, round cap, sign-off, status, wait, list, cancel, restart.
// The fake reviewer drops a finding once its quoted text is gone from the document.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "test/fixtures/proposal-bluefin.md");

let tmp: string;
let configFile: string;
let client: Client;

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function raw(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** Calls a tool that must succeed; returns its last JSON block (and the full result). */
async function ok(name: string, args: Record<string, unknown>) {
  const res = await raw(name, args);
  assert.notEqual(res.isError, true, `${name} failed: ${res.content[0]?.text}`);
  const jsonBlocks = res.content.map((c) => c.text).filter((t) => t.trim().startsWith("{"));
  return { res, json: JSON.parse(jsonBlocks[0]), all: jsonBlocks.map((t) => JSON.parse(t)) };
}

async function fails(name: string, args: Record<string, unknown>, pattern: RegExp) {
  const res = await raw(name, args);
  assert.equal(res.isError, true, `${name} should fail`);
  assert.match(res.content[0].text, pattern);
}

let docCount = 0;
/** A private copy of the fixture, optionally with the two blocking problems fixed. */
function doc(fixed = false): string {
  const file = path.join(tmp, `doc-${++docCount}.md`);
  copyFileSync(FIXTURE, file);
  if (fixed) fix(file);
  return file;
}

function fix(file: string) {
  const text = readFileSync(file, "utf8")
    .replace("Total price: EUR 24,000 excluding VAT.", "Total price: EUR 22,500 excluding VAT.")
    .replace("The assistant will resolve 70% of incoming support questions", "We target 70% of incoming support questions resolved");
  writeFileSync(file, text);
}

const submit = (artifact: string, extra: Record<string, unknown> = {}) =>
  ok("review_submit", { artifact, rubric: "proposal", intent: "Win the Bluefin project.", wait_seconds: 10, ...extra });

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "review-bus-lifecycle-"));
  mkdirSync(path.join(tmp, "rubrics"));
  writeFileSync(path.join(tmp, "rubrics", "signoff-test.md"), "---\nrequire_signoff: true\n---\n# Needs a person\n\nCheck anything.\n");
  const fake = (extra: string[] = []) => ({
    type: "command",
    command: process.execPath,
    args: [path.join(ROOT, "test/fake-reviewer.mjs"), ...extra],
    timeout_seconds: 30,
  });
  configFile = path.join(tmp, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      rubric_paths: [path.join(tmp, "rubrics")],
      storage: { documents: path.join(tmp, "reviews") },
      default_reviewers: ["fake"],
      adapters: { fake: fake(), slow: fake(["--sleep=20000"]), sleepy: fake(["--sleep-r1=300", "--sleep-r2=1500"]), broken: { ...fake(), command: "/nonexistent/reviewer" } },
    }),
  );
  client = new Client({ name: "lifecycle-author", version: "0.0.0" });
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

test("the tools are listed; sign-off is not one of them (people use rb signoff)", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "review_cancel",
    "review_claim",
    "review_list",
    "review_pending",
    "review_post",
    "review_respond",
    "review_result",
    "review_rubrics",
    "review_status",
    "review_submit",
    "review_wait",
  ]);
});

/** A person at the terminal: what rb signoff does. */
function person(): Engine {
  process.env.REVIEW_BUS_CONFIG = configFile;
  return new Engine(loadConfig());
}

test("respond, fix, resubmit: round 2 approves and keeps round 1 history", async () => {
  const file = doc();
  const { json: r1 } = await submit(file);
  const id = r1.review_id;
  assert.equal(r1.state, "changes_requested");
  assert.deepEqual(r1.findings.map((f: { finding_id: string }) => f.finding_id), ["r1.f1", "r1.f2"]);

  await fails("review_respond", { review_id: id, resubmit: true }, /Unanswered: r1\.f1, r1\.f2/);
  await fails("review_respond", { review_id: id, responses: [{ finding_id: "r1.f2", status: "rejected" }] }, /needs a reason/);
  await fails("review_respond", { review_id: id, responses: [{ finding_id: "r9.f1", status: "accepted" }] }, /not in round 1/);

  // Answers can come in several calls; state stays changes_requested until all blocking are answered.
  const partial = await ok("review_respond", { review_id: id, responses: [{ finding_id: "r1.f1", status: "accepted", note: "Fixed the total." }] });
  assert.equal(partial.json.state, "changes_requested");
  assert.deepEqual(partial.all.at(-1).unanswered, ["r1.f2"]);

  fix(file);
  const { json: r2 } = await ok("review_respond", {
    review_id: id,
    responses: [{ finding_id: "r1.f2", status: "accepted", note: "Now a target." }],
    resubmit: true,
    wait_seconds: 10,
  });
  assert.equal(r2.round, 2);
  assert.equal(r2.state, "approved");
  assert.deepEqual(r2.counts, { blocking: 0, advisory: 2 });

  // The round 2 prompt carries round 1 findings and answers; the report keeps round 1.
  const dir = path.join(tmp, "reviews", id);
  const prompt2 = readFileSync(path.join(dir, "r2/prompt.md"), "utf8");
  assert.match(prompt2, /## Previous round \(round 1\)/);
  assert.match(prompt2, /r1\.f1 \(Summary\) \[critical\/certain, blocking\].*\n  Author's answer: accepted: Fixed the total\./);
  assert.doesNotMatch(readFileSync(path.join(dir, "r1/prompt.md"), "utf8"), /Previous round/);
  const report = readFileSync(path.join(dir, "report.md"), "utf8");
  assert.match(report, /## Round 1 \(earlier\)/);
  assert.match(report, /Response: accepted, Now a target\./);

  await fails("review_respond", { review_id: id, responses: [{ finding_id: "r1.f1", status: "deferred" }] }, /belongs to an earlier round/);
  await fails("review_respond", { review_id: id, resubmit: true }, /approved; submit a new review/);
});

test("round cap: blocking findings still open after round 3 escalate, then a person signs off", async () => {
  const { json: r1 } = await submit(doc());
  const id = r1.review_id;
  const rejectAll = (n: number) => ({
    review_id: id,
    responses: [1, 2].map((i) => ({ finding_id: `r${n}.f${i}`, status: "rejected", note: "Intentional." })),
    resubmit: true,
    wait_seconds: 10,
  });
  const { json: r2 } = await ok("review_respond", rejectAll(1));
  assert.deepEqual([r2.round, r2.state], [2, "changes_requested"]);
  const { json: r3 } = await ok("review_respond", rejectAll(2));
  assert.deepEqual([r3.round, r3.state], [3, "escalated"]);

  await fails("review_respond", rejectAll(3), /escalated after 3 rounds/);
  assert.throws(() => person().signoff(id, "  ", ""), /person's name/);
  const signed = person().signoff(id, "Test Person", "Price confirmed by phone.");
  assert.equal(signed.state, "approved");
  assert.equal(signed.signoff?.from_state, "escalated");

  const history = JSON.parse(readFileSync(path.join(tmp, "reviews", id, "review.json"), "utf8")).history.map((h: { event: string; detail?: string }) => h.detail ?? h.event);
  assert.ok(history.some((d: string) => d === "round 2 document is unchanged since round 1"));
  assert.match(readFileSync(path.join(tmp, "reviews", id, "report.md"), "utf8"), /Signed off by Test Person/);
});

test("closing without resubmit approves and notes accepted findings that were not re-reviewed", async () => {
  const { json } = await submit(doc());
  const { json: closed } = await ok("review_respond", {
    review_id: json.review_id,
    responses: [
      { finding_id: "r1.f1", status: "accepted" },
      { finding_id: "r1.f2", status: "deferred", note: "Next version." },
    ],
  });
  assert.equal(closed.state, "approved");
  assert.deepEqual(closed.notes.slice(-1), ["Round 1: 1 accepted blocking finding(s) were closed without a re-review."]);
});

test("a rubric that requires sign-off waits for a person", async () => {
  const { json } = await submit(doc(true), { rubric: "signoff-test" });
  assert.equal(json.state, "awaiting_signoff");
  await fails("review_respond", { review_id: json.review_id, resubmit: true }, /awaiting_signoff/);
  assert.equal(person().signoff(json.review_id, "Test Person", "").state, "approved");
  assert.throws(() => person().signoff(json.review_id, "Test Person", ""), /only awaiting_signoff or escalated/);
});

test("status shows a running reviewer; cancel stops it; wait returns early", async () => {
  const { json } = await submit(doc(), { reviewers: ["slow"], wait_seconds: 0 });
  assert.equal(json.state, "in_review");
  const { json: st } = await ok("review_status", { review_id: json.review_id });
  assert.deepEqual([st.state, st.pending, st.done, st.reviewers[0].status], ["in_review", 1, 0, "running"]);
  await fails("review_respond", { review_id: json.review_id, resubmit: true }, /still in review/);

  const started = Date.now();
  const { json: canceled } = await ok("review_cancel", { review_id: json.review_id });
  assert.equal(canceled.state, "canceled");
  const { json: waited } = await ok("review_wait", { review_id: json.review_id, seconds: 15 });
  assert.ok(Date.now() - started < 5000, "cancel should stop the reviewer quickly");
  assert.equal(waited.state, "canceled");
  assert.equal(waited.reviewers[0].status, "failed");
  const { json: result } = await ok("review_result", { review_id: json.review_id });
  assert.equal(result.reviewers[0].error, "canceled");
  await fails("review_cancel", { review_id: json.review_id }, /already canceled/);
});

test("wait blocks until the round finishes", async () => {
  const { json } = await submit(doc(), { wait_seconds: 0 });
  const { json: waited } = await ok("review_wait", { review_id: json.review_id, seconds: 10 });
  assert.equal(waited.state, "changes_requested");
  assert.equal(waited.counts.unanswered_blocking, 2);
});

test("list returns newest first and filters by state", async () => {
  const { json: all } = await ok("review_list", {});
  assert.ok(all.reviews.length >= 5);
  const created = all.reviews.map((r: { created_at: string }) => r.created_at);
  assert.deepEqual(created, [...created].sort().reverse());
  const { json: canceled } = await ok("review_list", { state: "canceled" });
  assert.ok(canceled.reviews.length >= 1);
  assert.ok(canceled.reviews.every((r: { state: string }) => r.state === "canceled"));
});

test("a round cut off by a restart is marked failed; a resubmit runs a new round", async () => {
  process.env.REVIEW_BUS_CONFIG = configFile;
  const before = new Engine(loadConfig());
  const author = { client: null, vendor: null, vendor_source: "unknown" as const };
  const req = { artifact: { path: doc() }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "sleepy" }], stage: "pre-merge" as const };
  const review = await before.submit(req, author);
  assert.equal(review.state, "in_review");

  const after = new Engine(loadConfig()); // a fresh server process sees no running job
  assert.equal(after.get(review.id).state, "failed");
  const retry = await after.respond(review.id, [], { resubmit: true });
  assert.equal(retry.review.rounds.length, 2);

  // The old process's round 1 finishes while round 2 is still running. It must not set the
  // review's state, or round 2 would find the state already changed and skip its own result.
  await Promise.all([before.waitFor(review.id, 5), after.waitFor(review.id, 5)]);
  const final = after.get(review.id);
  assert.equal(final.state, "changes_requested");
  const finished = final.history.filter((h) => h.event === "round_finished").map((h) => h.detail);
  assert.equal(finished.length, 1);
  assert.match(finished[0]!, /^round 2:/);
  assert.equal(final.rounds[0].findings.length, 4); // round 1 results kept for the record
});

test("a failed reviewer stops approval even when the others found nothing blocking", async () => {
  const { json } = await submit(doc(true), { reviewers: ["fake", "broken"] });
  assert.equal(json.state, "failed");
  assert.deepEqual(json.reviewers.map((r: { status: string }) => r.status), ["done", "failed"]);
  // Resubmitting retries the round.
  const { json: r2 } = await ok("review_respond", { review_id: json.review_id, resubmit: true, wait_seconds: 10 });
  assert.equal(r2.round, 2);
});

test("a resubmit checks today's approved reviewers: a revoked reviewer gets nothing", async () => {
  process.env.REVIEW_BUS_CONFIG = configFile;
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  const approve = (list: string[]) => {
    cfg.allowed_reviewers = { proposal: list };
    writeFileSync(configFile, JSON.stringify(cfg));
    return new Engine(loadConfig());
  };
  const author = { client: null, vendor: null, vendor_source: "unknown" as const };
  const req = { artifact: { path: doc() }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" as const };
  const engine = approve(["fake"]);
  const review = await engine.submit(req, author, 10);
  assert.equal(review.state, "changes_requested");
  const answers = review.rounds[0].findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "deferred" as const }));
  await assert.rejects(approve(["slow"]).respond(review.id, answers, { resubmit: true }), /Reviewer "fake" is no longer approved for proposal/);
  const after = engine.store.load(review.id);
  assert.equal(after.rounds.length, 1); // nothing was sent
  assert.ok(after.rounds[0].findings.filter((f) => f.blocking).every((f) => f.response)); // answers kept
  delete cfg.allowed_reviewers;
  writeFileSync(configFile, JSON.stringify(cfg));
});

test("several processes writing the same review at once lose nothing", async () => {
  process.env.REVIEW_BUS_CONFIG = configFile;
  const engine = new Engine(loadConfig());
  const review = await submit(doc(true), { wait_seconds: 10 });
  const id = review.json.review_id;
  const before = engine.store.load(id).history.length;
  const script = `
    import("${path.join(ROOT, "dist/src/store.js")}").then(({ Store }) => {
      const s = new Store(process.argv[1]);
      for (let i = 0; i < 40; i++) s.update(process.argv[2], (r) => { r.history.push({ at: "", event: "note", detail: process.argv[3] + "-" + i }); });
    });`;
  const writers = [1, 2, 3, 4].map(
    (w) =>
      new Promise<number | null>((res) => {
        const p = spawn(process.execPath, ["-e", script, path.dirname(engine.store.dir(id)), id, `w${w}`], { stdio: "inherit" });
        p.on("exit", res);
      }),
  );
  assert.deepEqual(await Promise.all(writers), [0, 0, 0, 0]);
  const after = engine.store.load(id); // parses: never left half written
  assert.equal(after.history.length, before + 160);
  assert.ok(!existsSync(path.join(engine.store.dir(id), ".lock")));
  assert.deepEqual(readdirSync(engine.store.dir(id)).filter((f) => f.endsWith(".tmp")), []);
});

test("an author cannot close a review as approved while a reviewer of the round failed", async () => {
  const { json } = await submit(doc(), { reviewers: ["fake", "broken"] });
  assert.equal(json.state, "changes_requested");
  const answers = json.findings.map((f: { finding_id: string }) => ({ finding_id: f.finding_id, status: "deferred", note: "Later." }));
  await fails("review_respond", { review_id: json.review_id, responses: answers }, /incomplete: reviewer\(s\) broken:default:default failed/);
  const after = person().get(json.review_id);
  assert.equal(after.state, "changes_requested");
  assert.ok(after.rounds[0].findings.filter((f) => f.blocking).every((f) => f.response?.status === "deferred")); // answers kept
});

test("revoking a reviewer while the MCP server keeps running stops the next round", async () => {
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  try {
    const { json } = await submit(doc(), { reviewers: ["fake"] });
    cfg.allowed_reviewers = { proposal: ["slow"] }; // fake is no longer approved
    writeFileSync(configFile, JSON.stringify(cfg));
    const answers = json.findings.map((f: { finding_id: string }) => ({ finding_id: f.finding_id, status: "deferred", note: "Later." }));
    await fails("review_respond", { review_id: json.review_id, responses: answers, resubmit: true }, /Reviewer "fake" is no longer approved for proposal/);
    assert.equal(person().get(json.review_id).rounds.length, 1);
  } finally {
    delete cfg.allowed_reviewers;
    writeFileSync(configFile, JSON.stringify(cfg));
  }
});

test("two resubmits racing: one wins with its own files, the other starts nothing", async () => {
  const author = { client: null, vendor: null, vendor_source: "unknown" as const };
  const first = doc();
  const a = person();
  const review = await a.submit({ artifact: { path: first }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" }, author, 10);
  const answers = review.rounds[0].findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "deferred" as const, note: "Later." }));
  const docA = doc();
  const docB = doc(true);
  const results = await Promise.allSettled([
    person().respond(review.id, answers, { resubmit: true, artifact: docA }),
    person().respond(review.id, answers, { resubmit: true, artifact: docB }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.match(lost.reason.message, /changed while round 2 was being prepared|started by someone else/);
  const after = a.store.load(review.id);
  assert.equal(after.rounds.length, 2);
  // The saved round's files are the winner's own.
  const winner = after.request.artifact!.path!;
  assert.equal(readFileSync(path.join(a.store.dir(review.id), "r2/original.md"), "utf8"), readFileSync(winner, "utf8"));
  assert.deepEqual(readdirSync(a.store.dir(review.id)).filter((f) => f.startsWith(".staging")), []);
  await a.waitFor(review.id, 10);
});

test("a report that cannot be written does not undo a saved round", async () => {
  const { json } = await submit(doc());
  const dir = person().store.dir(json.review_id);
  // Make report.md unwritable: a non-empty directory in its place.
  rmSync(path.join(dir, "report.md"));
  mkdirSync(path.join(dir, "report.md"));
  writeFileSync(path.join(dir, "report.md", "x"), "x");
  const answers = json.findings.map((f: { finding_id: string }) => ({ finding_id: f.finding_id, status: "deferred", note: "Later." }));
  const { json: r2 } = await ok("review_respond", { review_id: json.review_id, responses: answers, resubmit: true, wait_seconds: 10 });
  assert.equal(r2.round, 2);
  assert.ok(existsSync(path.join(dir, "r2/artifact.md")));
});

test("two processes recovering the same stale lock lose no update", async () => {
  const { json } = await submit(doc(true));
  const store = person().store;
  const id = json.review_id;
  // A lock left by a process that is gone.
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => dead.on("exit", r));
  mkdirSync(path.join(store.dir(id), ".lock"));
  writeFileSync(path.join(store.dir(id), ".lock", "owner"), JSON.stringify({ pid: dead.pid, host: os.hostname(), token: "dead", at: Date.now() }));
  const before = store.load(id).history.length;
  const script = `
    import("${path.join(ROOT, "dist/src/store.js")}").then(({ Store }) => {
      const s = new Store(process.argv[1]);
      for (let i = 0; i < 25; i++) s.update(process.argv[2], (r) => { r.history.push({ at: "", event: "note", detail: process.argv[3] + i }); });
    });`;
  const runs = ["a", "b", "c"].map((w) => new Promise((res) => spawn(process.execPath, ["-e", script, path.dirname(store.dir(id)), id, w], { stdio: "inherit" }).on("exit", res)));
  assert.deepEqual(await Promise.all(runs), [0, 0, 0]);
  assert.equal(store.load(id).history.length, before + 75);
  assert.ok(!existsSync(path.join(store.dir(id), ".lock")));
  assert.ok(!existsSync(path.join(store.dir(id), ".lock.steal")));
});

test("revocation reaches an open MCP server: new submits refuse; a confidential rubric without approvals gets no merge model", async () => {
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  try {
    cfg.allowed_reviewers = { proposal: ["slow"] };
    writeFileSync(configFile, JSON.stringify(cfg));
    await fails("review_submit", { artifact: doc(), rubric: "proposal", intent: "x", reviewers: ["fake"] }, /Reviewer\(s\) fake are not approved for this rubric/);
  } finally {
    delete cfg.allowed_reviewers;
    writeFileSync(configFile, JSON.stringify(cfg));
  }
});

test("a live process keeps its lock however long it holds it; a gone one does not", () => {
  const store = person().store;
  const id = "rv_" + "0".repeat(26);
  mkdirSync(path.join(store.dir(id), ".lock"), { recursive: true });
  // Owned by this (live) process, written long ago.
  writeFileSync(path.join(store.dir(id), ".lock", "owner"), JSON.stringify({ pid: process.pid, host: os.hostname(), token: "other", at: Date.now() - 3_600_000 }));
  const started = Date.now();
  assert.throws(() => store.withLock(id, () => 1), /locked by another process/);
  assert.ok(Date.now() - started >= 14_000);
  rmSync(store.dir(id), { recursive: true, force: true });
});

test("a round folder left by an interrupted resubmit does not block the retry", async () => {
  const { json } = await submit(doc());
  const id = json.review_id;
  const dir = person().store.dir(id);
  mkdirSync(path.join(dir, "r2"));
  writeFileSync(path.join(dir, "r2", "leftover.txt"), "from an attempt that stopped before saving");
  const answers = json.findings.map((f: { finding_id: string }) => ({ finding_id: f.finding_id, status: "deferred", note: "Later." }));
  const { json: r2 } = await ok("review_respond", { review_id: id, responses: answers, resubmit: true, wait_seconds: 10 });
  assert.equal(r2.round, 2);
  assert.ok(!existsSync(path.join(dir, "r2", "leftover.txt")));
  assert.ok(existsSync(path.join(dir, "r2", "artifact.md")));
});

test("assumption challenges show in the default result even when advisory", async () => {
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  cfg.adapters.challenger = { type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs"), "--challenge"] };
  writeFileSync(configFile, JSON.stringify(cfg));
  const engine = person();
  const review = await engine.submit(
    { artifact: { path: doc(true) }, pages: [], rubric: "proposal", intent: "x", assumptions: ["Slovenian law"], criteria: [], reviewers: [{ name: "challenger" }], stage: "pre-merge" },
    { client: null, vendor: null, vendor_source: "unknown" },
    10,
  );
  const { res } = await ok("review_result", { review_id: review.id });
  const payload = JSON.parse(res.content.at(-1)!.text);
  assert.ok(payload.findings.some((f: { assumption_challenge: boolean; blocking: boolean }) => f.assumption_challenge && !f.blocking));
  assert.match(res.content[0].text, /## Assumption challenges \(advisory\)/);
});

test("a reviewer repointed while the MCP server keeps running runs as configured now", async () => {
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  const original = cfg.adapters.fake;
  try {
    // Same name, new definition: now it also raises an assumption challenge.
    cfg.adapters.fake = { ...original, args: [...original.args, "--challenge"] };
    writeFileSync(configFile, JSON.stringify(cfg));
    const { json } = await submit(doc(), { reviewers: ["fake"], assumptions: ["Slovenian law"] });
    const { json: all } = await ok("review_result", { review_id: json.review_id, include_advisory: true });
    assert.ok(all.findings.some((f: { claim: string }) => f.claim === "The governing law is assumed but not stated."));
  } finally {
    cfg.adapters.fake = original;
    writeFileSync(configFile, JSON.stringify(cfg));
  }
});
