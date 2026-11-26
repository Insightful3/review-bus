// v0.2: pull reviewers, MCP over HTTP with a token, the web inbox, rubric packs, the review id
// before slow page capture, and Codex's native review pass (with a fake codex).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, vendorOfClient } from "../src/config.js";
import { Engine, laterRounds } from "../src/engine.js";
import { renderSummary } from "../src/store.js";
import { startHttp } from "../src/http.js";
import { gitlinksAfter } from "../src/adapters/index.js";
import { checkRubric, checkRubricPath, listRubrics, loadRubric } from "../src/rubrics.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "test/fixtures/proposal-bluefin.md");
const PERSON = { client: "rb", vendor: null, vendor_source: "person" as const };

let tmp: string;
let configFile: string;
let engine: Engine;
let base: string; // http://127.0.0.1:<port>/
let token: string;
let closeHttp: () => Promise<void>;
let client: Client;

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

const RUBRIC = `---
confidential: true
require_signoff: true
---
# Acme contract

## Purpose

Check an Acme contract.

## What to check

- Price.

## Out of scope

- Style.

## Impact anchors

- critical: wrong price.
- high: missing law.
- medium: unclear term.
- low: style.
`;

function writeConfig(extra: Record<string, unknown> = {}) {
  const fake = { type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs")], timeout_seconds: 30 };
  writeFileSync(
    configFile,
    JSON.stringify({
      rubric_paths: [],
      rubric_packs: [path.join(tmp, "packs", "acme-pack")],
      storage: { documents: path.join(tmp, "reviews") },
      default_reviewers: ["fake"],
      allowed_reviewers: { "contract-b2b": ["fake", "person"] },
      http: { port: 0, token_file: path.join(tmp, "http-token") },
      adapters: {
        fake,
        person: { type: "pull" },
        quick: { type: "pull", timeout_seconds: 1 },
        gemini_only: { type: "pull", claim_clients: ["gemini-cli"] },
        native: { type: "codex-review", command: path.join(ROOT, "test/fake-codex.mjs"), timeout_seconds: 30 },
      },
      ...extra,
    }),
  );
  process.env.REVIEW_BUS_CONFIG = configFile;
}

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  const blocks = res.content.map((c) => c.text).filter((t) => t.trim().startsWith("{"));
  return { res, text: res.content[0]?.text ?? "", json: res.isError ? null : JSON.parse(blocks.find((b) => b.includes('"review_id"')) ?? blocks[0] ?? "null") };
}

async function waitUntil(check: () => boolean, ms = 15000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "review-bus-v02-"));
  const pack = path.join(tmp, "packs", "acme-pack");
  mkdirSync(pack, { recursive: true });
  writeFileSync(path.join(pack, "pack.json"), JSON.stringify({ name: "acme", description: "Acme's rubrics", version: "1.0.0" }));
  writeFileSync(path.join(pack, "contract-b2b.md"), RUBRIC);
  configFile = path.join(tmp, "config.json");
  writeConfig();
  engine = new Engine(loadConfig());
  const started = await startHttp(engine, { port: 0, host: "127.0.0.1" });
  base = started.url;
  closeHttp = started.close;
  token = readFileSync(path.join(tmp, "http-token"), "utf8").trim();
  client = new Client({ name: "http-author", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
});

after(async () => {
  await client?.close();
  await closeHttp?.();
  await engine?.idle();
});

test("the token file is created readable only by its owner; /mcp refuses requests without it", async () => {
  assert.equal(statSync(path.join(tmp, "http-token")).mode & 0o777, 0o600);
  const none = await fetch(`${base}mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(none.status, 401);
  const wrong = await fetch(`${base}mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: "{}" });
  assert.equal(wrong.status, 401);
});

test("a request naming another host (DNS rebinding) is refused", async () => {
  const port = new URL(base).port;
  const res = await new Promise<number>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/inbox", headers: { host: `evil.example:${port}` } }, (r) => resolve(r.statusCode ?? 0));
    req.end();
  });
  assert.equal(res, 403);
  const origin = await fetch(`${base}inbox`, { headers: { origin: "https://evil.example" }, redirect: "manual" });
  assert.equal(origin.status, 403);
});

test("rb serve refuses to listen beyond this machine unless allow_remote is set", async () => {
  await assert.rejects(startHttp(engine, { port: 0, host: "0.0.0.0" }), /allow_remote/);
});

test("over HTTP: a pull reviewer claims the work and posts; the last answer finishes the round", async () => {
  const doc = path.join(tmp, "proposal.md");
  writeFileSync(doc, readFileSync(FIXTURE, "utf8"));
  const sub = await call("review_submit", { artifact: doc, rubric: "proposal", intent: "Win the Bluefin project.", reviewers: ["fake", "person"], wait_seconds: 20 });
  assert.equal(sub.res.isError, undefined, sub.text);
  const id = sub.json.review_id;
  // The wait stops once only the pull reviewer is left, instead of running out the clock.
  const status = (await call("review_status", { review_id: id })).json;
  assert.equal(status.state, "in_review");
  assert.deepEqual(
    status.reviewers.map((r: { name: string; status: string }) => [r.name, r.status]),
    [
      ["fake", "done"],
      ["person", "waiting"],
    ],
  );

  const pending = (await call("review_pending", { reviewer: "person" })).json.pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].review_id, id);

  const claimed = (await client.callTool({ name: "review_claim", arguments: { review_id: id, reviewer: "person", by: "Ana" } })) as ToolResult;
  assert.notEqual(claimed.isError, true, claimed.content[0].text);
  const work = JSON.parse(claimed.content[0].text);
  assert.match(claimed.content[1].text, /<document>/);
  assert.equal(JSON.parse(claimed.content[2].text).type, "object");
  assert.ok(work.token && work.files.some((f: string) => f.endsWith("artifact.md")));
  // Nobody else can claim it now, and a wrong token cannot post.
  assert.match((await call("review_claim", { review_id: id, reviewer: "person", by: "Bo" })).text, /already claimed by Ana/);
  // A released claim can be taken again; the old token no longer works.
  assert.match((await call("review_release", { review_id: id, reviewer: "person", by: "Ana" })).text, /claim_id/);
  await call("review_release", { review_id: id, reviewer: "person", by: "Ana", claim_id: work.claim_id });
  const again = (await client.callTool({ name: "review_claim", arguments: { review_id: id, reviewer: "person", by: "Ana" } })) as ToolResult;
  const oldToken = work.token;
  Object.assign(work, JSON.parse(again.content[0].text));
  assert.notEqual(work.token, oldToken);
  assert.match((await call("review_post", { review_id: id, reviewer: "person", token: oldToken, output: { verdict: "approve", summary: "x", findings: [] } })).text, /No claim/);
  const output = {
    verdict: "changes_requested",
    summary: "Person review.",
    findings: [
      {
        claim: "The go-live date is before the pilot ends.",
        failure_scenario: "The client plans the launch on a date the pilot cannot meet.",
        evidence: "Timeline section.",
        location: { path: null, line_start: null, line_end: null, section: "Timeline", quote: null },
        likelihood: "likely",
        impact: "high",
        suggested_fix: null,
        assumption_challenge: false,
        confidence: 0.8,
      },
    ],
  };
  assert.match((await call("review_post", { review_id: id, reviewer: "person", token: "x".repeat(32), output })).text, /No claim .* matches this token/);
  const bad = await call("review_post", { review_id: id, reviewer: "person", token: work.token, output: { verdict: "maybe" } });
  assert.match(bad.text, /does not match the reviewer output schema/);

  const posted = await call("review_post", { review_id: id, reviewer: "person", token: work.token, output, model: "human" });
  assert.notEqual(posted.res.isError, true, posted.text);
  assert.equal(posted.json.state, "changes_requested");
  const result = (await call("review_result", { review_id: id, include_advisory: true })).json;
  assert.ok(result.findings.some((f: { reviewer: string; claim: string }) => f.reviewer.startsWith("person:human") && /go-live/.test(f.claim)));
  // The claim token never shows in results or the report.
  assert.ok(!JSON.stringify(result).includes(work.token));
  assert.ok(!readFileSync(path.join(tmp, "reviews", id, "report.md"), "utf8").includes(work.token));
  assert.match(readFileSync(path.join(tmp, "reviews", id, "report.md"), "utf8"), /Claimed by Ana \(http-author\)/);
});

test("a pull reviewer that misses its deadline fails, and the round finishes without it", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }, { name: "quick" }], stage: "pre-merge" },
    PERSON,
    10,
  );
  await new Promise((r) => setTimeout(r, 1500));
  engine.get(review.id); // notices the missed deadline
  await engine.settled(review.id);
  const done = engine.get(review.id);
  assert.equal(done.state, "changes_requested");
  const quick = done.rounds[0].reviewers.find((r) => r.name === "quick")!;
  assert.equal(quick.status, "failed");
  assert.match(quick.error!, /no answer by the deadline/);
});

test("claim_clients: only the named MCP clients may claim for that reviewer", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "gemini_only" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  assert.throws(() => engine.claim(review.id, "gemini_only", { by: "Someone", client: "claude-code" }), /accepts claims only from gemini-cli/);
  const work = engine.claim(review.id, "gemini_only", { by: "Gemini", client: "gemini-cli" });
  const after = await engine.post(review.id, "gemini_only", work.token, { decline: "Out of my depth." });
  assert.equal(after.state, "failed"); // the only reviewer declined
  assert.match(after.rounds[0].reviewers[0].error!, /declined by Gemini: Out of my depth/);
});

test("a server restart does not fail a round that only waits for a pull reviewer", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  const fresh = new Engine(loadConfig()); // another process with no running job
  assert.equal(fresh.get(review.id).state, "in_review");
  const work = fresh.claim(review.id, "person", { by: "Ana", client: null });
  const done = await fresh.post(review.id, "person", work.token, { output: { verdict: "approve", summary: "Fine.", findings: [] } });
  assert.equal(done.state, "approved");
});

