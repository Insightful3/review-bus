// rb, the command line for people, plus a review running in another process (not marked failed).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RB = path.join(ROOT, "dist/src/cli.js");
const FIXTURE = path.join(ROOT, "test/fixtures/proposal-bluefin.md");
const CONTRACT = path.join(ROOT, "test/fixtures/contract-northwind-bluefin.docx");
let env: NodeJS.ProcessEnv;
let configFile: string;

before(() => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "review-bus-cli-"));
  const fake = (extra: string[] = []) => ({ type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs"), ...extra] });
  configFile = path.join(tmp, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      storage: { documents: path.join(tmp, "reviews") },
      default_reviewers: ["fake"],
      adapters: { fake: fake(), slow: fake(["--sleep=20000"]) },
      allowed_reviewers: { "contract-b2b": ["fake"] },
    }),
  );
  env = { ...process.env, REVIEW_BUS_CONFIG: configFile };
});

function rb(...args: string[]) {
  const r = spawnSync(process.execPath, [RB, ...args], { env, encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const idFrom = (s: string) => s.match(/rv_[0-9a-z]{26}/)![0];

test("help and bad input", () => {
  assert.equal(rb("--help").code, 0);
  assert.match(rb("--help").out, /rb submit <file>/);
  // --help or -h after a command shows the help and runs nothing, even with other arguments missing.
  for (const args of [["submit", "--help"], ["submit", FIXTURE, "-h"], ["respond", "--help"], ["rubric-check", "-h"]]) {
    const h = rb(...args);
    assert.deepEqual([h.code, h.err], [0, ""], args.join(" "));
    assert.match(h.out, /rb submit <file>/, args.join(" "));
  }
  const noRubric = rb("submit", FIXTURE, "--intent", "x");
  assert.deepEqual([noRubric.code, noRubric.err.trim()], [1, "rb: submit needs --rubric"]);
  assert.equal(rb("bogus").code, 1);
  assert.match(rb("status", "rv_nope").err, /Invalid review id/);
});

test("submit waits for reviewers, prints the report and exits 2 on changes requested; respond closes it", () => {
  const s = rb("submit", FIXTURE, "--rubric", "proposal", "--intent", "Win the project.", "--assumption", "Fixed price");
  assert.equal(s.code, 2, s.err);
  assert.match(s.err, /round 1, reviewers: fake:default:default/);
  assert.match(s.err, /fake:default:default done/);
  assert.match(s.out, /State: \*\*changes_requested\*\*/);
  assert.doesNotMatch(s.out, /Author vendor unknown/); // a person is the author
  const id = idFrom(s.err);

  assert.match(rb("status", id).out, new RegExp(`${id}  changes_requested  round 1[\\s\\S]*2 blocking \\(2 unanswered\\)`));
  assert.match(rb("list").out, new RegExp(`${id}  changes_requested`));
  assert.equal(rb("list", "--state", "approved").out.includes(id), false);

  assert.match(rb("respond", id, "r1.f1=maybe").err, /bad answer "r1\.f1=maybe"/);
  const partial = rb("respond", id, "r1.f1=accepted:Fixed the total");
  assert.deepEqual([partial.code, partial.out.trim()], [2, `${id}  changes_requested  unanswered blocking: r1.f2`]);
  const closed = rb("respond", id, "r1.f2=rejected:Intentional: the target is agreed");
  assert.deepEqual([closed.code, closed.out.trim()], [0, `${id}  approved`]);
  assert.match(rb("show", id).out, /Response: rejected, Intentional: the target is agreed/);
});

test("reviewer overrides, related documents and sign-off from the command line", () => {
  const s = rb("submit", CONTRACT, "--rubric", "contract-b2b", "--intent", "x", "--reviewer", "fake:some-model:low", "--related", FIXTURE, "--stage", "draft");
  assert.equal(s.code, 0, s.err); // no blocking findings, awaiting sign-off
  assert.match(s.err, /reviewers: fake:some-model:low/);
  assert.match(s.out, /State: \*\*awaiting_signoff\*\*/);
  assert.match(s.out, /compared with proposal-bluefin\.md/);
  const id = idFrom(s.err);
  assert.match(rb("signoff", id).err, /signoff needs --by/);
  assert.equal(rb("signoff", id, "--by", "Test Person", "--note", "Checked").out.trim(), `${id}  approved  signed off by Test Person`);
  assert.match(rb("submit", FIXTURE, "--rubric", "proposal", "--intent", "x", "--reviewer", "fake::huge").err, /bad effort "huge"/);
});

test("a review running in another process is not marked failed; Ctrl-C in rb cancels it", async () => {
  const child = spawn(process.execPath, [RB, "submit", FIXTURE, "--rubric", "proposal", "--intent", "x", "--reviewer", "slow"], { env });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  while (!/rv_[0-9a-z]{26}/.test(err)) await new Promise((r) => setTimeout(r, 50));
  const id = idFrom(err);

  // This test process is a different server process: it must leave rb's running round alone.
  process.env.REVIEW_BUS_CONFIG = configFile;
  const other = new Engine(loadConfig());
  assert.equal(other.get(id).state, "in_review");
  assert.equal(other.get(id).rounds[0].runner?.pid, child.pid);

  child.kill("SIGINT");
  assert.equal(await exited, 130);
  assert.match(err, new RegExp(`canceled ${id}`));
  assert.match(rb("status", id).out, new RegExp(`${id}  canceled`));
});

test("once the running process is gone, the round is marked failed", async () => {
  const child = spawn(process.execPath, [RB, "submit", FIXTURE, "--rubric", "proposal", "--intent", "x", "--reviewer", "slow"], { env });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((r) => child.on("exit", r));
  while (!/rv_[0-9a-z]{26}/.test(err)) await new Promise((r) => setTimeout(r, 50));
  const id = idFrom(err);
  child.kill("SIGKILL"); // no chance to cancel: like a crash
  await exited;
  process.env.REVIEW_BUS_CONFIG = configFile;
  assert.equal(new Engine(loadConfig()).get(id).state, "failed");
});

test("a cancel from another process stops the running reviewers", async () => {
  const child = spawn(process.execPath, [RB, "submit", FIXTURE, "--rubric", "proposal", "--intent", "x", "--reviewer", "slow"], { env });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  while (!/rv_[0-9a-z]{26}/.test(err)) await new Promise((r) => setTimeout(r, 50));
  const id = idFrom(err);

  const started = Date.now();
  process.env.REVIEW_BUS_CONFIG = configFile;
  new Engine(loadConfig()).cancel(id); // this test process, not the one running the round
  const code = await exited; // rb sees the review end and exits
  assert.ok(Date.now() - started < 8000, "the slow reviewer (20 s) should have been stopped");
  assert.equal(code, 2);
  const review = new Engine(loadConfig()).get(id);
  assert.equal(review.state, "canceled");
  assert.deepEqual([review.rounds[0].reviewers[0].status, review.rounds[0].reviewers[0].error], ["failed", "canceled"]);
});

test("a review-bus.config.json in the current folder is never loaded", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "review-bus-untrusted-"));
  const marker = path.join(dir, "ran");
  writeFileSync(
    path.join(dir, "review-bus.config.json"),
    JSON.stringify({ default_reviewers: ["evil"], adapters: { evil: { type: "command", command: "/usr/bin/touch", args: [marker] } } }),
  );
  const home = mkdtempSync(path.join(os.tmpdir(), "review-bus-home-"));
  const { REVIEW_BUS_CONFIG: _unused, ...rest } = env;
  // Without a config, the built-in defaults apply; the folder's "evil" reviewer does not exist there.
  const r = spawnSync(process.execPath, [RB, "submit", FIXTURE, "--rubric", "proposal", "--intent", "x", "--reviewer", "evil"], { cwd: dir, env: { ...rest, HOME: home }, encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /evil/);
  assert.doesNotMatch(r.stderr, /touch/);
  assert.equal(existsSync(marker), false);
});

test("a reviewer that ignores SIGTERM is still stopped by a cancel", async () => {
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  cfg.adapters.stubborn = { type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs"), "--ignore-term", "--sleep=60000"] };
  writeFileSync(configFile, JSON.stringify(cfg));
  const child = spawn(process.execPath, [RB, "submit", FIXTURE, "--rubric", "proposal", "--intent", "x", "--reviewer", "stubborn"], { env });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((r) => child.on("exit", r));
  while (!/rv_[0-9a-z]{26}/.test(err)) await new Promise((r) => setTimeout(r, 50));
  const id = idFrom(err);
  process.env.REVIEW_BUS_CONFIG = configFile;
  const engine = new Engine(loadConfig());
  const pidFile = path.join(engine.store.roundDir(id, 1), "reviewer.pid");
  while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(readFileSync(pidFile, "utf8"));
  engine.cancel(id);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // The cancel is noticed, SIGTERM is sent, and SIGKILL follows 5 s later: allow for a busy machine.
  const until = Date.now() + 20_000;
  while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(), false, "the reviewer should be killed after SIGTERM is ignored");
  await exited;
});

test("reviewers stop when their runner is killed outright", async () => {
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  cfg.adapters.orphan = { type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs"), "--ignore-term", "--sleep=60000"] };
  writeFileSync(configFile, JSON.stringify(cfg));
  const child = spawn(process.execPath, [RB, "submit", FIXTURE, "--rubric", "proposal", "--intent", "x", "--reviewer", "orphan"], { env });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  while (!/rv_[0-9a-z]{26}/.test(err)) await new Promise((r) => setTimeout(r, 50));
  const id = idFrom(err);
  process.env.REVIEW_BUS_CONFIG = configFile;
  const pidFile = path.join(new Engine(loadConfig()).store.roundDir(id, 1), "reviewer.pid");
  while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  child.kill("SIGKILL"); // no cleanup code in the runner gets to run
  const until = Date.now() + 12_000;
  while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(), false, "the watchdog should stop a reviewer (even one ignoring SIGTERM) after its runner died");
});

test("rb submit - reviews a document piped in on standard input", () => {
  const r = spawnSync(process.execPath, [RB, "submit", "-", "--name", "post.md", "--rubric", "proposal", "--intent", "Win the project."], { env, encoding: "utf8", input: readFileSync(FIXTURE, "utf8"), timeout: 60000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /Artifact: post\.md \(sent as text\)/);
  assert.match(r.stdout, /State: \*\*changes_requested\*\*/);
  // Nothing piped in: refused rather than reviewing an empty document.
  const empty = spawnSync(process.execPath, [RB, "submit", "-", "--rubric", "proposal", "--intent", "x"], { env, encoding: "utf8", input: "", timeout: 60000 });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /is empty/);
});
