// Webpage review: git snapshots (uncommitted, base, commit) and rendered page screenshots.
// Builds a throwaway git repo with a tiny fictional site and serves it over HTTP.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let tmp: string;
let client: Client;
let server: http.Server;
let base: string; // http://127.0.0.1:<port>
let hasChrome = true;
type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

const SITE = {
  "index.html": `<!doctype html><html lang="en"><head><title>Northwind Labs</title>
<meta name="description" content="Fictional test site.">
<meta property="og:title" content="Northwind Labs"></head>
<body><h1>Northwind Labs</h1><p>We build support assistants.</p>
<img src="logo.png" alt="Northwind Labs logo"><a href="about.html">About</a></body></html>`,
  "about.html": `<!doctype html><html lang="en"><head><title>About</title></head><body><h1>About</h1><p>Fictional.</p></body></html>`,
};

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], { cwd }).toString();
}

function newRepo(name: string): string {
  const repo = path.join(tmp, name);
  mkdirSync(repo);
  for (const [f, c] of Object.entries(SITE)) writeFileSync(path.join(repo, f), c);
  sh(repo, "init", "-q");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "site");
  return repo;
}

/** The change under review: a TODO, an image without alt, a broken link, a console error, a new page. */
function makeChange(repo: string) {
  writeFileSync(
    path.join(repo, "index.html"),
    SITE["index.html"].replace(
      "<p>We build support assistants.</p>",
      `<p>We build support assistants. TODO: add pricing.</p><img src="team.png"><a href="missing.html">Pricing</a><script>console.error("boom")</script>`,
    ),
  );
  writeFileSync(path.join(repo, "contact.html"), "<!doctype html><title>Contact</title><p>Write to us.</p>");
}

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  const blocks = res.content.map((c) => c.text).filter((t) => t.trim().startsWith("{")).map((t) => JSON.parse(t));
  return { res, text: res.content[0].text, json: res.isError ? null : (blocks.find((b) => b.review_id) ?? blocks.at(-1)) };
}

const reviewDir = (id: string) => path.join(tmp, "reviews", id);
const snapshotOf = (id: string, n = 0) => JSON.parse(readFileSync(path.join(reviewDir(id), "review.json"), "utf8")).rounds[n].snapshot;

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "review-bus-web-"));
  // Serve whatever folder the URL names under tmp (each test has its own repo).
  server = http.createServer((req, res) => {
    const file = path.join(tmp, decodeURIComponent(new URL(req.url!, "http://x").pathname));
    if (!file.startsWith(tmp) || !existsSync(file) || !file.endsWith(".html")) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const { chromium } = await import("playwright-core");
    await (await chromium.launch({ channel: "chrome", headless: true })).close();
  } catch {
    hasChrome = false;
  }

  const fake = { type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs")], timeout_seconds: 60 };
  const configFile = path.join(tmp, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      storage: { documents: path.join(tmp, "reviews") },
      default_reviewers: ["fake"],
      adapters: { fake, codex: { type: "codex", command: path.join(ROOT, "test/fake-codex.mjs"), timeout_seconds: 60 } },
    }),
  );
  client = new Client({ name: "web-author", version: "0.0.0" });
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
  server?.close();
});

