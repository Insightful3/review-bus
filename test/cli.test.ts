// rb, the command line for people, plus a review running in another process (not marked failed).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