test("web inbox: login, list, a person reviews as a pull reviewer, then signs off", async () => {
  const login = await fetch(`${base}inbox`, { redirect: "manual" });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/inbox/login");
  const wrong = await fetch(`${base}inbox/login`, { method: "POST", body: new URLSearchParams({ token: "nope" }), redirect: "manual" });
  assert.equal(wrong.status, 401);
  const ok = await fetch(`${base}inbox/login`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  assert.match(ok.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  const get = (p: string) => fetch(`${base}${p}`, { headers: { cookie }, redirect: "manual" });
  const post = (p: string, form: URLSearchParams) => fetch(`${base}${p}`, { method: "POST", headers: { cookie }, body: form, redirect: "manual" });

  // A confidential pack rubric that requires sign-off, reviewed by a person only.
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "acme/contract-b2b", intent: "Sign the Acme deal.", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  const inbox = await (await get("inbox")).text();
  assert.match(inbox, new RegExp(review.id));
  assert.match(inbox, /Waiting for a reviewer/);
  const reviewPage = await get(`inbox/review/${review.id}`);
  assert.match(reviewPage.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.match(await reviewPage.text(), /Review this as person/);

  const claimPage = await (await post(`inbox/claim/${review.id}/person/start`, new URLSearchParams({ by: "Ana <script>" }))).text();
  assert.ok(!claimPage.includes("Ana <script>"), "names are escaped");
  const claimToken = claimPage.match(/name="claim_token" value="([0-9a-f]+)"/)![1];
  const answer = new URLSearchParams({ claim_token: claimToken, verdict: "approve", summary: "Looks right.", decline: "" });
  for (const [k, v] of Object.entries({ f_claim: "", f_impact: "medium", f_likelihood: "likely", f_failure: "", f_evidence: "", f_section: "", f_quote: "", f_fix: "", f_challenge: "no" })) answer.append(k, v);
  const sent = await post(`inbox/claim/${review.id}/person/post`, answer);
  assert.equal(sent.status, 303);
  assert.equal(engine.get(review.id).state, "awaiting_signoff");

  // review.json (claim tokens) is never served; screenshots and Markdown of a round are.
  assert.equal((await get(`inbox/review/${review.id}/file/review.json`)).status, 404);
  assert.equal((await get(`inbox/review/${review.id}/file/r1/..%2F..%2Freview.json`)).status, 404);
  assert.equal((await get(`inbox/review/${review.id}/file/r1/artifact.md`)).status, 200);
  symlinkSync(configFile, path.join(tmp, "reviews", review.id, "r1", "leak.md"));
  assert.equal((await get(`inbox/review/${review.id}/file/r1/leak.md`)).status, 404);

  const signed = await post(`inbox/review/${review.id}/signoff`, new URLSearchParams({ by: "Ana", note: "Checked." }));
  assert.equal(signed.status, 303);
  const final = engine.get(review.id);
  assert.equal(final.state, "approved");
  assert.equal(final.signoff?.by, "Ana");
});

test("rubric packs: pack/name loads from the pack; approvals fall back to the base name", async () => {
  const r = loadRubric("acme/contract-b2b", engine.config.rubric_paths, engine.config.rubric_packs);
  assert.match(r.body, /Acme contract/);
  assert.throws(() => loadRubric("nope/contract-b2b", engine.config.rubric_paths, engine.config.rubric_packs), /pack "nope" is not in rubric_packs/);
  assert.throws(() => loadRubric("../x", engine.config.rubric_paths, engine.config.rubric_packs), /Invalid rubric name/);
  const names = listRubrics(engine.config.rubric_paths, engine.config.rubric_packs).map((x) => x.name);
  assert.ok(names.includes("acme/contract-b2b") && names.includes("contract-b2b") && names.includes("proposal"));
  // Not approved by name or base name: refused.
  await assert.rejects(
    engine.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "acme/contract-b2b", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "quick" }], stage: "pre-merge" }, PERSON),
    /not approved/,
  );
});

test("review_rubrics lists plain and pack rubrics with their purpose", async () => {
  const { json } = await call("review_rubrics", {});
  const acme = json.rubrics.find((r: { name: string }) => r.name === "acme/contract-b2b");
  assert.deepEqual([acme.pack, acme.confidential, acme.require_signoff, acme.purpose], ["acme", true, true, "Check an Acme contract."]);
  assert.equal(acme.file, undefined);
});

test("rb rubric-check finds what would make a rubric work badly", () => {
  const dir = path.join(tmp, "packs", "bad-pack");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "good.md"), RUBRIC);
  writeFileSync(path.join(dir, "bad.md"), "---\neffort: huge\nconfidential: yes\nconfidental: true\n---\n# Bad\n\n## Purpose\n\nX — y.\n\n## Impact anchors\n\n- critical: x\n");
  const results = checkRubricPath(dir);
  assert.deepEqual(results.find((x) => x.file.endsWith("good.md"))!.problems, []);
  const problems = results.find((x) => x.file.endsWith("bad.md"))!.problems.join("\n");
  for (const p of [/missing section "## What to check"/, /lack "high:"/, /em dash/, /effort "huge"/, /confidential must be true or false/, /unknown front matter key "confidental"/]) assert.match(problems, p);
  const cli = spawnSync(process.execPath, [path.join(ROOT, "dist/src/cli.js"), "rubric-check", dir], { encoding: "utf8" });
  assert.equal(cli.status, 2);
  assert.match(cli.stdout, /FAIL .*bad\.md/);
  // Every rubric this repo ships passes.
  assert.ok(checkRubricPath(path.join(ROOT, "rubrics")).every((x) => x.problems.length === 0), JSON.stringify(checkRubricPath(path.join(ROOT, "rubrics")).filter((x) => x.problems.length)));
});

test("pages: a capture slower than snapshot_wait_seconds returns the id; its failure shows on the review", async () => {
  writeConfig({ snapshot_wait_seconds: 0 });
  const slow = new Engine(loadConfig());
  // Nothing listens on port 9 (discard): the capture fails, after submit has returned.
  const review = await slow.submit({ artifact: null, pages: ["http://127.0.0.1:9/"], rubric: "webpage", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" }, PERSON);
  assert.equal(review.state, "submitted");
  assert.equal(review.rounds.length, 0);
  await slow.settled(review.id);
  const failed = slow.get(review.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.notes.join(" "), /The snapshot failed/);
  // With the default wait, the same quick failure is an error on submit, and nothing is kept.
  writeConfig();
  const quick = new Engine(loadConfig());
  const before = existsSync(path.join(tmp, "reviews")) ? execFileSync("ls", [path.join(tmp, "reviews")]).toString() : "";
  await assert.rejects(
    quick.submit({ artifact: null, pages: ["http://127.0.0.1:9/"], rubric: "webpage", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" }, PERSON),
    /127\.0\.0\.1:9/,
  );
  assert.equal(execFileSync("ls", [path.join(tmp, "reviews")]).toString(), before);
});

test("a review still taking its snapshot is failed by another process only when its process is gone", async () => {
  writeConfig({ snapshot_wait_seconds: 0 });
  const a = new Engine(loadConfig());
  const review = await a.submit({ artifact: null, pages: ["http://127.0.0.1:9/"], rubric: "webpage", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" }, PERSON);
  // Pretend the process taking the snapshot died.
  const file = path.join(tmp, "reviews", review.id, "review.json");
  await a.settled(review.id);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(saved, { state: "submitted", preparing: { pid: 999999, host: os.hostname(), started_at: new Date().toISOString() } });
  writeFileSync(file, JSON.stringify(saved));
  const b = new Engine(loadConfig());
  const got = b.get(review.id);
  assert.equal(got.state, "failed");
  assert.match(got.history.at(-1)!.detail!, /snapshot was being taken when the server stopped/);
  writeConfig();
});

test("codex-review: Codex's native review runs in a scratch repo built from the snapshot; a second pass makes findings", async () => {
  const repo = path.join(tmp, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  writeFileSync(path.join(repo, "index.html"), "<h1>Hi</h1>\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  writeFileSync(path.join(repo, "index.html"), "<h1>Hello</h1>\n");
  writeFileSync(path.join(repo, "new.txt"), "new file\n");
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();
  const review = await engine.submit(
    { artifact: { git: { repo, mode: "uncommitted" } }, pages: [], rubric: "code", intent: "Greet.", assumptions: [], criteria: [], reviewers: [{ name: "native" }], stage: "pre-merge" },
    PERSON,
    30,
  );
  await engine.settled(review.id);
  const done = engine.get(review.id);
  const run = done.rounds[0].reviewers[0];
  assert.equal(run.status, "done", run.error ?? "");
  assert.ok(done.rounds[0].findings.length >= 1);
  const native = readFileSync(path.join(tmp, "reviews", review.id, "r1", "native.native.md"), "utf8");
  assert.match(native, /\(2 changed\)/); // both the edit and the new file are uncommitted in the scratch repo
  // The author's repo is untouched.
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString(), before);
  // A document cannot go to codex-review.
  const doc = await engine.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "native" }], stage: "pre-merge" }, PERSON, 10);
  await engine.settled(doc.id);
  assert.match(engine.get(doc.id).rounds[0].reviewers[0].error!, /git changes only/);
});

test("importing server.js (as rb serve does) starts no stdio server; running it does", async () => {
  const run = (args: string[]) =>
    new Promise<number>((resolve) => {
      const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, REVIEW_BUS_CONFIG: configFile }, stdio: ["pipe", "ignore", "ignore"] });
      const t = setTimeout(() => {
        p.kill();
        resolve(-1); // still running: something reads stdin
      }, 3000);
      p.on("exit", (code) => {
        clearTimeout(t);
        resolve(code ?? 0);
      });
    });
  assert.equal(await run(["--input-type=module", "-e", `await import(${JSON.stringify(path.join(ROOT, "dist/src/server.js"))});`]), 0);
  assert.equal(await run([path.join(ROOT, "dist/src/server.js")]), -1);
});

test("the claim page shows a person the brief, the rubric and the work, with labelled fields", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "Win the Bluefin project.", assumptions: ["The client hosts it."], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  const ok = await fetch(`${base}inbox/login`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  const html = await (await fetch(`${base}inbox/claim/${review.id}/person/start`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ by: "Ana" }) })).text();
  assert.match(html, /What the author wants<\/h2><p>Win the Bluefin project\./);
  assert.match(html, /The client hosts it\./);
  assert.match(html, /Rubric: proposal/);
  assert.match(html, /<h2>The work<\/h2>/);
  assert.match(html, /Total price: EUR 24,000/);
  for (const f of ["f_claim", "f_failure", "f_evidence", "f_impact", "f_likelihood"]) assert.match(html, new RegExp(`name="${f}" aria-label="`));
  engine.release(review.id, "person", "test", engine.get(review.id).rounds[0].reviewers[0].claim!.id);
});

// ---- Fixes from Codex's review of v0.2 ----

