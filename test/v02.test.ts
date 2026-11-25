// v0.2: pull reviewers, MCP over HTTP with a token, the web inbox, rubric packs, the review id
// before slow page capture, and Codex's native review pass (with a fake codex).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { startHttp } from "../src/http.js";
import { checkRubricPath, listRubrics, loadRubric } from "../src/rubrics.js";

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
  await call("review_release", { review_id: id, reviewer: "person", by: "Ana" });
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
  engine.release(review.id, "person", "test");
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
  const oldAt = engine.get(review.id).rounds[0].reviewers[0].claim!.at;
  engine.release(review.id, "person", "Ana", oldAt);
  await new Promise((r) => setTimeout(r, 5));
  engine.claim(review.id, "person", { by: "Bo", client: null });
  assert.throws(() => engine.release(review.id, "person", "Ana", oldAt), /claimed again since \(by Bo\)/);
  assert.equal(engine.get(review.id).rounds[0].reviewers[0].claim!.by, "Bo");
});