test("uncommitted change + rendered page: snapshot, screenshots, facts, findings; the repo is untouched", { skip: !hasChrome && "Google Chrome not installed" }, async (t) => {
  if (!hasChrome) return t.skip("Google Chrome not installed");
  const repo = newRepo("site-uncommitted");
  makeChange(repo);
  const statusBefore = sh(repo, "status", "--porcelain");

  const { json, text } = await call("review_submit", {
    artifact: { git: { repo, mode: "uncommitted" } },
    pages: [`${base}/site-uncommitted/index.html`],
    rubric: "webpage",
    intent: "Launch the new home page.",
    wait_seconds: 60,
  });
  assert.ok(json, text);
  const snap = snapshotOf(json.review_id);
  assert.equal(snap.kind, "git");
  assert.deepEqual(snap.git.files, [
    { status: "M", path: "index.html" },
    { status: "A", path: "contact.html" },
  ]);
  const dir = reviewDir(json.review_id);
  // The reviewers' copy has the change, including the untracked file.
  assert.match(readFileSync(path.join(dir, "r1/tree/index.html"), "utf8"), /TODO: add pricing/);
  assert.ok(existsSync(path.join(dir, "r1/tree/contact.html")));
  assert.ok(existsSync(path.join(dir, "r1/tree/about.html")));
  assert.match(readFileSync(path.join(dir, "r1/change.md"), "utf8"), /Changed files \(2, \+\d+ -\d+\):\n- M index.html\n- A contact.html/);

  const page = snap.pages[0];
  assert.equal(page.status, 200);
  assert.equal(page.title, "Northwind Labs");
  assert.equal(page.description, "Fictional test site.");
  assert.equal(page.og["og:title"], "Northwind Labs");
  assert.deepEqual(page.images_missing_alt, ["team.png"]);
  assert.deepEqual(page.broken_links.map((b: { href: string }) => b.href), [`${base}/site-uncommitted/missing.html`]);
  assert.ok(page.console_errors.includes("boom"));
  assert.deepEqual([...new Set(page.screenshots.map((s: { viewport: string }) => s.viewport))], ["desktop", "mobile"]);
  for (const s of page.screenshots) assert.ok(readFileSync(path.join(dir, s.file)).subarray(1, 4).toString() === "PNG");

  // The prompt carries the diff and the page facts; the reviewer got the screenshots.
  const prompt = readFileSync(path.join(dir, "r1/prompt.md"), "utf8");
  assert.match(prompt, /<diff>[\s\S]*TODO: add pricing[\s\S]*<\/diff>/);
  assert.match(prompt, /- Images without alt text: 1 \(team\.png\)/);
  assert.match(prompt, /## Rubric: webpage/);
  assert.equal(json.reviewers[0].summary.match(/images=(\d+)/)[1], String(page.screenshots.length));
  assert.deepEqual(
    json.findings.map((f: { claim: string; blocking: boolean }) => [f.claim.split(" ").slice(0, 3).join(" "), f.blocking]),
    [["Placeholder text TODO", true]],
  );
  assert.equal(json.counts.advisory, 1); // missing alt text

  // Nothing in the author's repo changed: same status, no worktrees, no new refs.
  assert.equal(sh(repo, "status", "--porcelain"), statusBefore);
  assert.ok(!existsSync(path.join(repo, ".git/worktrees")));
  assert.equal(sh(repo, "for-each-ref").trim().split("\n").length, 1);

  // Fix and resubmit: the TODO is gone, round 2 approves.
  writeFileSync(path.join(repo, "index.html"), readFileSync(path.join(repo, "index.html"), "utf8").replace(" TODO: add pricing.", ""));
  const r2 = await call("review_respond", {
    review_id: json.review_id,
    responses: [{ finding_id: "r1.f1", status: "accepted", note: "Removed." }],
    resubmit: true,
    wait_seconds: 60,
  });
  assert.equal(r2.json.round, 2);
  assert.equal(r2.json.state, "approved");
  assert.doesNotMatch(readFileSync(path.join(dir, "r2/tree/index.html"), "utf8"), /TODO/);
});

test("codex gets the screenshots attached as --image files", { skip: !hasChrome && "Google Chrome not installed" }, async (t) => {
  if (!hasChrome) return t.skip("Google Chrome not installed");
  const repo = newRepo("site-codex");
  makeChange(repo);
  const { json, text } = await call("review_submit", {
    pages: [`${base}/site-codex/index.html`, `${base}/site-codex/about.html`],
    rubric: "webpage",
    intent: "x",
    reviewers: ["codex"],
    wait_seconds: 60,
  });
  assert.ok(json, text);
  assert.equal(json.reviewers[0].status, "done", json.reviewers[0].error ?? "");
  const shots = snapshotOf(json.review_id).pages.flatMap((p: { screenshots: unknown[] }) => p.screenshots).length;
  assert.ok(shots >= 4);
  assert.match(json.reviewers[0].summary, new RegExp(`images=${shots}\\]`));
  assert.equal(snapshotOf(json.review_id).kind, "pages");
});

test("long pages are cut into tiles", { skip: !hasChrome && "Google Chrome not installed" }, async (t) => {
  if (!hasChrome) return t.skip("Google Chrome not installed");
  const repo = newRepo("site-long");
  writeFileSync(path.join(repo, "long.html"), `<!doctype html><html lang="en"><title>Long</title><body style="margin:0"><div style="height:4000px;background:linear-gradient(#fff,#ccc)">Tall</div></body></html>`);
  const { json, text } = await call("review_submit", { pages: [`${base}/site-long/long.html`], rubric: "webpage", intent: "x", wait_seconds: 60 });
  assert.ok(json, text);
  const desktop = snapshotOf(json.review_id).pages[0].screenshots.filter((s: { viewport: string }) => s.viewport === "desktop");
  assert.deepEqual(desktop.map((s: { y: number; height: number }) => [s.y, s.height]), [[0, 1800], [1800, 1800], [3600, 400]]);
});

test("base mode reviews the branch's commits against main", async () => {
  const repo = newRepo("site-branch");
  sh(repo, "checkout", "-q", "-b", "feature");
  makeChange(repo);
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "change");
  writeFileSync(path.join(repo, "about.html"), "uncommitted edit");

  const { json, text } = await call("review_submit", { artifact: { git: { repo, mode: "base", base: "main" } }, rubric: "webpage", intent: "x", wait_seconds: 30 });
  assert.ok(json, text);
  const g = snapshotOf(json.review_id).git;
  assert.deepEqual([g.mode, g.base_ref, g.branch], ["base", "main", "feature"]);
  assert.deepEqual(g.files.map((f: { path: string }) => f.path).sort(), ["contact.html", "index.html"]);
  assert.deepEqual(g.notes, [
    "1 commit(s) on feature since main.",
    "The working tree has uncommitted changes; they are not part of this review (mode base reviews commits).",
  ]);
  // The uncommitted edit is not in the reviewers' copy.
  assert.match(readFileSync(path.join(reviewDir(json.review_id), "r1/tree/about.html"), "utf8"), /Fictional/);
});

