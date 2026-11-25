// Duplicate findings across reviewers: conservative rules, model grouping, validation and fallback.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { applyGroups, isDuplicate, mergeFindings, type Raised } from "../src/merge.js";
import type { ReviewerFinding } from "../src/spec/reviewer-output.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "test/fixtures/proposal-bluefin.md");

const f = (claim: string, section: string | null, quote: string | null, extra: Partial<ReviewerFinding> = {}): ReviewerFinding => ({
  claim,
  failure_scenario: "x",
  evidence: "x",
  location: { path: "artifact.md", line_start: null, line_end: null, section, quote },
  likelihood: "likely",
  impact: "high",
  suggested_fix: null,
  assumption_challenge: false,
  confidence: 0.8,
  ...extra,
});

test("rules merge only near-identical findings, never two from the same reviewer", () => {
  const price = f("The summary price does not match the price table total.", "Summary", "Total price: EUR 24,000 excluding VAT.");
  const priceAgain = f("Summary price and table total do not match.", "Summary", "Total price: EUR 24,000");
  // Real pair from two reviewers: same problem, different words and quotes. Rules leave it alone.
  const launchA = f("The launch date is unconditional even though required client inputs have no delivery deadline.", "Timeline", "- Bluefin provides help center export");
  const launchB = f("The go-live date is stated as fixed, but it depends on Bluefin delivering the help center export.", "Results", "Go-live on 15 March 2027.");
  assert.equal(isDuplicate(price, priceAgain), true);
  assert.equal(isDuplicate(launchA, launchB), false);

  const merged = mergeFindings([
    { finding: price, reviewer: "codex" },
    { finding: priceAgain, reviewer: "codex" }, // same reviewer: stays separate
    { finding: f(price.claim, "Summary", price.location.quote, { impact: "critical" }), reviewer: "claude" },
  ]);
  assert.deepEqual(merged.map((m) => m.agreement), [2, 1]);
  assert.equal(merged[0].finding.impact, "critical"); // the higher-risk version is kept
  assert.deepEqual(merged[0].also_raised_by.map((a) => a.reviewer), ["codex"]);
});

test("applyGroups validates the model's answer", () => {
  const items: Raised[] = [
    { finding: f("a", null, null), reviewer: "codex" },
    { finding: f("b", null, null), reviewer: "codex" },
    { finding: f("c", null, null, { impact: "critical" }), reviewer: "claude" },
  ];
  // f2 is missing: it stays on its own. Groups keep the reviewers' order.
  const ok = applyGroups(items, [["f3", "f1"]])!;
  assert.deepEqual(ok.map((m) => [m.finding.claim, m.agreement]), [["c", 2], ["b", 1]]);
  // Two findings from one reviewer in a group: the extra one is split off.
  assert.deepEqual(applyGroups(items, [["f1", "f2", "f3"]])!.map((m) => m.agreement), [2, 1]);
  // Unknown ids are ignored.
  assert.equal(applyGroups(items, [["f9"], ["f1"], ["f2"], ["f3"]])!.length, 3);
  // An id in two groups, or a malformed answer, is unusable.
  assert.equal(applyGroups(items, [["f1"], ["f1", "f3"]]), null);
  assert.equal(applyGroups(items, "nope"), null);
});

async function engineWith(mergeWith: Record<string, unknown> | null, mergerArgs: string[] = []) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "review-bus-merge-"));
  const file = path.join(tmp, "config.json");
  const node = process.execPath;
  writeFileSync(
    file,
    JSON.stringify({
      storage: { documents: path.join(tmp, "reviews") },
      default_reviewers: ["fake", "claude"],
      adapters: {
        fake: { type: "command", command: node, args: [path.join(ROOT, "test/fake-reviewer.mjs")] },
        claude: { type: "claude", command: path.join(ROOT, "test/fake-claude.mjs") },
        merger: { type: "command", command: node, args: [path.join(ROOT, "test/fake-merger.mjs"), ...mergerArgs] },
      },
      merge_with: mergeWith,
    }),
  );
  process.env.REVIEW_BUS_CONFIG = file;
  return new Engine(loadConfig());
}

const submit = (engine: Engine) =>
  engine.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" },
    { client: "test", vendor: null, vendor_source: "unknown" },
    20,
  );

test("model merge: the 70% finding from two reviewers becomes one with agreement 2", async () => {
  const review = await submit(await engineWith({ adapter: "merger" }));
  const round = review.rounds[0];
  assert.deepEqual([round.merge?.method, round.merge?.by], ["model", "merger:default:default"]);
  const seventy = round.findings.filter((x) => x.claim.includes("70%"));
  assert.equal(seventy.length, 1);
  assert.equal(seventy[0].agreement, 2);
  assert.equal(seventy[0].also_raised_by?.length, 1);
  assert.equal(round.findings.length, 4); // fake's 4, with claude's one merged in
  assert.deepEqual(round.findings.map((x) => x.finding_id), ["r1.f1", "r1.f2", "r1.f3", "r1.f4"]);
});

test("without merge_with, rules still merge near-identical findings (same section, overlapping quote)", async () => {
  const round = (await submit(await engineWith(null))).rounds[0];
  assert.deepEqual([round.merge?.method, round.merge?.by], ["rules", null]);
  const seventy = round.findings.filter((x) => x.claim.includes("70%"));
  assert.equal(seventy.length, 1);
  assert.equal(seventy[0].agreement, 2);
});

test("a bad or failing merge model falls back to rules and says so", async () => {
  for (const mode of ["bad", "fail"]) {
    const round = (await submit(await engineWith({ adapter: "merger" }, [`--fake-mode=${mode}`]))).rounds[0];
    assert.equal(round.merge?.method, "rules");
    assert.match(round.merge?.error ?? "", /model merge failed, used rules/);
  }
});

test("merge_with must name a configured adapter", async () => {
  await assert.rejects(engineWith({ adapter: "ghost" }), /merge_with\.adapter "ghost" is not in adapters/);
});