test("a request target the URL parser rejects gets a 400 and the server keeps serving", async () => {
  const { port } = new URL(base);
  const reply = await new Promise<string>((resolve) => {
    const sock = net.connect(Number(port), "127.0.0.1", () => sock.write(`GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("close", () => resolve(data));
  });
  assert.match(reply, /^HTTP\/1\.1 (400|404)/);
  assert.equal((await fetch(`${base}inbox/login`)).status, 200);
});

test("the inbox cookie is a session id scoped by port, never the MCP token", async () => {
  const ok = await fetch(`${base}inbox/login`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
  const cookie = ok.headers.get("set-cookie")!;
  assert.ok(!cookie.includes(token));
  assert.match(cookie, new RegExp(`^rb_session_${new URL(base).port}=[0-9a-f]{64};`));
  // The token itself as a cookie does not open the inbox.
  const forged = await fetch(`${base}inbox`, { headers: { cookie: `rb_session_${new URL(base).port}=${token}` }, redirect: "manual" });
  assert.equal(forged.status, 303);
});

test("a pull answer after the deadline is refused even if nobody looked in between", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }, { name: "quick" }], stage: "pre-merge" },
    PERSON,
    10,
  );
  const work = engine.claim(review.id, "quick", { by: "Late", client: null });
  await new Promise((r) => setTimeout(r, 1300));
  await assert.rejects(engine.post(review.id, "quick", work.token, { output: { verdict: "approve", summary: "x", findings: [] } }), /missed its deadline/);
  await engine.settled(review.id);
  assert.equal(engine.get(review.id).rounds[0].reviewers.find((r) => r.name === "quick")!.status, "failed");
});

test("a round whose answers are all in but whose finisher died is finished by the next process", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
    PERSON,
    10,
  );
  const file = path.join(tmp, "reviews", review.id, "review.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  // As if the finishing process died mid-merge, while the round's runner is still alive.
  Object.assign(saved, { state: "in_review" });
  Object.assign(saved.rounds[0], { finished_at: null, findings: [], runner: { pid: process.pid + 0, host: os.hostname(), started_at: new Date().toISOString() }, finalizing: { pid: 999999, host: os.hostname(), started_at: new Date().toISOString() } });
  writeFileSync(file, JSON.stringify(saved));
  const other = new Engine(loadConfig());
  other.get(review.id);
  await other.settled(review.id);
  const done = other.get(review.id);
  assert.equal(done.state, "changes_requested");
  assert.ok(done.rounds[0].findings.length > 0);
});

test("unclosed front matter is a rubric error, not a silently ignored confidential flag", () => {
  const dir = path.join(tmp, "packs", "unclosed");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "contract.md"), RUBRIC.replace("require_signoff: true\n---\n", "require_signoff: true\n"));
  assert.deepEqual(checkRubricPath(path.join(dir, "contract.md"))[0].problems, ["the front matter has no closing --- line"]);
  assert.throws(() => loadRubric("contract", [dir]), /no closing --- line/);
});

test("responding to a review that failed before its first round says to submit again", async () => {
  writeConfig({ snapshot_wait_seconds: 0 });
  const e = new Engine(loadConfig());
  const review = await e.submit({ artifact: null, pages: ["http://127.0.0.1:9/"], rubric: "webpage", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" }, PERSON);
  await e.settled(review.id);
  await assert.rejects(e.respond(review.id, [], { resubmit: true }), /failed before its first round .* Submit the work again/);
  writeConfig();
});

test("claim tokens are redacted from REVIEW_BUS_LOG", async () => {
  const log = path.join(tmp, "requests.log");
  process.env.REVIEW_BUS_LOG = log;
  try {
    const review = await engine.submit(
      { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
      PERSON,
      5,
    );
    const work = engine.claim(review.id, "person", { by: "Ana", client: null });
    await call("review_post", { review_id: review.id, reviewer: "person", token: work.token, output: { verdict: "maybe" } });
    const text = readFileSync(log, "utf8");
    assert.match(text, /review_post/);
    assert.ok(!text.includes(work.token));
    assert.match(text, /\[redacted\]/);
  } finally {
    delete process.env.REVIEW_BUS_LOG;
  }
});

test("codex-review: inherited GIT_* variables, ignored tracked files and relative symlinks", async () => {
  const repo = path.join(tmp, "repo2");
  const other = path.join(tmp, "other-repo");
  mkdirSync(repo);
  mkdirSync(other);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd });
  git(other, "init", "-q");
  writeFileSync(path.join(other, "x.txt"), "x\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "x");
  const otherIndex = readFileSync(path.join(other, ".git", "index"));
  const otherConfig = readFileSync(path.join(other, ".git", "config"));

  writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
  writeFileSync(path.join(repo, "index.html"), "<h1>Hi</h1>\n");
  writeFileSync(path.join(repo, "app.log"), "tracked on purpose\n");
  writeFileSync(path.join(repo, "other.html"), "<p>other</p>\n");
  symlinkSync("index.html", path.join(repo, "link.html"));
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "add", "-f", "app.log");
  git(repo, "commit", "-q", "-m", "base");
  writeFileSync(path.join(repo, "app.log"), "tracked on purpose, changed\n");
  execFileSync("rm", [path.join(repo, "link.html")]);
  symlinkSync("other.html", path.join(repo, "link.html"));
  git(repo, "commit", "-qam", "change");

  process.env.GIT_DIR = path.join(other, ".git");
  process.env.GIT_INDEX_FILE = path.join(other, ".git", "index");
  process.env.GIT_WORK_TREE = other;
  try {
    const review = await engine.submit(
      { artifact: { git: { repo, mode: "commit" } }, pages: [], rubric: "code", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "native" }], stage: "pre-merge" },
      PERSON,
      30,
    );
    await engine.settled(review.id);
    const run = engine.get(review.id).rounds[0].reviewers[0];
    assert.equal(run.status, "done", run.error ?? "");
    // Both changed files (the ignored-but-tracked log and the symlink) are in the scratch repo's change.
    assert.match(readFileSync(path.join(tmp, "reviews", review.id, "r1", "native.native.md"), "utf8"), /\(2 changed\)/);
  } finally {
    delete process.env.GIT_DIR;
    delete process.env.GIT_INDEX_FILE;
    delete process.env.GIT_WORK_TREE;
  }
  assert.ok(readFileSync(path.join(other, ".git", "index")).equals(otherIndex), "the other repo's index is untouched");
  assert.ok(readFileSync(path.join(other, ".git", "config")).equals(otherConfig), "the other repo's config is untouched");
});

// ---- Fixes from Codex's second review round ----

test("the inbox serves only recorded snapshot files, never a symlink to review.json", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
    PERSON,
    10,
  );
  const ok = await fetch(`${base}inbox/login`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  const get = (p: string) => fetch(`${base}inbox/review/${review.id}/file/${p}`, { headers: { cookie } });
  symlinkSync(path.join(tmp, "reviews", review.id, "review.json"), path.join(tmp, "reviews", review.id, "r1", "meta.md"));
  assert.equal((await get("r1/meta.md")).status, 404);
  assert.equal((await get("r1/prompt.md")).status, 404); // exists, but not a recorded snapshot file
  assert.equal((await get("r1/artifact.md")).status, 200);
});

test("an inbox post from another port of the same host is refused", async () => {
  const { port } = new URL(base);
  const res = await fetch(`${base}inbox/login`, { method: "POST", headers: { origin: `http://127.0.0.1:${Number(port) + 1}` }, body: new URLSearchParams({ token }), redirect: "manual" });
  assert.equal(res.status, 403);
  const same = await fetch(`${base}inbox/login`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}` }, body: new URLSearchParams({ token }), redirect: "manual" });
  assert.equal(same.status, 303);
});

test("a settled round with a dead runner and no finisher is finished, not failed", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
    PERSON,
    10,
  );
  const file = path.join(tmp, "reviews", review.id, "review.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(saved, { state: "in_review" });
  Object.assign(saved.rounds[0], { finished_at: null, findings: [], finalizing: null, runner: { pid: 999999, host: os.hostname(), started_at: new Date().toISOString() } });
  writeFileSync(file, JSON.stringify(saved));
  const other = new Engine(loadConfig());
  other.get(review.id);
  await other.settled(review.id);
  assert.equal(other.get(review.id).state, "changes_requested");
});

test("a long page capture is not failed by another process while its process lives", async () => {
  writeConfig({ snapshot_wait_seconds: 0 });
  const a = new Engine(loadConfig());
  const review = await a.submit({ artifact: null, pages: ["http://127.0.0.1:9/"], rubric: "webpage", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" }, PERSON);
  await a.settled(review.id);
  const sleeper = spawn("sleep", ["30"]);
  try {
    const file = path.join(tmp, "reviews", review.id, "review.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const longAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    Object.assign(saved, { state: "submitted", preparing: { pid: sleeper.pid, host: os.hostname(), started_at: longAgo } });
    writeFileSync(file, JSON.stringify(saved));
    assert.equal(new Engine(loadConfig()).get(review.id).state, "submitted");
  } finally {
    sleeper.kill();
    writeConfig();
  }
});

test("an indented front matter line is an error, not a dropped flag", () => {
  const dir = path.join(tmp, "packs", "indented");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "contract.md"), RUBRIC.replace("confidential: true", "  confidential: true"));
  assert.match(checkRubricPath(path.join(dir, "contract.md"))[0].problems.join(), /line 2 is not a flat "key: value" line/);
  assert.throws(() => loadRubric("contract", [dir]), /not a flat "key: value" line/);
});

test("a release from an old page does not drop a newer claim; pull-only status says to check back later", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  const st = (await call("review_status", { review_id: review.id })).json;
  assert.deepEqual(st.waiting_for_pull, ["person"]);
  assert.match(st.next, /check back later/);
  engine.claim(review.id, "person", { by: "Ana", client: null });
  const oldAt = engine.get(review.id).rounds[0].reviewers[0].claim!.id;
  engine.release(review.id, "person", "Ana", oldAt);
  await new Promise((r) => setTimeout(r, 5));
  engine.claim(review.id, "person", { by: "Bo", client: null });
  assert.throws(() => engine.release(review.id, "person", "Ana", oldAt), /claimed again since \(by Bo\)/);
  assert.equal(engine.get(review.id).rounds[0].reviewers[0].claim!.by, "Bo");
});

// ---- Fixes from Codex's third review round ----

test("behind a TLS proxy, posts from the configured public origin are accepted", async () => {
  writeConfig({ http: { port: 0, token_file: path.join(tmp, "http-token"), public_origin: "https://reviews.example.com" } });
  const e = new Engine(loadConfig());
  const s = await startHttp(e, { port: 0, host: "127.0.0.1" });
  try {
    const { port } = new URL(s.url);
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/inbox/login", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers } }, (r) => resolve(r.statusCode ?? 0));
        req.end(new URLSearchParams({ token }).toString());
      });
    assert.equal(await status({ host: "reviews.example.com", origin: "https://reviews.example.com" }), 303);
    assert.equal(await status({ host: "reviews.example.com", origin: "https://evil.example.com" }), 403);
  } finally {
    await s.close();
    writeConfig();
  }
});

test("review.json is readable by its owner only and holds no claim token; the policy is frozen per round", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  const work = engine.claim(review.id, "person", { by: "Ana", client: null });
  const file = path.join(tmp, "reviews", review.id, "review.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(work.token));
  assert.match(text, /"token_sha256"/);
  assert.deepEqual(JSON.parse(text).rounds[0].policy, { max_blocking: 5, max_rounds: 3, later_rounds: "stricter" });
  const done = await engine.post(review.id, "person", work.token, { output: { verdict: "approve", summary: "ok", findings: [] } });
  assert.equal(done.state, "approved");
});

test("a rubric with a byte order mark keeps its front matter", () => {
  const dir = path.join(tmp, "packs", "bom");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "contract.md"), "﻿" + RUBRIC);
  assert.deepEqual(checkRubricPath(path.join(dir, "contract.md"))[0].problems, []);
  assert.equal(loadRubric("contract", [dir]).meta.confidential, true);
});

test("a claim after the deadline is refused", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }, { name: "quick" }], stage: "pre-merge" },
    PERSON,
    10,
  );
  await new Promise((r) => setTimeout(r, 1300));
  assert.throws(() => engine.claim(review.id, "quick", { by: "Late", client: null }), /deadline|failed|nothing to claim/);
  await engine.settled(review.id);
});

test("the inbox serves a git review's full patch as plain text", async () => {
  const repo = path.join(tmp, "repo3");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  writeFileSync(path.join(repo, "a.html"), "<p>a</p>\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "a");
  writeFileSync(path.join(repo, "a.html"), "<script>alert(1)</script>\n");
  const review = await engine.submit(
    { artifact: { git: { repo, mode: "uncommitted" } }, pages: [], rubric: "code", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
    PERSON,
    10,
  );
  const ok = await fetch(`${base}inbox/login`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  const patch = await fetch(`${base}inbox/review/${review.id}/file/r1/change.patch`, { headers: { cookie } });
  assert.equal(patch.status, 200);
  assert.match(patch.headers.get("content-type")!, /^text\/plain/);
  assert.match(await patch.text(), /alert\(1\)/);
});

// ---- The open advisories from round 3 ----

test("codex-review keeps submodule pointer changes in its scratch repo", async () => {
  const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "protocol.file.allow=always", ...args], { cwd });
  const lib = path.join(tmp, "sub-lib");
  const app = path.join(tmp, "sub-app");
  mkdirSync(lib);
  mkdirSync(app);
  writeFileSync(path.join(lib, "a"), "1\n");
  g(lib, "init", "-q");
  g(lib, "add", ".");
  g(lib, "commit", "-q", "-m", "one");
  writeFileSync(path.join(app, "x"), "x\n");
  g(app, "init", "-q");
  g(app, "add", ".");
  g(app, "submodule", "add", "-q", lib, "lib");
  g(app, "commit", "-q", "-m", "base");
  writeFileSync(path.join(app, "lib", "a"), "2\n");
  g(path.join(app, "lib"), "commit", "-qam", "two");
  writeFileSync(path.join(app, "x"), "y\n");
  g(app, "add", "lib", "x");
  g(app, "commit", "-q", "-m", "bump");
  const review = await engine.submit(
    { artifact: { git: { repo: app, mode: "commit" } }, pages: [], rubric: "code", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "native" }], stage: "pre-merge" },
    PERSON,
    30,
  );
  await engine.settled(review.id);
  const run = engine.get(review.id).rounds[0].reviewers[0];
  assert.equal(run.status, "done", run.error ?? "");
  const scratch = path.join(tmp, "reviews", review.id, "r1", "native.native");
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: scratch, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString().trim().split("\n").sort();
  assert.deepEqual(staged, ["lib", "x"]);
});

test("an inbox claim whose page cannot be built is given back", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  // The saved Markdown can no longer be read (a folder where the file was).
  const md = path.join(tmp, "reviews", review.id, "r1", "artifact.md");
  execFileSync("rm", [md]);
  mkdirSync(md);
  const ok = await fetch(`${base}inbox/login`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  const res = await fetch(`${base}inbox/claim/${review.id}/person/start`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ by: "Ana" }) });
  assert.equal(res.status, 400);
  const run = engine.get(review.id).rounds[0].reviewers[0];
  assert.equal(run.status, "waiting");
  assert.match(engine.get(review.id).history.at(-1)!.detail!, /released by web inbox \(the page could not be shown\)/);
});

test("the review id is not held back past the call's budget, whatever snapshot_wait_seconds says", async () => {
  writeConfig({ snapshot_wait_seconds: 120 });
  const e = new Engine(loadConfig());
  const started = Date.now();
  const review = await e.submit(
    { artifact: null, pages: ["http://127.0.0.1:9/"], rubric: "webpage", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" },
    PERSON,
    0,
    { snapshotWaitSeconds: 0 },
  );
  assert.equal(review.state, "submitted");
  assert.ok(Date.now() - started < 3000);
  await e.settled(review.id);
  writeConfig();
});

test("results of a pull-only round tell the agent to check back later", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }, { name: "person" }], stage: "pre-merge" },
    PERSON,
    10,
  );
  const res = await call("review_result", { review_id: review.id });
  assert.deepEqual(res.json.waiting_for_pull, ["person"]);
  assert.match(res.json.next, /check back later/);
});

test("findings over the blocking limit are marked and shown; a rubric can set its own limit", async () => {
  writeConfig({ policy: { max_blocking: 1, max_rounds: 3 } });
  const e = new Engine(loadConfig());
  const tight = await e.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
    PERSON,
    10,
  );
  await e.settled(tight.id);
  const r1 = e.get(tight.id).rounds[0];
  assert.equal(r1.findings.filter((f) => f.blocking).length, 1);
  const over = r1.findings.filter((f) => f.over_limit);
  assert.ok(over.length >= 1);
  assert.ok(over.every((f) => !f.blocking));
  const report = readFileSync(path.join(tmp, "reviews", tight.id, "report.md"), "utf8");
  assert.match(report, new RegExp(`\\(${over.length} of them would block but are over the limit of 1 blocking per round\\)`));
  assert.match(report, /## Over the limit \(would block\)/);
  // A rubric with max_blocking: 5 overrides the config's 1 for its reviews.
  const dir = path.join(tmp, "rubrics-limit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "roomy.md"), "---\nmax_blocking: 5\n---\n# Roomy\n\n## Purpose\n\nx\n\n## What to check\n\n- x\n\n## Out of scope\n\n- x\n\n## Impact anchors\n\n- critical: x\n- high: x\n- medium: x\n- low: x\n");
  writeConfig({ policy: { max_blocking: 1, max_rounds: 3 }, rubric_paths: [dir] });
  const e2 = new Engine(loadConfig());
  const roomy = await e2.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "roomy", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
    PERSON,
    10,
  );
  await e2.settled(roomy.id);
  const r2 = e2.get(roomy.id).rounds[0];
  assert.equal(r2.policy!.max_blocking, 5);
  assert.equal(r2.findings.filter((f) => f.blocking).length, over.length + 1);
  assert.ok(!r2.findings.some((f) => f.over_limit));
  assert.match(checkRubric("---\nmax_blocking: 0\n---\n").join(), /max_blocking must be a whole number above 0/);
  writeConfig();
});

// ---- Fixes from the fresh Codex review of all v0.2 (rv_01m8a3f2xe92ssqevzcyxnnwtq) ----

test("a rubric with a wrongly typed confidential flag is refused at submit, not just by rubric-check", async () => {
  const dir = path.join(tmp, "rubrics-typed");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "loose.md"), RUBRIC.replace("confidential: true", 'confidential: "true"'));
  writeConfig({ rubric_paths: [dir] });
  const e = new Engine(loadConfig());
  await assert.rejects(
    e.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "loose", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" }, PERSON),
    /cannot be used: confidential must be true or false/,
  );
  writeConfig();
});

test("review folders and reports are readable by their owner only", async () => {
  const old = process.umask(0o022);
  try {
    const review = await engine.submit(
      { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
      PERSON,
      10,
    );
    await engine.settled(review.id);
    const dir = path.join(tmp, "reviews", review.id);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(dir, "report.md")).mode & 0o777, 0o600);
  } finally {
    process.umask(old);
  }
});

test("behind an HTTPS public origin the inbox cookie is Secure", async () => {
  writeConfig({ http: { port: 0, token_file: path.join(tmp, "http-token"), public_origin: "https://reviews.example.com" } });
  const e = new Engine(loadConfig());
  const s = await startHttp(e, { port: 0, host: "127.0.0.1" });
  try {
    const { port } = new URL(s.url);
    const cookie = (host: string, origin: string) =>
      new Promise<string>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/inbox/login", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host, origin } }, (r) =>
          resolve(String(r.headers["set-cookie"] ?? "")),
        );
        req.end(new URLSearchParams({ token }).toString());
      });
    assert.match(await cookie("reviews.example.com", "https://reviews.example.com"), /; Secure/);
    assert.doesNotMatch(await cookie(`127.0.0.1:${port}`, `http://127.0.0.1:${port}`), /Secure/);
  } finally {
    await s.close();
    writeConfig();
  }
});

test("idle MCP sessions that were never closed are dropped", async () => {
  process.env.REVIEW_BUS_SESSION_IDLE_MS = "200";
  const s = await startHttp(engine, { port: 0, host: "127.0.0.1" });
  delete process.env.REVIEW_BUS_SESSION_IDLE_MS;
  try {
    const c = new Client({ name: "gone", version: "0" });
    const t = new StreamableHTTPClientTransport(new URL(`${s.url}mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    await c.connect(t);
    const sid = t.sessionId!;
    await c.callTool({ name: "review_rubrics", arguments: {} });
    // The client vanishes without ending its session.
    await c.close();
    await new Promise((r) => setTimeout(r, 700));
    const res = await fetch(`${s.url}mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

test("gitlinks come only from git's own headers, not from file text", () => {
  const patch = Buffer.from(
    [
      "diff --git a/NOTES.md b/NOTES.md",
      "index 1111111..2222222 100644",
      "--- a/NOTES.md",
      "+++ b/NOTES.md",
      "@@ -1 +1,2 @@",
      " notes",
      "+Subproject commit 0123456789abcdef0123456789abcdef01234567",
      "diff --git a/lib b/lib",
      "index d52916b..f9bfcf5 160000",
      "--- a/lib",
      "+++ b/lib",
      "@@ -1 +1 @@",
      "-Subproject commit d52916b085bd965b2c7139cac82acd28dd769230",
      "+Subproject commit f9bfcf5ab551b54f2d3a1d49e6e549a257d663e1",
      "",
    ].join("\n"),
  );
  assert.deepEqual(gitlinksAfter(patch), [{ path: "lib", sha: "f9bfcf5ab551b54f2d3a1d49e6e549a257d663e1" }]);
});

test("each claim has its own id: a stale release never drops a newer claim, even in the same millisecond", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  const first = engine.claim(review.id, "person", { by: "Ana", client: null });
  engine.release(review.id, "person", "Ana", first.claim_id);
  const second = engine.claim(review.id, "person", { by: "Bo", client: null }); // may share Ana's millisecond
  assert.notEqual(second.claim_id, first.claim_id);
  assert.throws(() => engine.release(review.id, "person", "Ana", first.claim_id), /claimed again since \(by Bo\)/);
  assert.equal(engine.pending().find((w) => w.review_id === review.id)!.claim_id, second.claim_id);
});

test("the inbox lists every review awaiting a decision, however many newer reviews exist", async () => {
  const dir = path.join(tmp, "reviews");
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "Old decision", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  // Make it the oldest review and waiting for sign-off.
  const file = path.join(dir, review.id, "review.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const oldId = "rv_00000000000000000000000000";
  saved.id = oldId;
  saved.state = "awaiting_signoff";
  mkdirSync(path.join(dir, oldId), { recursive: true });
  writeFileSync(path.join(dir, oldId, "review.json"), JSON.stringify(saved));
  const ok = await fetch(`${base}inbox/login`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  const page = await (await fetch(`${base}inbox`, { headers: { cookie } })).text();
  const decisions = page.split("Waiting for your decision")[1].split("<h2>")[0];
  assert.match(decisions, new RegExp(oldId));
});

test("a git snapshot runs off the main thread: the event loop keeps ticking", async () => {
  const repo = path.join(tmp, "repo-big");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  for (let i = 0; i < 300; i++) writeFileSync(path.join(repo, `f${i}.txt`), `${i}\n`.repeat(200));
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  for (let i = 0; i < 300; i++) writeFileSync(path.join(repo, `f${i}.txt`), `${i} changed\n`.repeat(200));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const started = Date.now();
  const review = await engine.submit(
    { artifact: { git: { repo, mode: "uncommitted" } }, pages: [], rubric: "code", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
    PERSON,
  );
  const elapsed = Date.now() - started;
  clearInterval(timer);
  await engine.settled(review.id);
  // With the snapshot on the main thread, no timer could fire while git ran.
  assert.ok(ticks >= Math.floor(elapsed / 5 / 4), `ticks ${ticks} in ${elapsed} ms`);
});

// ---- Round 2 of the fresh review ----

test("Secure cookie by the HTTPS Origin, even when the proxy rewrites Host to the backend", async () => {
  writeConfig({ http: { port: 0, token_file: path.join(tmp, "http-token"), public_origin: "https://reviews.example.com" } });
  const e = new Engine(loadConfig());
  const s = await startHttp(e, { port: 0, host: "127.0.0.1" });
  try {
    const { port } = new URL(s.url);
    const cookie = await new Promise<string>((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/inbox/login", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: `127.0.0.1:${port}`, origin: "https://reviews.example.com" } },
        (r) => resolve(String(r.headers["set-cookie"] ?? "")),
      );
      req.end(new URLSearchParams({ token }).toString());
    });
    assert.match(cookie, /; Secure/);
  } finally {
    await s.close();
    writeConfig();
  }
});

test("a pull review queued under a public rubric cannot be claimed once the rubric is confidential", async () => {
  const dir = path.join(tmp, "rubrics-flip");
  mkdirSync(dir, { recursive: true });
  const open = RUBRIC.replace("confidential: true\n", "");
  writeFileSync(path.join(dir, "flip.md"), open);
  writeConfig({ rubric_paths: [dir] });
  const e = new Engine(loadConfig());
  const review = await e.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "flip", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" }, PERSON, 5);
  writeFileSync(path.join(dir, "flip.md"), RUBRIC);
  assert.throws(() => e.claim(review.id, "person", { by: "Ana", client: null }), /confidential/);
  writeConfig();
});

test("codex-review never starts Codex when preparation leaves too little of its time", async () => {
  writeConfig({ adapters: { native: { type: "codex-review", command: path.join(ROOT, "test/fake-codex.mjs"), timeout_seconds: 3 } } });
  const e = new Engine(loadConfig());
  const repo = path.join(tmp, "repo-quick");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "a");
  writeFileSync(path.join(repo, "a.txt"), "b\n");
  const review = await e.submit({ artifact: { git: { repo, mode: "uncommitted" } }, pages: [], rubric: "code", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "native" }], stage: "pre-merge" }, PERSON, 10);
  await e.settled(review.id);
  const run = e.get(review.id).rounds[0].reviewers[0];
  assert.equal(run.status, "failed");
  assert.match(run.error!, /Codex was not started/);
  assert.ok(!existsSync(path.join(tmp, "reviews", review.id, "r1", "native.log.txt")));
  writeConfig();
});

test("review_file gives a claimed reviewer the snapshot files, and nothing else", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  const res = (await client.callTool({ name: "review_claim", arguments: { review_id: review.id, reviewer: "person", by: "Remote" } })) as ToolResult;
  const work = JSON.parse(res.content[0].text);
  assert.deepEqual(work.snapshot_files, ["r1/artifact.md"]);
  const file = (await client.callTool({ name: "review_file", arguments: { review_id: review.id, reviewer: "person", token: work.token, path: "r1/artifact.md" } })) as ToolResult;
  assert.match(file.content[0].text, /Total price/);
  const wrong = (await client.callTool({ name: "review_file", arguments: { review_id: review.id, reviewer: "person", token: "x".repeat(32), path: "r1/artifact.md" } })) as ToolResult;
  assert.equal(wrong.isError, true);
  const other = (await client.callTool({ name: "review_file", arguments: { review_id: review.id, reviewer: "person", token: work.token, path: "review.json" } })) as ToolResult;
  assert.match(other.content[0].text, /not a file of this round's snapshot/);
  engine.release(review.id, "person", "test", work.claim_id);
});

test("gitlinks under quoted (non-ASCII) paths are decoded", () => {
  const patch = Buffer.from(
    ['diff --git "a/caf\\303\\251" "b/caf\\303\\251"', "index d52916b..f9bfcf5 160000", '--- "a/caf\\303\\251"', '+++ "b/caf\\303\\251"', "@@ -1 +1 @@", "-Subproject commit d52916b085bd965b2c7139cac82acd28dd769230", "+Subproject commit f9bfcf5ab551b54f2d3a1d49e6e549a257d663e1", ""].join("\n"),
    "latin1",
  );
  assert.deepEqual(gitlinksAfter(patch), [{ path: "café", sha: "f9bfcf5ab551b54f2d3a1d49e6e549a257d663e1" }]);
});

test("an answer sent after the inbox session expired is kept and sent once the token is given", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  const work = engine.claim(review.id, "person", { by: "Ana", client: null });
  const answer = new URLSearchParams({ claim_token: work.token, verdict: "approve", summary: "Fine after a night's sleep.", decline: "", f_claim: "" });
  const url = `${base}inbox/claim/${review.id}/person/post`;
  const expired = await fetch(url, { method: "POST", headers: { cookie: `rb_session_${new URL(base).port}=expired` }, body: answer, redirect: "manual" });
  assert.equal(expired.status, 401);
  const page = await expired.text();
  const payload = page.match(/name="_payload" value="([^"]*)"/)![1].replaceAll("&amp;", "&");
  assert.equal(engine.get(review.id).state, "in_review"); // nothing lost, nothing sent yet
  const resend = await fetch(url, { method: "POST", body: new URLSearchParams({ _payload: payload, _reauth_token: token }), redirect: "manual" });
  assert.equal(resend.status, 303);
  assert.match(resend.headers.get("set-cookie")!, /^rb_session_/);
  assert.equal(engine.get(review.id).state, "approved");
});

test("with every MCP session slot busy, a new session is refused with a retry", async () => {
  process.env.REVIEW_BUS_MAX_SESSIONS = "1";
  const s = await startHttp(engine, { port: 0, host: "127.0.0.1" });
  delete process.env.REVIEW_BUS_MAX_SESSIONS;
  const opts = { requestInit: { headers: { authorization: `Bearer ${token}` } } };
  const a = new Client({ name: "a", version: "0" });
  try {
    await a.connect(new StreamableHTTPClientTransport(new URL(`${s.url}mcp`), opts));
    // a keeps its SSE stream open, so its slot is busy.
    await new Promise((r) => setTimeout(r, 200));
    const res = await fetch(`${s.url}mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "b", version: "0" } } }),
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "30");
  } finally {
    await a.close();
    await s.close();
  }
});

test("a slow pdftotext does not block the server", async () => {
  const bin = path.join(tmp, "slow-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "pdftotext"), "#!/bin/sh\nsleep 1\necho 'Slow PDF text'\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const review = await engine.submit(
      { artifact: { path: path.join(ROOT, "test/fixtures/proposal-bluefin.pdf") }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
      PERSON,
    );
    clearInterval(timer);
    assert.ok(ticks >= 50, `only ${ticks} timer ticks during a 1 s conversion`);
    assert.equal(review.rounds[0].snapshot.converter, "pdftotext");
    await engine.settled(review.id);
  } finally {
    clearInterval(timer);
    process.env.PATH = oldPath;
  }
});

// ---- Round 3 of the fresh review ----

const finding = (claim: string) => ({
  claim,
  failure_scenario: "The client relies on it and loses money.",
  evidence: "Seen in the document.",
  location: { path: null, line_start: null, line_end: null, section: "Summary", quote: "Total price: EUR 24,000 excluding VAT." },
  likelihood: "likely",
  impact: "high",
  suggested_fix: null,
  assumption_challenge: false,
  confidence: 0.8,
});

function mergeConfig(rubricDir: string, sleep = 0) {
  writeConfig({
    rubric_paths: [rubricDir],
    merge_with: { adapter: "merger" },
    adapters: {
      fake: { type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs")], timeout_seconds: 30 },
      merger: { type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-merger.mjs"), ...(sleep ? [`--sleep=${sleep}`] : [])], timeout_seconds: 30 },
      person: { type: "pull" },
      person2: { type: "pull" },
    },
  });
}

test("findings from a rubric made confidential after the claims never reach the merge model", async () => {
  const dir = path.join(tmp, "rubrics-merge-flip");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "flip2.md"), RUBRIC.replace("confidential: true\n", ""));
  mergeConfig(dir);
  const e = new Engine(loadConfig());
  const review = await e.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "flip2", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }, { name: "person2" }], stage: "pre-merge" }, PERSON, 5);
  const a = e.claim(review.id, "person", { by: "Ana", client: null });
  const b = e.claim(review.id, "person2", { by: "Bo", client: null });
  writeFileSync(path.join(dir, "flip2.md"), RUBRIC); // now confidential, with no approvals for it
  await e.post(review.id, "person", a.token, { output: { verdict: "changes_requested", summary: "a", findings: [finding("Price is 70% off.")] } });
  const done = await e.post(review.id, "person2", b.token, { output: { verdict: "changes_requested", summary: "b", findings: [finding("Price is 70% wrong.")] } });
  assert.equal(done.rounds[0].merge!.method, "rules");
  assert.match(done.rounds[0].merge!.error!, /confidential/);
  writeConfig();
});

test("the last pull answer is acknowledged within the wait, while a slow merge finishes the round", async () => {
  const dir = path.join(tmp, "rubrics-slow-merge");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "open.md"), RUBRIC.replace("confidential: true\n", ""));
  mergeConfig(dir, 3000);
  const e = new Engine(loadConfig());
  const review = await e.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "open", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }, { name: "person2" }], stage: "pre-merge" }, PERSON, 5);
  const a = e.claim(review.id, "person", { by: "Ana", client: null });
  const b = e.claim(review.id, "person2", { by: "Bo", client: null });
  await e.post(review.id, "person", a.token, { output: { verdict: "changes_requested", summary: "a", findings: [finding("Price is 70% off.")] } });
  const started = Date.now();
  const acked = await e.post(review.id, "person2", b.token, { output: { verdict: "changes_requested", summary: "b", findings: [finding("Price is 70% wrong.")] } }, { waitSeconds: 0.5 });
  assert.ok(Date.now() - started < 2000);
  assert.equal(acked.state, "in_review"); // saved, still being finished
  await e.settled(review.id);
  const done = e.get(review.id);
  assert.equal(done.state, "changes_requested");
  assert.equal(done.rounds[0].merge!.method, "model");
  assert.ok(done.rounds[0].finished_at);
  writeConfig();
});

test("a resubmitted round takes max_blocking from the rubric as it is now", async () => {
  const dir = path.join(tmp, "rubrics-limit-change");
  mkdirSync(dir, { recursive: true });
  const rubric = (n: number) => RUBRIC.replace("confidential: true\n", `max_blocking: ${n}\n`).replace("require_signoff: true\n", "");
  writeFileSync(path.join(dir, "lim.md"), rubric(1));
  writeConfig({ rubric_paths: [dir] });
  const e = new Engine(loadConfig());
  const review = await e.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "lim", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" }, PERSON, 10);
  await e.settled(review.id);
  const r1 = e.get(review.id).rounds[0];
  assert.equal(r1.policy!.max_blocking, 1);
  writeFileSync(path.join(dir, "lim.md"), rubric(5));
  const answers = r1.findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "deferred" as const }));
  await e.respond(review.id, answers, { resubmit: true });
  await e.settled(review.id);
  assert.equal(e.get(review.id).rounds[1].policy!.max_blocking, 5);
  writeConfig();
});

test("a kept inbox form is unwrapped even when another tab already renewed the session", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  const work = engine.claim(review.id, "person", { by: "Ana", client: null });
  const payload = new URLSearchParams({ claim_token: work.token, verdict: "approve", summary: "Second tab.", decline: "", f_claim: "" }).toString();
  const ok = await fetch(`${base}inbox/login`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  const res = await fetch(`${base}inbox/claim/${review.id}/person/post`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ _payload: payload, _reauth_token: token }), redirect: "manual" });
  assert.equal(res.status, 303);
  assert.equal(engine.get(review.id).state, "approved");
});

test("at the session cap, the oldest idle session makes room for a new client", async () => {
  process.env.REVIEW_BUS_MAX_SESSIONS = "1";
  const s = await startHttp(engine, { port: 0, host: "127.0.0.1" });
  delete process.env.REVIEW_BUS_MAX_SESSIONS;
  const opts = { requestInit: { headers: { authorization: `Bearer ${token}` } } };
  try {
    const a = new Client({ name: "a", version: "0" });
    await a.connect(new StreamableHTTPClientTransport(new URL(`${s.url}mcp`), opts));
    await a.close(); // gone without ending its session: idle, not expired yet
    await new Promise((r) => setTimeout(r, 100));
    const b = new Client({ name: "b", version: "0" });
    await b.connect(new StreamableHTTPClientTransport(new URL(`${s.url}mcp`), opts));
    assert.ok((await b.listTools()).tools.length > 0);
    await b.close();
  } finally {
    await s.close();
  }
});

test("a codex-review stopped during preparation leaves no scratch copy", async () => {
  writeConfig({ adapters: { native: { type: "codex-review", command: path.join(ROOT, "test/fake-codex.mjs"), timeout_seconds: 3 } } });
  const e = new Engine(loadConfig());
  const repo = path.join(tmp, "repo-cleanup");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "a");
  writeFileSync(path.join(repo, "a.txt"), "b\n");
  const review = await e.submit({ artifact: { git: { repo, mode: "uncommitted" } }, pages: [], rubric: "code", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "native" }], stage: "pre-merge" }, PERSON, 10);
  await e.settled(review.id);
  assert.match(e.get(review.id).rounds[0].reviewers[0].error!, /Codex was not started/);
  assert.ok(!existsSync(path.join(tmp, "reviews", review.id, "r1", "native.native")));
  writeConfig();
});

// ---- Fresh review #2 (rv_01m8a5046v2wpk95k6vjk7sj7j) ----

test("a confidential rubric added to the config while a server runs is honoured at claim time", async () => {
  const d1 = path.join(tmp, "rubrics-a");
  const d2 = path.join(tmp, "rubrics-b");
  mkdirSync(d1, { recursive: true });
  mkdirSync(d2, { recursive: true });
  writeFileSync(path.join(d1, "swap.md"), RUBRIC.replace("confidential: true\n", ""));
  writeFileSync(path.join(d2, "swap.md"), RUBRIC);
  writeConfig({ rubric_paths: [d1] });
  const e = new Engine(loadConfig()); // started with d1 only
  const review = await e.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "swap", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" }, PERSON, 5);
  writeConfig({ rubric_paths: [d1, d2] }); // a confidential replacement, added while running
  assert.throws(() => e.claim(review.id, "person", { by: "Ana", client: null }), /confidential/);
  writeConfig();
});

test("a review folder is private before the snapshot writes into it", async () => {
  const bin = path.join(tmp, "slow-bin2");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "pdftotext"), "#!/bin/sh\nsleep 1\necho 'Slow PDF text'\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldMask = process.umask(0o022);
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const before = new Set(existsSync(path.join(tmp, "reviews")) ? execFileSync("ls", [path.join(tmp, "reviews")]).toString().split("\n") : []);
    const pending = engine.submit(
      { artifact: { path: path.join(ROOT, "test/fixtures/proposal-bluefin.pdf") }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
      PERSON,
    );
    await new Promise((r) => setTimeout(r, 400)); // pdftotext is still running
    const fresh = execFileSync("ls", [path.join(tmp, "reviews")]).toString().split("\n").filter((d) => d && !before.has(d));
    assert.equal(fresh.length, 1);
    assert.equal(statSync(path.join(tmp, "reviews", fresh[0])).mode & 0o777, 0o700);
    const review = await pending;
    await engine.settled(review.id);
  } finally {
    process.env.PATH = oldPath;
    process.umask(oldMask);
  }
});

test("rb post never takes the claim token as an argument", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  const work = engine.claim(review.id, "person", { by: "Ana", client: null });
  const answer = path.join(tmp, "answer.json");
  writeFileSync(answer, JSON.stringify({ verdict: "approve", summary: "ok", findings: [] }));
  const rb = (args: string[], opts: { env?: Record<string, string>; input?: string } = {}) =>
    spawnSync(process.execPath, [path.join(ROOT, "dist/src/cli.js"), ...args], { encoding: "utf8", env: { ...process.env, REVIEW_BUS_CONFIG: configFile, ...opts.env }, input: opts.input ?? "" });
  const withArg = rb(["post", review.id, "person", "--token", work.token, "--file", answer]);
  assert.equal(withArg.status, 1);
  assert.match(withArg.stderr, /without --token/);
  const viaStdin = rb(["post", review.id, "person", "--token-stdin", "--file", answer], { input: work.token + "\n" });
  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  assert.equal(engine.get(review.id).state, "approved");
});

test("review_file serves only the claimed round's files", async () => {
  const doc = path.join(tmp, "two-rounds.md");
  writeFileSync(doc, readFileSync(FIXTURE, "utf8"));
  const review = await engine.submit({ artifact: { path: doc }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" }, PERSON, 5);
  const w1 = engine.claim(review.id, "person", { by: "Ana", client: null });
  await engine.post(review.id, "person", w1.token, { output: { verdict: "changes_requested", summary: "fix", findings: [finding("Price is wrong.")] } });
  const r1 = engine.get(review.id);
  await engine.respond(review.id, r1.rounds[0].findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "accepted" as const })), { resubmit: true });
  const w2 = engine.claim(review.id, "person", { by: "Bo", client: null });
  assert.deepEqual(w2.snapshot_files, ["r2/artifact.md"]);
  assert.ok(engine.claimedFile(review.id, "person", w2.token, "r2/artifact.md"));
  assert.throws(() => engine.claimedFile(review.id, "person", w2.token, "r1/artifact.md"), /not a file of this round's snapshot/);
});

test("a cancel from another process stops a slow merge started by the last pull answer", async () => {
  const dir = path.join(tmp, "rubrics-cancel-merge");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "open2.md"), RUBRIC.replace("confidential: true\n", ""));
  mergeConfig(dir, 8000);
  const e = new Engine(loadConfig());
  const review = await e.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "open2", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }, { name: "person2" }], stage: "pre-merge" }, PERSON, 5);
  const a = e.claim(review.id, "person", { by: "Ana", client: null });
  const b = e.claim(review.id, "person2", { by: "Bo", client: null });
  await e.post(review.id, "person", a.token, { output: { verdict: "changes_requested", summary: "a", findings: [finding("Price is 70% off.")] } });
  await e.post(review.id, "person2", b.token, { output: { verdict: "changes_requested", summary: "b", findings: [finding("Price is 70% wrong.")] } }, { waitSeconds: 0.2 });
  const started = Date.now();
  new Engine(loadConfig()).cancel(review.id); // as rb cancel in another terminal
  await e.settled(review.id);
  assert.ok(Date.now() - started < 5000, `merge kept running ${Date.now() - started} ms after the cancel`);
  assert.equal(e.get(review.id).state, "canceled");
  writeConfig();
});

// ---- Fresh review #2, round 2 ----

test("trailing spaces on the front matter delimiters keep the confidential flag", () => {
  const dir = path.join(tmp, "rubrics-trailing");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "spaced.md"), RUBRIC.replace(/^---\n/, "--- \n").replace("\n---\n# Acme", "\n---\t\n# Acme"));
  assert.deepEqual(checkRubricPath(path.join(dir, "spaced.md"))[0].problems, []);
  assert.equal(loadRubric("spaced", [dir]).meta.confidential, true);
});

test("review_file refuses once the rubric became confidential without approving the reviewer", async () => {
  const dir = path.join(tmp, "rubrics-file-flip");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "fflip.md"), RUBRIC.replace("confidential: true\n", ""));
  writeConfig({ rubric_paths: [dir] });
  const e = new Engine(loadConfig());
  const review = await e.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "fflip", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" }, PERSON, 5);
  const work = e.claim(review.id, "person", { by: "Remote", client: null });
  assert.ok(e.claimedFile(review.id, "person", work.token, "r1/artifact.md"));
  writeFileSync(path.join(dir, "fflip.md"), RUBRIC);
  assert.throws(() => e.claimedFile(review.id, "person", work.token, "r1/artifact.md"), /confidential/);
  writeConfig();
});

test("refreshing the inbox records a missed pull deadline", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "Expiring work", assumptions: [], criteria: [], reviewers: [{ name: "quick" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  await new Promise((r) => setTimeout(r, 1300));
  const ok = await fetch(`${base}inbox/login`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  const page = await (await fetch(`${base}inbox`, { headers: { cookie } })).text();
  const waiting = page.split("Waiting for a reviewer")[1].split("<h2>")[0];
  assert.doesNotMatch(waiting, new RegExp(review.id));
  await engine.settled(review.id);
  const r = JSON.parse(readFileSync(path.join(tmp, "reviews", review.id, "review.json"), "utf8"));
  assert.equal(r.rounds[0].reviewers[0].status, "failed");
  assert.match(r.rounds[0].reviewers[0].error, /no answer by the deadline/);
});

// ---- Fresh review #2, round 3 ----

test("dispatch checks the same rubric the prompt was built from, as configured at that moment", async () => {
  const d1 = path.join(tmp, "rubrics-d1");
  const d2 = path.join(tmp, "rubrics-d2");
  mkdirSync(d1, { recursive: true });
  mkdirSync(d2, { recursive: true });
  writeFileSync(path.join(d1, "swap2.md"), RUBRIC.replace("confidential: true\n", ""));
  writeFileSync(path.join(d2, "swap2.md"), RUBRIC);
  const bin = path.join(tmp, "slow-bin3");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "pdftotext"), "#!/bin/sh\nsleep 1\necho 'Slow PDF text'\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  writeConfig({ rubric_paths: [d1] });
  try {
    const e = new Engine(loadConfig());
    const pending = e.submit(
      { artifact: { path: path.join(ROOT, "test/fixtures/proposal-bluefin.pdf") }, pages: [], rubric: "swap2", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
      PERSON,
    );
    await new Promise((r) => setTimeout(r, 300));
    writeConfig({ rubric_paths: [d1, d2] }); // the confidential copy takes over while the snapshot runs
    const review = await pending;
    await e.settled(review.id);
    const run = e.get(review.id).rounds[0].reviewers[0];
    assert.equal(run.status, "failed");
    assert.match(run.error!, /confidential/);
  } finally {
    process.env.PATH = oldPath;
    writeConfig();
  }
});

test("resubmitting follows the round cap the last round ran under", async () => {
  const e = new Engine(loadConfig()); // max_rounds 3
  const review = await e.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" }, PERSON, 10);
  await e.settled(review.id);
  assert.equal(e.get(review.id).state, "changes_requested");
  writeConfig({ policy: { max_blocking: 5, max_rounds: 1 } }); // lowered while the review is open
  const other = new Engine(loadConfig());
  const answers = other.get(review.id).rounds[0].findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "deferred" as const }));
  await other.respond(review.id, answers, { resubmit: true });
  await other.settled(review.id);
  assert.equal(other.get(review.id).rounds.length, 2);
  writeConfig();
});

test("a post waiting for a busy review's lock does not block the event loop", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge" },
    PERSON,
    5,
  );
  const work = engine.claim(review.id, "person", { by: "Ana", client: null });
  const sleeper = spawn("sleep", ["30"]);
  const lock = path.join(tmp, "reviews", review.id, ".lock");
  mkdirSync(lock);
  writeFileSync(path.join(lock, "owner"), JSON.stringify({ pid: sleeper.pid, host: os.hostname(), token: "other", at: Date.now() }));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const posting = engine.post(review.id, "person", work.token, { output: { verdict: "approve", summary: "ok", findings: [] } });
    // post() reads the review first (no lock needed), then waits for the lock.
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(ticks >= 20, `only ${ticks} ticks while the post waited for the lock`);
    execFileSync("rm", ["-rf", lock]); // the other process lets go
    const done = await posting;
    assert.equal(done.state, "approved");
  } finally {
    clearInterval(timer);
    sleeper.kill();
  }
});

test("refreshing the inbox finishes a round whose finisher died", async () => {
  const review = await engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" },
    PERSON,
    10,
  );
  await engine.settled(review.id);
  const file = path.join(tmp, "reviews", review.id, "review.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(saved, { state: "in_review" });
  Object.assign(saved.rounds[0], { finished_at: null, findings: [], finalizing: { pid: 999999, host: os.hostname(), started_at: new Date().toISOString() } });
  writeFileSync(file, JSON.stringify(saved));
  const ok = await fetch(`${base}inbox/login`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
  const cookie = ok.headers.get("set-cookie")!.split(";")[0];
  await (await fetch(`${base}inbox`, { headers: { cookie } })).text();
  await engine.settled(review.id);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).state, "changes_requested");
});

test("codex-review keeps unchanged submodule pointers when only .gitmodules changes", async () => {
  const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "protocol.file.allow=always", ...args], { cwd });
  const lib = path.join(tmp, "sub2-lib");
  const app = path.join(tmp, "sub2-app");
  mkdirSync(lib);
  mkdirSync(app);
  writeFileSync(path.join(lib, "a"), "1\n");
  g(lib, "init", "-q");
  g(lib, "add", ".");
  g(lib, "commit", "-q", "-m", "one");
  g(app, "init", "-q");
  g(app, "submodule", "add", "-q", lib, "lib");
  g(app, "commit", "-q", "-m", "base");
  const pinned = g(app, "rev-parse", "HEAD:lib").toString().trim();
  writeFileSync(path.join(app, ".gitmodules"), readFileSync(path.join(app, ".gitmodules"), "utf8") + "\tbranch = main\n");
  const review = await engine.submit(
    { artifact: { git: { repo: app, mode: "uncommitted" } }, pages: [], rubric: "code", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "native" }], stage: "pre-merge" },
    PERSON,
    30,
  );
  await engine.settled(review.id);
  const run = engine.get(review.id).rounds[0].reviewers[0];
  assert.equal(run.status, "done", run.error ?? "");
  const scratch = path.join(tmp, "reviews", review.id, "r1", "native.native");
  const entry = execFileSync("git", ["ls-files", "-s", "lib"], { cwd: scratch, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString();
  assert.match(entry, new RegExp(`^160000 ${pinned} `));
});

test("empty front matter (adjacent delimiters) is valid, LF and CRLF", () => {
  const dir = path.join(tmp, "rubrics-empty-fm");
  mkdirSync(dir, { recursive: true });
  const body = RUBRIC.slice(RUBRIC.indexOf("# Acme"));
  writeFileSync(path.join(dir, "lf.md"), "---\n---\n" + body);
  writeFileSync(path.join(dir, "crlf.md"), "---\r\n---\r\n" + body);
  for (const n of ["lf", "crlf"]) {
    assert.deepEqual(checkRubricPath(path.join(dir, `${n}.md`))[0].problems, []);
    assert.deepEqual(loadRubric(n, [dir]).meta, {});
  }
});

test("rb submit reports a review canceled before its first round instead of crashing", { skip: !existsSync("/Applications/Google Chrome.app") && "Google Chrome not installed" }, async () => {
  const slow = http.createServer((_req, res) => setTimeout(() => res.end("<title>slow</title>"), 4000));
  await new Promise<void>((r) => slow.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(slow.address() as import("node:net").AddressInfo).port}/`;
  writeConfig({ snapshot_wait_seconds: 0 });
  try {
    const before = new Set(execFileSync("ls", [path.join(tmp, "reviews")]).toString().split("\n"));
    const child = spawn(process.execPath, [path.join(ROOT, "dist/src/cli.js"), "submit", "--page", url, "--rubric", "webpage", "--intent", "x"], { env: { ...process.env, REVIEW_BUS_CONFIG: configFile } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    let id = "";
    await waitUntil(() => {
      id = execFileSync("ls", [path.join(tmp, "reviews")]).toString().split("\n").find((d) => d && !before.has(d)) ?? "";
      return Boolean(id) && existsSync(path.join(tmp, "reviews", id, "review.json"));
    });
    new Engine(loadConfig()).cancel(id);
    const code = await new Promise<number>((r) => child.on("exit", (c) => r(c ?? 0)));
    assert.doesNotMatch(stderr, /TypeError/);
    assert.equal(code, 2, stderr);
  } finally {
    slow.closeAllConnections();
    slow.close();
    writeConfig();
  }
});

test("text sent inline: removed when the first snapshot fails later, or the review is canceled before its first round", async () => {
  writeConfig({ snapshot_wait_seconds: 0 });
  const slow = new Engine(loadConfig());
  const req = { artifact: { text: { name: "post.md", content: "Confidential draft" } }, pages: ["http://127.0.0.1:9/"], rubric: "webpage", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" as const };
  const failing = await slow.submit(req, PERSON);
  assert.equal(failing.state, "submitted");
  assert.ok(existsSync(path.join(tmp, "reviews", failing.id, "source")));
  await slow.settled(failing.id);
  assert.equal(slow.get(failing.id).state, "failed");
  assert.equal(existsSync(path.join(tmp, "reviews", failing.id, "source")), false);

  const canceled = await slow.submit(req, PERSON);
  slow.cancel(canceled.id);
  assert.equal(existsSync(path.join(tmp, "reviews", canceled.id, "source")), false);
  await slow.settled(canceled.id);
  assert.equal(slow.get(canceled.id).state, "canceled");
  writeConfig();
});

test("resubmitting text: a refused name writes nothing; each new version gets a folder of its own", async () => {
  const e = new Engine(loadConfig());
  const review = await e.submit({ artifact: { text: { name: "post.md", content: readFileSync(FIXTURE, "utf8") } }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" }, PERSON);
  await e.settled(review.id);
  const r1 = e.get(review.id);
  const answers = r1.rounds[0].findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "deferred" as const }));
  const sources = path.join(tmp, "reviews", review.id, "source");
  const before = readdirSync(sources).sort();
  await assert.rejects(e.respond(review.id, answers, { resubmit: true, artifact: { name: "../x.md", content: "y" } }), /plain file name/);
  assert.deepEqual(readdirSync(sources).sort(), before);
  await e.respond(review.id, answers, { resubmit: true, artifact: { name: "post.md", content: "Version two of the post." } });
  await e.settled(review.id);
  const after2 = readdirSync(sources).sort();
  assert.equal(after2.length, 2);
  assert.match(after2[1], /^r2-/);
  assert.equal(readFileSync(path.join(tmp, "reviews", review.id, "r2/artifact.md"), "utf8").trim(), "Version two of the post.");
  // Round 1's source is untouched.
  assert.equal(readFileSync(path.join(sources, "r1/01/post.md"), "utf8"), readFileSync(FIXTURE, "utf8"));
});

test("REVIEW_BUS_LOG records a text document's name and length, never its content, also for a refused call", async () => {
  const log = path.join(tmp, "diag.log");
  process.env.REVIEW_BUS_LOG = log;
  try {
    const secret = "SECRET-CONTRACT-TEXT price EUR 99,999";
    await call("review_submit", { artifact: { name: "c.md", content: secret }, related: [{ name: "p.md", content: secret }], rubric: "proposal", intent: "x", wait_seconds: 5 });
    await call("review_submit", { artifact: { name: "../bad.md", content: secret }, rubric: "proposal", intent: "x" });
    // Malformed, refused by the schema: still logged without the text.
    await call("review_submit", { artifact: { content: secret }, rubric: "proposal", intent: "x" });
    await call("review_submit", { artifact: { name: 5, content: secret }, related: [{ content: [secret] }], rubric: "proposal", intent: "x" });
    await call("review_submit", { artifact: { name: "c.md", content: "x" }, related: { "p.md": { content: secret } }, rubric: "proposal", intent: "x" });
    await call("review_submit", { artifact: [{ name: "c.md", content: secret }], rubric: "proposal", intent: "x" });
    await call("review_submit", { artifact: { git: { repo: ROOT, mode: "uncommitted", content: secret, base: { content: secret } } }, rubric: "code", intent: "x" });
    await call("review_submit", { artifact: { name: "c.md", content: "x" }, related: [{ git: { repo: secret } }], rubric: "proposal", intent: "x" });
  } finally {
    delete process.env.REVIEW_BUS_LOG;
  }
  const text = readFileSync(log, "utf8");
  assert.doesNotMatch(text, /SECRET-CONTRACT-TEXT/);
  assert.match(text, /"content":"\[37 characters\]"/);
  assert.equal(statSync(log).mode & 0o777, 0o600);
});

test("a streamed MCP request (no declared length) over the HTTP size limit gets a 413 with a reason, not a dropped connection", async () => {
  const u = new URL(`${base}mcp`);
  const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "transfer-encoding": "chunked" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    for (let i = 0; i < 33; i++) req.write(chunk);
    req.end();
  });
  assert.equal(answer.status, 413);
  assert.match(answer.body, /Request too large \(over 32 MB\)\. Send long documents as a path/);
});

test("the Claude desktop app (chat and Cowork) is recognised as an Anthropic author", () => {
  const map = loadConfig().author_vendors;
  assert.equal(vendorOfClient(map, "local-agent-mode-review-bus"), "anthropic");
  assert.equal(vendorOfClient(map, "claude-code"), "anthropic");
  assert.equal(vendorOfClient(map, "something-else"), null);
  // An exact key wins over a prefix, and the longest prefix over a shorter one.
  assert.equal(vendorOfClient({ "a*": "openai", "ab*": "other", abc: "anthropic" }, "abc"), "anthropic");
  assert.equal(vendorOfClient({ "a*": "openai", "ab*": "other" }, "abd"), "other");
});

test("a server that stopped while taking the first snapshot leaves no text or half-made snapshot behind", async () => {
  writeConfig({ snapshot_wait_seconds: 0 });
  const a = new Engine(loadConfig());
  const review = await a.submit({ artifact: { text: { name: "post.md", content: "Draft" } }, pages: ["http://127.0.0.1:9/"], rubric: "webpage", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" }, PERSON);
  await a.settled(review.id);
  // As a server killed mid-snapshot leaves it: preparing by a dead process, the text and a staging folder on disk.
  const dir = path.join(tmp, "reviews", review.id);
  mkdirSync(path.join(dir, "source/r1/01"), { recursive: true });
  writeFileSync(path.join(dir, "source/r1/01/post.md"), "Draft");
  mkdirSync(path.join(dir, ".staging-999999-abc/r1"), { recursive: true });
  writeFileSync(path.join(dir, ".staging-999999-abc/r1/artifact.md"), "Draft");
  // Moved into place, but the process stopped before recording it.
  mkdirSync(path.join(dir, "r1"), { recursive: true });
  writeFileSync(path.join(dir, "r1/artifact.md"), "Draft");
  const saved = JSON.parse(readFileSync(path.join(dir, "review.json"), "utf8"));
  Object.assign(saved, { state: "submitted", preparing: { pid: 999999, host: os.hostname(), started_at: new Date().toISOString() } });
  writeFileSync(path.join(dir, "review.json"), JSON.stringify(saved));
  assert.equal(new Engine(loadConfig()).get(review.id).state, "failed");
  assert.deepEqual(readdirSync(dir).filter((f) => f === "source" || f.startsWith(".staging-") || f === "r1"), []);
  writeConfig();
});

test("a resubmitted round whose save fails is taken back out: no unrecorded round folder stays", async () => {
  const e = new Engine(loadConfig());
  const review = await e.submit({ artifact: { text: { name: "post.md", content: readFileSync(FIXTURE, "utf8") } }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" }, PERSON);
  await e.settled(review.id);
  const answers = e.get(review.id).rounds[0].findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "deferred" as const }));
  const save = e.store.save.bind(e.store);
  e.store.save = (r) => {
    if (r.rounds.length === 2) throw new Error("disk full");
    save(r);
  };
  await assert.rejects(e.respond(review.id, answers, { resubmit: true, artifact: { name: "post.md", content: "Version two" } }), /disk full/);
  e.store.save = save;
  const dir = path.join(tmp, "reviews", review.id);
  assert.equal(existsSync(path.join(dir, "r2")), false);
  assert.deepEqual(readdirSync(path.join(dir, "source")), ["r1"]); // the attempt's text is gone too
  assert.equal(e.get(review.id).rounds.length, 1);
});

test("an MCP request declaring a length over the limit gets a 413 before its body is read", async () => {
  const u = new URL(`${base}mcp`);
  const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "content-length": String(100 * 1024 * 1024) } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.write("{");
  });
  assert.equal(answer.status, 413);
  assert.match(answer.body, /Request too large/);
});

test("text is written only after its review is saved, so a stopped process always leaves a review recovery can find", async () => {
  const e = new Engine(loadConfig());
  const save = e.store.save.bind(e.store);
  const atFirstSave: { preparing: boolean; textOnDisk: boolean }[] = [];
  e.store.save = (r) => {
    if (!atFirstSave.length) atFirstSave.push({ preparing: Boolean(r.preparing), textOnDisk: existsSync(path.join(tmp, "reviews", r.id, "source")) });
    save(r);
  };
  const review = await e.submit({ artifact: { text: { name: "post.md", content: "Draft" } }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" }, PERSON);
  // Saved first as being prepared by this process, with no text on disk yet.
  assert.deepEqual(atFirstSave, [{ preparing: true, textOnDisk: false }]);
  assert.ok(existsSync(path.join(tmp, "reviews", review.id, "source/r1/01/post.md")));
  await e.settled(review.id);
  assert.equal(e.get(review.id).state, "approved"); // "Draft" quotes none of the fake reviewer's findings
});

test("a git change with text fields next to it is refused, not reviewed as the git change", async () => {
  const { res, text } = await call("review_submit", { artifact: { git: { repo: ROOT, mode: "uncommitted" }, name: "post.md", content: "Draft" }, rubric: "code", intent: "x" });
  assert.equal(res.isError, true, text);
});

test("cleanup a stopped process left undone is retried: a failed review with no round, and a dead resubmit attempt", async () => {
  // A failed review with no round, saved as failed by a process that stopped before cleaning up.
  writeConfig({ snapshot_wait_seconds: 0 });
  const e = new Engine(loadConfig());
  const failed = await e.submit({ artifact: { text: { name: "post.md", content: "Draft" } }, pages: ["http://127.0.0.1:9/"], rubric: "webpage", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" }, PERSON);
  await e.settled(failed.id);
  writeConfig();
  const fdir = path.join(tmp, "reviews", failed.id);
  mkdirSync(path.join(fdir, "source/r1/01"), { recursive: true });
  writeFileSync(path.join(fdir, "source/r1/01/post.md"), "Draft");
  assert.equal(new Engine(loadConfig()).get(failed.id).state, "failed");
  assert.equal(existsSync(path.join(fdir, "source")), false);

  // A review with a round: a dead process's unrecorded resubmit attempt goes; a live one's and round 1's stay.
  const review = await e.submit({ artifact: { text: { name: "post.md", content: "Draft one" } }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" }, PERSON);
  await e.settled(review.id);
  const sources = path.join(tmp, "reviews", review.id, "source");
  for (const f of ["r2-999999-abc", `r2-${process.pid}-def`]) {
    mkdirSync(path.join(sources, f, "01"), { recursive: true });
    writeFileSync(path.join(sources, f, "01/post.md"), "Draft two");
  }
  new Engine(loadConfig()).get(review.id);
  assert.deepEqual(readdirSync(sources).sort(), [`r2-${process.pid}-def`, "r1"].sort());
});

test("from round 2 only critical findings, and high ones that are certain or likely, block; later_rounds same keeps round 1's rule", async () => {
  const fake = { type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs"), "--high-possible"], timeout_seconds: 30 };
  const run = async (later_rounds?: "same") => {
    writeConfig({ adapters: { fake }, ...(later_rounds ? { policy: { later_rounds } } : {}) });
    const e = new Engine(loadConfig());
    const review = await e.submit({ artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" }, PERSON, 10);
    await e.settled(review.id);
    const r1 = e.get(review.id).rounds[0];
    const answers = r1.findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "deferred" as const }));
    await e.respond(review.id, answers, { resubmit: true });
    await e.settled(review.id);
    const done = e.get(review.id);
    const blocks = (n: number, claim: string) => done.rounds[n].findings.find((f) => f.claim.startsWith(claim))!.blocking;
    return { done, blocks };
  };
  const stricter = await run();
  assert.equal(stricter.blocks(0, "The support hours"), true); // high/possible blocks in round 1
  assert.equal(stricter.blocks(1, "The support hours"), false); // and is advisory from round 2
  assert.equal(stricter.blocks(1, "The total price"), true); // critical still blocks
  assert.equal(stricter.blocks(1, "The 70% resolution rate"), true); // high/likely still blocks
  assert.equal(stricter.done.rounds[1].policy!.later_rounds, "stricter");
  assert.match(readFileSync(path.join(tmp, "reviews", stricter.done.id, "report.md"), "utf8"), /From round 2 only critical findings, and high ones that are certain or likely, block/);
  // A draft review blocks only critical findings in every round: the later-rounds note is not shown.
  assert.doesNotMatch(renderSummary({ ...stricter.done, request: { ...stricter.done.request, stage: "draft" } }), /From round 2/);
  const same = await run("same");
  assert.equal(same.blocks(1, "The support hours"), true);
  writeConfig();
});

test("a client in long_wait_clients waits for the round without a progressToken; others stay under max_wait_seconds", async () => {
  const slow = { type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs"), "--sleep=2500"], timeout_seconds: 30 };
  writeConfig({ adapters: { slow }, max_wait_seconds: 1, long_wait_clients: ["desktop-app-*"] });
  const e = new Engine(loadConfig());
  const s = await startHttp(e, { port: 0, host: "127.0.0.1" });
  const opts = { requestInit: { headers: { authorization: `Bearer ${token}` } } };
  const submitAs = async (name: string) => {
    const c = new Client({ name, version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${s.url}mcp`), opts));
    try {
      const res = (await c.callTool({ name: "review_submit", arguments: { artifact: FIXTURE, rubric: "proposal", intent: "x", reviewers: ["slow"], wait_seconds: 10 } })) as ToolResult;
      return JSON.parse(res.content.map((x) => x.text).find((t) => t.includes('"review_id"'))!).state as string;
    } finally {
      await c.close();
    }
  };
  try {
    assert.equal(await submitAs("desktop-app-review-bus"), "changes_requested"); // waited for the round
    assert.equal(await submitAs("other-client"), "in_review"); // answered within max_wait_seconds
  } finally {
    await s.close();
    writeConfig();
  }
});

test("a resubmit can send changes to the version last reviewed instead of the whole text; the author's file is only read", async () => {
  writeConfig();
  const e = new Engine(loadConfig());
  const file = path.join(tmp, "draft-proposal.md");
  writeFileSync(file, readFileSync(FIXTURE, "utf8"));
  const original = readFileSync(file, "utf8");
  const review = await e.submit({ artifact: { path: file }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" }, PERSON, 10);
  await e.settled(review.id);
  // The author keeps working on the file after round 1; the edits apply to what round 1 reviewed.
  writeFileSync(file, original + "\nUNREVIEWED DRAFT LINE\n");
  const answers = e.get(review.id).rounds[0].findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "accepted" as const }));
  // Refused before anything is saved: a find that occurs twice, one that is missing, overlapping edits, artifact and changes together.
  await assert.rejects(e.respond(review.id, answers, { resubmit: true, changes: [{ find: "EUR", replace: "USD" }] }), /occurs \d+ times .* exactly once.*Nothing was changed/);
  await assert.rejects(e.respond(review.id, answers, { resubmit: true, changes: [{ find: "not in the text", replace: "x" }] }), /occurs 0 times/);
  await assert.rejects(
    e.respond(review.id, answers, { resubmit: true, changes: [{ find: "Total price: EUR 24,000", replace: "a" }, { find: "EUR 24,000 excluding", replace: "b" }] }),
    /Changes 1 and 2 overlap/,
  );
  await assert.rejects(e.respond(review.id, answers, { resubmit: true, artifact: file, changes: [{ find: "a", replace: "b" }] }), /either artifact or changes/);
  // Too long once edited: refused before the answers are saved.
  await assert.rejects(e.respond(review.id, answers, { resubmit: true, changes: [{ find: "Two languages: German and English.", replace: "x".repeat(1_000_001) }] }), /longer than 1000000 characters/);
  // Another call moved the review on after these edits were made: refused, nothing saved.
  const realGet = e.get.bind(e);
  const stale = structuredClone(realGet(review.id));
  e.get = ((rid: string) => { e.get = realGet; return rid === review.id ? stale : realGet(rid); }) as typeof e.get;
  e.store.update(review.id, (r) => void r.rounds.push({ ...structuredClone(r.rounds[0]), n: 2 }));
  await assert.rejects(e.respond(review.id, answers, { resubmit: true, changes: [{ find: "Two languages: German and English.", replace: "y" }] }), /moved on to round 2 while the changes were made against round 1/);
  e.store.update(review.id, (r) => void r.rounds.pop());
  assert.equal(e.get(review.id).rounds.length, 1);
  assert.ok(e.get(review.id).rounds[0].findings.every((f) => f.response === null), "a refused edit saves no answers");
  // Each edit applies where it was found in the reviewed text: the first edit's new text ("Go-live
  // on 15 March 2027.") must not become the target of the second edit.
  await e.respond(review.id, answers, {
    resubmit: true,
    changes: [
      { find: "Total price: EUR 24,000 excluding VAT.", replace: "Total price: EUR 22,500 excluding VAT. Go-live on 15 March 2027." },
      { find: "Go-live on 15 March 2027.", replace: "Go-live on 1 April 2027." },
      { find: "Two languages: German and English.", replace: "Two languages: German and English, $& extra" },
    ],
  });
  await e.settled(review.id);
  const done = e.get(review.id);
  assert.equal(readFileSync(file, "utf8"), original + "\nUNREVIEWED DRAFT LINE\n"); // the author's file is untouched
  assert.equal(done.request.artifact?.inline, true); // the new version is kept as text
  const r2 = readFileSync(path.join(tmp, "reviews", review.id, "r2", "artifact.md"), "utf8");
  assert.match(r2, /Total price: EUR 22,500 excluding VAT\. Go-live on 15 March 2027\. Go-live on 1 April 2027\./);
  assert.match(r2, /German and English, \$& extra/); // replacement text is literal, $& is not a pattern
  assert.doesNotMatch(r2, /UNREVIEWED DRAFT LINE/);
  // A later resubmit edits the version round 2 reviewed, not the original.
  // A file name text documents cannot have (R&D.md) is kept readable for the new version.
  const odd = path.join(tmp, "R&D plan.md");
  writeFileSync(odd, original);
  const r3 = await e.submit({ artifact: { path: odd }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "fake" }], stage: "pre-merge" }, PERSON, 10);
  await e.settled(r3.id);
  const oddAnswers = e.get(r3.id).rounds[0].findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "deferred" as const }));
  await e.respond(r3.id, oddAnswers, { resubmit: true, changes: [{ find: "Two languages: German and English.", replace: "Three languages." }] });
  await e.settled(r3.id);
  assert.equal(path.basename(e.get(r3.id).request.artifact!.path!), "R-D plan.md");
  const answers2 = done.rounds[1].findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "deferred" as const }));
  await assert.rejects(e.respond(review.id, answers2, { resubmit: true, changes: [{ find: "EUR 24,000 excluding VAT.", replace: "x" }] }), /occurs 0 times/);
});

test("rounds saved before later_rounds existed keep the round 1 rule", () => {
  const round = (policy?: Record<string, unknown>) => ({ n: 2, policy }) as unknown as Parameters<typeof laterRounds>[0];
  assert.equal(laterRounds(round()), "same"); // no frozen policy at all
  assert.equal(laterRounds(round({ max_blocking: 5, max_rounds: 3 })), "same"); // frozen before the setting
  assert.equal(laterRounds(round({ max_blocking: 5, max_rounds: 3, later_rounds: "stricter" })), "stricter");
});

test("without a config file review-bus uses the example config: Codex and Claude review, reviews in ~/.review-bus", () => {
  const c = loadConfig(null);
  assert.deepEqual(c.default_reviewers, ["codex", "claude"]);
  assert.deepEqual([c.adapters.codex.type, c.adapters.claude.type, c.adapters.agy.vendor], ["codex", "claude", "google"]);
  assert.equal(c.storage.documents, path.join(os.homedir(), ".review-bus", "reviews"));
  assert.equal(c.config_file, null);
  assert.ok(c.rubric_paths.includes(path.join(os.homedir(), ".review-bus", "rubrics")));
});