test("commit mode, no-change and bad inputs", async () => {
  const repo = newRepo("site-commit");
  makeChange(repo);
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "change");

  const { json, text } = await call("review_submit", { artifact: { git: { repo, mode: "commit" } }, rubric: "webpage", intent: "x", wait_seconds: 30 });
  assert.ok(json, text);
  const g = snapshotOf(json.review_id).git;
  assert.equal(g.files.length, 2);
  assert.match(g.base_ref, /\^$/);

  // The first commit has no parent: everything is new.
  const first = sh(repo, "rev-list", "--max-parents=0", "HEAD").trim();
  const root = await call("review_submit", { artifact: { git: { repo, mode: "commit", commit: first } }, rubric: "webpage", intent: "x", wait_seconds: 30 });
  assert.ok(root.json, root.text);
  assert.deepEqual(snapshotOf(root.json.review_id).git.files.map((f: { status: string }) => f.status), ["A", "A"]);

  const none = await call("review_submit", { artifact: { git: { repo, mode: "uncommitted" } }, rubric: "webpage", intent: "x" });
  assert.match(none.text, /No changes to review/);
  const notRepo = await call("review_submit", { artifact: { git: { repo: tmp, mode: "uncommitted" } }, rubric: "webpage", intent: "x" });
  assert.match(notRepo.text, /git rev-parse failed/);
  const fileUrl = await call("review_submit", { pages: ["file:///etc/hosts"], rubric: "webpage", intent: "x" });
  assert.match(fileUrl.text, /Only http and https pages/);
  const nothing = await call("review_submit", { rubric: "webpage", intent: "x" });
  assert.match(nothing.text, /Nothing to review/);
});

test("a page server that is not running gives a clear error and leaves no half-made review", { skip: !hasChrome && "Google Chrome not installed" }, async (t) => {
  if (!hasChrome) return t.skip("Google Chrome not installed");
  // A port nothing listens on.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const dead = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/`;
  await new Promise((r) => probe.close(r));

  const repo = newRepo("site-down");
  makeChange(repo);
  const reviews = path.join(tmp, "reviews");
  const before = existsSync(reviews) ? readdirSync(reviews).sort() : [];
  const { text } = await call("review_submit", { artifact: { git: { repo, mode: "uncommitted" } }, pages: [dead], rubric: "webpage", intent: "x" });
  assert.equal(text, `Nothing is answering at ${dead}. Start the site first (for example your dev server with npm run dev), then submit again.`);
  assert.deepEqual(existsSync(reviews) ? readdirSync(reviews).sort() : [], before);

  // A resubmit that fails the same way keeps the answers and the review, and removes only the new round.
  const ok = await call("review_submit", { artifact: { git: { repo, mode: "uncommitted" } }, pages: [`${base}/site-down/index.html`], rubric: "webpage", intent: "x", wait_seconds: 60 });
  assert.ok(ok.json, ok.text);
  const id = ok.json.review_id;
  server.close();
  const failed = await call("review_respond", { review_id: id, responses: [{ finding_id: "r1.f1", status: "accepted", note: "Fixing." }], resubmit: true });
  assert.match(failed.text, /Nothing is answering at http:\/\/127\.0\.0\.1:\d+\/site-down\/index\.html/);
  const saved = JSON.parse(readFileSync(path.join(reviewDir(id), "review.json"), "utf8"));
  assert.deepEqual([saved.state, saved.rounds.length, saved.rounds[0].findings[0].response.status], ["changes_requested", 1, "accepted"]);
  assert.ok(!existsSync(path.join(reviewDir(id), "r2")));
});

test("mode all reviews the whole project at HEAD; lockfile and binary diffs stay out of the prompt", async () => {
  const repo = newRepo("site-all");
  writeFileSync(path.join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { big: "x".repeat(5000) } }));
  writeFileSync(path.join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255]));
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "lock and logo");
  writeFileSync(path.join(repo, "about.html"), "uncommitted edit");

  const { json, text } = await call("review_submit", { artifact: { git: { repo, mode: "all" } }, rubric: "code", intent: "x", wait_seconds: 30 });
  assert.ok(json, text);
  const g = snapshotOf(json.review_id).git;
  assert.deepEqual([g.mode, g.base_ref], ["all", null]);
  assert.deepEqual(g.files.map((f: { path: string }) => f.path).sort(), ["about.html", "index.html", "logo.png", "package-lock.json"]);
  assert.ok(g.files.every((f: { status: string }) => f.status === "A"));
  assert.match(g.notes.join(" "), /uncommitted changes; they are not part of this review/);

  const dir = reviewDir(json.review_id);
  // The tree is HEAD: the committed about.html, the binary logo intact.
  assert.match(readFileSync(path.join(dir, "r1/tree/about.html"), "utf8"), /Fictional/);
  assert.deepEqual([...readFileSync(path.join(dir, "r1/tree/logo.png"))], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255]);
  const change = readFileSync(path.join(dir, "r1/change.md"), "utf8");
  assert.match(change, /Mode: all \(the whole project at HEAD/);
  assert.match(change, /lockfile and binary diffs left out of this prompt \(the files are in tree\/\): (logo\.png, package-lock\.json|package-lock\.json, logo\.png)/);
  assert.doesNotMatch(change, /xxxxxxxxxx/);
  assert.match(change, /diff --git a\/index\.html b\/index\.html/);
});
