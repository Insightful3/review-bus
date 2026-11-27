// v0.4: decisions that stay decided. Repeats marked by reviewers, found by a model check or named by
// the author; follows carries a closed review's decisions into a new one; the same-name hint.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.js";
import { decisionsOf, Engine } from "../src/engine.js";
import { mergeFindings } from "../src/merge.js";
import { computeBlocking, type PolicyInput } from "../src/policy.js";
import { ReviewerOutput, reviewerOutputJsonSchema } from "../src/spec/reviewer-output.js";
import type { AuthorInfo, Finding, Review } from "../src/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "test/fixtures/proposal-bluefin.md");
const AUTHOR: AuthorInfo = { client: "test", vendor: null, vendor_source: "unknown" };
const node = process.execPath;

/** A fresh store and config: the fake reviewer with extra args, and optionally the fake repeat-check model. */
function engineWith(reviewerArgs: string[] = [], opts: { repeats?: string[] | null; maxRounds?: number; extra?: Record<string, unknown>; adapters?: Record<string, unknown> } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "review-bus-v04-"));
  const file = path.join(tmp, "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      storage: { documents: path.join(tmp, "reviews") },
      default_reviewers: ["fake"],
      adapters: {
        fake: { type: "command", command: node, args: [path.join(ROOT, "test/fake-reviewer.mjs"), ...reviewerArgs] },
        repeats: { type: "command", command: node, args: [path.join(ROOT, "test/fake-repeats.mjs"), ...(opts.repeats ?? [])] },
        ...opts.adapters,
      },
      merge_with: opts.repeats === undefined || opts.repeats === null ? null : { adapter: "repeats" },
      ...(opts.maxRounds ? { policy: { max_rounds: opts.maxRounds } } : {}),
      ...opts.extra,
    }),
  );
  process.env.REVIEW_BUS_CONFIG = file;
  return { engine: new Engine(loadConfig()), tmp, file };
}

async function submit(e: Engine, extra: { follows?: string; path?: string; rubric?: string; reviewers?: string[] } = {}): Promise<Review> {
  const r = await e.submit(
    {
      artifact: { path: extra.path ?? FIXTURE },
      pages: [],
      rubric: extra.rubric ?? "proposal",
      intent: "x",
      assumptions: [],
      criteria: [],
      reviewers: (extra.reviewers ?? ["fake"]).map((name) => ({ name })),
      stage: "pre-merge",
      ...(extra.follows ? { follows: extra.follows } : {}),
    },
    AUTHOR,
    20,
  );
  await e.settled(r.id);
  return e.get(r.id);
}

const byClaim = (r: Review, part: string): Finding => r.rounds.at(-1)!.findings.find((f) => f.claim.includes(part))!;
const PRICE = "total price";
const RATE = "70%";

/** Round 1's blocking findings answered: price rejected, 70% deferred. Then round 2 on the same text. */
async function twoRounds(e: Engine): Promise<Review> {
  const r1 = await submit(e);
  await e.respond(r1.id, [
    { finding_id: byClaim(r1, PRICE).finding_id, status: "rejected", note: "Intentional" },
    { finding_id: byClaim(r1, RATE).finding_id, status: "deferred", note: "Later" },
  ], { resubmit: true });
  await e.settled(r1.id);
  return e.get(r1.id);
}

test("reviewer output: repeats is required in the schema (no default) and null when an answer leaves it out", () => {
  const schema = reviewerOutputJsonSchema() as { properties: { findings: { items: { required: string[]; properties: Record<string, unknown> } } } };
  assert.ok(schema.properties.findings.items.required.includes("repeats"));
  assert.doesNotMatch(JSON.stringify(schema), /"default"/);
  const parsed = ReviewerOutput.parse({
    verdict: "comment",
    summary: "x",
    findings: [{ claim: "c", failure_scenario: null, evidence: "e", location: { path: null, line_start: null, line_end: null, section: null, quote: null }, likelihood: "likely", impact: "low", suggested_fix: null, assumption_challenge: false, confidence: 0.5 }],
  });
  assert.equal(parsed.findings[0].repeats, null);
});

test("policy: a repeat blocks only if critical, or high and certain", () => {
  const f = (impact: PolicyInput["impact"], likelihood: PolicyInput["likelihood"], is_repeat: boolean): PolicyInput => ({ impact, likelihood, failure_scenario: "x", assumption_challenge: false, confidence: 0.9, is_repeat });
  const opts = { stage: "pre-merge" as const, max_blocking: 5 };
  assert.deepEqual(computeBlocking([f("critical", "remote", true), f("high", "certain", true), f("high", "likely", true), f("medium", "certain", true)], opts), [true, true, false, false]);
  assert.deepEqual(computeBlocking([f("high", "likely", false), f("medium", "certain", false)], opts), [true, true]);
  // Never more than the ordinary rule: a draft-stage repeat still needs critical.
  assert.deepEqual(computeBlocking([f("high", "certain", true)], { ...opts, stage: "draft" }), [false]);
});

test("merge: a merged finding is a repeat only if every reviewer that raised it named the same earlier decision", () => {
  const raw = (repeats: string | null) => ({
    claim: "The 70% resolution rate is promised as a result.",
    failure_scenario: "x",
    evidence: "x",
    location: { path: "artifact.md", line_start: null, line_end: null, section: "Results", quote: "The assistant will resolve 70%" },
    likelihood: "likely" as const,
    impact: "high" as const,
    suggested_fix: null,
    assumption_challenge: false,
    confidence: 0.9,
    repeats,
  });
  const merged = (a: string | null, b: string | null) => mergeFindings([{ finding: raw(a), reviewer: "one" }, { finding: raw(b), reviewer: "two" }])[0].finding.repeats;
  assert.equal(merged("r1.f2", "r1.f2"), "r1.f2");
  assert.equal(merged("r1.f2", null), null);
  assert.equal(merged("r1.f2", "r1.f1"), null);
});

test("a reviewer marks repeats: a repeated deferred high finding turns advisory, a repeated critical one still blocks", async () => {
  const { engine: e } = engineWith(["--auto-repeat"]);
  const r = await twoRounds(e);
  const price = byClaim(r, PRICE);
  const rate = byClaim(r, RATE);
  assert.deepEqual([price.repeat?.of, price.repeat?.by, price.repeat?.status, price.blocking], ["r1.f1", "reviewer", "rejected", true]);
  assert.deepEqual([rate.repeat?.of, rate.repeat?.status, rate.repeat?.reason, rate.blocking], ["r1.f2", "deferred", "Later", false]);
  const report = readFileSync(path.join(e.store.dir(r.id), "report.md"), "utf8");
  assert.match(report, /Repeats r1\.f2 \(deferred: Later\), marked by the reviewer/);
  assert.match(report, /Repeats of earlier decisions: 2 marked by reviewers/);
});

test("a repeat of an accepted finding keeps the ordinary rule; an id the round was not shown adds a note", async () => {
  // Accepted in round 1 but back in round 2: the fix did not hold, so it must block as usual.
  const { engine: e } = engineWith(["--auto-repeat"]);
  const r1 = await submit(e);
  await e.respond(r1.id, [
    { finding_id: byClaim(r1, PRICE).finding_id, status: "rejected", note: "Intentional" },
    { finding_id: byClaim(r1, RATE).finding_id, status: "accepted" },
  ], { resubmit: true });
  await e.settled(r1.id);
  const r = e.get(r1.id);
  assert.equal(byClaim(r, RATE).repeat ?? null, null);
  assert.equal(byClaim(r, RATE).blocking, true);
  assert.ok(!r.notes.some((n) => n.includes("named as repeated")), r.notes.join("\n")); // it was shown, just not settled

  const { engine: e2 } = engineWith(["--repeat-ref=r9.f9"]);
  const r2 = await twoRounds(e2);
  assert.ok(r2.rounds[1].findings.every((f) => !f.repeat));
  assert.equal(byClaim(r2, RATE).blocking, true);
  assert.ok(r2.notes.some((n) => /Round 2: r2\.f\d+ \(r9\.f9\).* named as repeated an earlier finding the reviewers were not shown/.test(n)), r2.notes.join("\n"));
});

test("the repeat check finds unmarked repeats with the merge model; a failing check leaves the ordinary rule with a note", async () => {
  const { engine: e } = engineWith([], { repeats: [] });
  const r = await twoRounds(e);
  assert.deepEqual([byClaim(r, RATE).repeat?.by, byClaim(r, RATE).repeat?.of, byClaim(r, RATE).blocking], ["model", "r1.f2", false]);
  assert.deepEqual([byClaim(r, PRICE).repeat?.by, byClaim(r, PRICE).blocking], ["model", true]); // critical: still blocks
  assert.deepEqual(r.rounds[1].repeat_check, { by: "repeats:default:default", found: 2, error: null });
  // Round 1 has nothing to compare with: no call.
  assert.equal(r.rounds[0].repeat_check, undefined);

  for (const mode of ["fail", "junk"]) {
    const { engine: f } = engineWith([], { repeats: [`--fake-mode=${mode}`] });
    const rf = await twoRounds(f);
    assert.equal(byClaim(rf, RATE).blocking, true, mode);
    assert.ok(rf.rounds[1].findings.every((x) => !x.repeat), mode);
    if (mode === "fail") assert.ok(rf.notes.some((n) => /Round 2: the repeat check did not run \(the call failed/.test(n)), rf.notes.join("\n"));
    else assert.equal(rf.rounds[1].repeat_check?.found, 0);
  }
  // Without merge_with there is no check, and no note on every round either.
  const { engine: n } = engineWith();
  const rn = await twoRounds(n);
  assert.equal(byClaim(rn, RATE).blocking, true);
  assert.match(rn.rounds[1].repeat_check?.error ?? "", /no merge_with model/);
});

test("the author answers repeat: stored as rejected with the earlier reason; a wrong id saves nothing", async () => {
  const { engine: e } = engineWith();
  const r = await twoRounds(e);
  const rate = byClaim(r, RATE);
  const price = byClaim(r, PRICE);
  assert.equal(rate.blocking, true); // nobody marked it
  // An id not shown as rejected, deferred or settled: refused, and the other answer is not saved either.
  await assert.rejects(
    e.respond(r.id, [{ finding_id: price.finding_id, status: "accepted" }, { finding_id: rate.finding_id, status: "repeat", repeat_of: "r1.f9" }], { resubmit: false }),
    /r1\.f9 is not one of the rejected, deferred or settled findings shown to round 2's reviewers\. Nothing was saved/,
  );
  await assert.rejects(e.respond(r.id, [{ finding_id: rate.finding_id, status: "repeat" }], { resubmit: false }), /needs repeat_of/);
  assert.ok(e.get(r.id).rounds[1].findings.every((f) => f.response === null));
  await e.respond(r.id, [{ finding_id: rate.finding_id, status: "repeat", repeat_of: "r1.f2" }, { finding_id: price.finding_id, status: "rejected", note: "Still intentional" }], { resubmit: false });
  const done = e.get(r.id);
  assert.equal(done.state, "approved");
  assert.deepEqual(byClaim(done, RATE).response && { ...byClaim(done, RATE).response, at: "" }, { status: "rejected", note: "Repeat of r1.f2: Later", at: "", repeat_of: "r1.f2" });
  assert.match(readFileSync(path.join(e.store.dir(r.id), "report.md"), "utf8"), /1 answered as repeat by the author/);
});

test("follows: a closed review's decisions reach the next review's reviewers; refused for open, unknown or other-kind reviews", async () => {
  const { engine: e, tmp } = engineWith(["--auto-repeat"]);
  const a1 = await submit(e);
  // An open review cannot be followed, and nothing is saved for the refused submit.
  const count = () => readdirSync(path.join(tmp, "reviews")).length;
  const before = count();
  await assert.rejects(submit(e, { follows: a1.id }), new RegExp(`follows: review ${a1.id} is changes_requested; only a closed review`));
  await assert.rejects(submit(e, { follows: "rv_00000000000000000000000000" }), /follows: review rv_0+ was not found/);
  await assert.rejects(submit(e, { follows: "../etc" }), /follows: "\.\.\/etc" is not a review id/);
  assert.equal(count(), before);
  // No hint while the earlier review is still open.
  const open = await submit(e);
  assert.ok(!open.notes.some((n) => n.includes("same name")));

  // Close A: price rejected, 70% deferred, without a new round.
  await e.respond(a1.id, [
    { finding_id: byClaim(a1, PRICE).finding_id, status: "rejected", note: "Intentional" },
    { finding_id: byClaim(a1, RATE).finding_id, status: "deferred", note: "Later" },
  ], { resubmit: false });
  assert.equal(e.get(a1.id).state, "approved");

  // A new review of the same file without follows gets a hint, not a link.
  const hinted = await submit(e);
  assert.ok(hinted.notes.some((n) => n.startsWith(`${a1.id} reviewed a file of the same name (proposal-bluefin.md)`) && n.includes(`pass follows: "${a1.id}"`)), hinted.notes.join("\n"));
  assert.equal(hinted.request.inherited, undefined);

  const b = await submit(e, { follows: a1.id });
  assert.deepEqual(b.request.inherited?.map((d) => [d.ref, d.status]), [[`${a1.id}/r1.f1`, "rejected"], [`${a1.id}/r1.f2`, "deferred"]]);
  assert.ok(b.notes.includes(`Follows ${a1.id}: 2 earlier decision(s) passed to the reviewers.`));
  const prompt = readFileSync(path.join(e.store.dir(b.id), "r1/prompt.md"), "utf8");
  assert.match(prompt, new RegExp(`## Decided earlier[\\s\\S]*- ${a1.id}/r1\\.f2 \\(artifact\\.md, Results\\) \\[high/likely\\] [^\\n]*\\n  Author's answer: deferred: Later`));
  // Round 1 of B: the 70% point repeats A's deferred decision and is advisory; price is critical and blocks.
  assert.deepEqual([byClaim(b, RATE).repeat?.of, byClaim(b, RATE).blocking], [`${a1.id}/r1.f2`, false]);
  assert.deepEqual([byClaim(b, PRICE).repeat?.of, byClaim(b, PRICE).blocking], [`${a1.id}/r1.f1`, true]);
  assert.match(readFileSync(path.join(e.store.dir(b.id), "report.md"), "utf8"), new RegExp(`Follows ${a1.id}: 2 earlier decision\\(s\\) carried`));

  // C follows B: B's repeats are carried as A's originals, once, with B's own other decisions.
  await e.respond(b.id, [{ finding_id: byClaim(b, PRICE).finding_id, status: "repeat", repeat_of: `${a1.id}/r1.f1` }], { resubmit: false });
  const c = await submit(e, { follows: b.id });
  const refs = c.request.inherited!.map((d) => d.ref);
  assert.deepEqual(refs.filter((x) => x.endsWith("/r1.f1")), [`${a1.id}/r1.f1`]);
  assert.ok(!refs.some((x) => x.startsWith(`${b.id}/`) && (x.endsWith(byClaim(b, PRICE).finding_id) || x.endsWith(byClaim(b, RATE).finding_id))));

  // A different kind of work is refused.
  e.store.update(a1.id, (r) => void (r.request.artifact = { git: { repo: tmp, mode: "uncommitted" } }));
  await assert.rejects(submit(e, { follows: a1.id }), /reviewed a git change, not a document/);
});

test("follows after a sign-off: blocking findings left unanswered are carried as settled by that person", async () => {
  const { engine: e } = engineWith([], { maxRounds: 1 });
  const s = await submit(e);
  assert.equal(s.state, "escalated");
  e.signoff(s.id, "Test Person", "Price confirmed by phone.");
  const next = await submit(e, { follows: s.id });
  const settled = next.request.inherited!.filter((d) => d.status === "signed_off");
  assert.deepEqual(settled.map((d) => d.ref).sort(), [`${s.id}/${byClaim(s, PRICE).finding_id}`, `${s.id}/${byClaim(s, RATE).finding_id}`].sort());
  assert.ok(settled.every((d) => d.reason === "Test Person: Price confirmed by phone."));
  // Advisory findings nobody answered are not decisions.
  assert.equal(next.request.inherited!.length, 2);
  assert.match(readFileSync(path.join(e.store.dir(next.id), "r1/prompt.md"), "utf8"), /Settled by a person at sign-off: Test Person: Price confirmed by phone\./);
});

test("decisionsOf: accepted findings are carried to check they did not come back; at most 40 items are copied", () => {
  const f = (i: number, status: "accepted" | "rejected" | null): Finding =>
    ({
      finding_id: `r1.f${i}`,
      claim: `Claim ${i}`,
      impact: "high",
      likelihood: "likely",
      location: { path: "a.md", line_start: null, line_end: null, section: null, quote: null },
      blocking: true,
      response: status ? { status, note: `n${i}`, at: "" } : null,
    }) as unknown as Finding;
  const review = (findings: Finding[], inherited: Review["request"]["inherited"] = [], left = 0) =>
    ({ id: "rv_a", rounds: [{ n: 1, findings }], request: { rubric: "proposal", inherited, inherited_left_out: left }, rubric_meta: {}, signoff: undefined }) as unknown as Review;
  const out = decisionsOf(review([f(1, "accepted"), f(2, null)]));
  assert.deepEqual(out.items.map((d) => [d.ref, d.status]), [["rv_a/r1.f1", "accepted"]]);
  const many = decisionsOf(review(Array.from({ length: 50 }, (_, i) => f(i + 1, "rejected")), [{ ref: "rv_old/r1.f1", claim: "x", impact: "high", likelihood: "likely", place: null, status: "rejected", reason: "" }], 7));
  // An acceptance that names a finding answered as a repeat links on to that finding's original.
  const viaRepeat = decisionsOf(review([
    { ...f(1, "rejected"), finding_id: "r1.f1" } as Finding,
    { ...f(2, "rejected"), finding_id: "r2.f1", response: { status: "rejected", note: "", at: "", repeat_of: "r1.f1" } } as unknown as Finding,
    { ...f(3, "accepted"), finding_id: "r3.f1", response: { status: "accepted", note: "", at: "", supersedes: "r2.f1" } } as unknown as Finding,
  ]));
  assert.equal(viaRepeat.items.find((d) => d.ref === "rv_a/r3.f1")?.supersedes, "rv_a/r1.f1");
  assert.ok(!viaRepeat.items.some((d) => d.ref === "rv_a/r2.f1"));
  assert.equal(many.items.length, 40);
  assert.equal(many.left_out, 11 + 7);
  // The rubrics of the whole chain stay, also for decisions cut by the cap.
  const chained = decisionsOf({ ...review([f(1, "rejected")]), request: { rubric: "proposal", inherited: [], inherited_left_out: 3, inherited_rubrics: [{ rubric: "contract-b2b", confidential: true }] } } as unknown as Review);
  assert.deepEqual(chained.rubrics, [{ rubric: "proposal", confidential: false }, { rubric: "contract-b2b", confidential: true }]);
});

const answer = (e: Engine, r: Review, items: [string, "accepted" | "rejected" | "deferred", string][], resubmit: boolean) =>
  e.respond(r.id, items.map(([part, status, note]) => ({ finding_id: byClaim(r, part).finding_id, status, note })), { resubmit });

test("follows keeps a rubric's approvals: reviewers and the repeat-check model must be approved for the carried decisions", async () => {
  const fake2 = { type: "command", command: node, args: [path.join(ROOT, "test/fake-reviewer.mjs")] };
  const plain = { type: "command", command: node, args: [path.join(ROOT, "test/fake-reviewer.mjs")] };
  const { engine: e, file } = engineWith([], { repeats: [], adapters: { fake2, plain }, extra: { allowed_reviewers: { proposal: ["fake", "plain"] } } });
  const a = await submit(e);
  await answer(e, a, [[PRICE, "rejected", "Confidential price agreed"], [RATE, "deferred", "Later"]], false);
  // A reviewer not approved for the earlier review's rubric must not see its decisions, whatever the new rubric.
  await assert.rejects(submit(e, { follows: a.id, rubric: "plan", reviewers: ["fake2"] }), /follows: fake2 is not approved for proposal, whose decisions would be carried\. Nothing was saved/);
  // An approved reviewer may follow; the repeat-check model is not approved for proposal, so it does not run.
  const b = await submit(e, { follows: a.id, rubric: "plan" });
  assert.equal(b.request.inherited?.length, 2);
  assert.ok(b.request.inherited!.every((d) => d.rubric === "proposal"));
  assert.match(b.rounds[0].repeat_check?.error ?? "", /repeats is not approved for proposal/);
  assert.ok(b.notes.some((n) => /the repeat check did not run \(repeats is not approved for proposal/.test(n)), b.notes.join("\n"));

  // Two reviewers: the merge model is not approved for proposal either, so the word-based rules merge.
  const c = await submit(e, { follows: a.id, rubric: "plan", reviewers: ["fake", "plain"] });
  assert.deepEqual([c.rounds[0].merge?.method, c.rounds[0].merge?.error], ["rules", "repeats is not approved for proposal, whose decisions would be carried"]);

  // Approval withdrawn after submit: the next round is refused before anything is sent.
  const open = await submit(e, { follows: a.id, rubric: "plan" });
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...cfg, allowed_reviewers: { proposal: ["plain"] } }));
  const blockers = open.rounds[0].findings.filter((f) => f.blocking).map((f) => ({ finding_id: f.finding_id, status: "accepted" as const }));
  await assert.rejects(e.respond(open.id, blockers, { resubmit: true }), /fake is not approved for proposal, whose decisions would be carried\. Nothing was sent/);
  writeFileSync(file, JSON.stringify(cfg));
});

test("a rubric that was confidential when the earlier review ran stays so for follows, even if it is not now", async () => {
  const { engine: e } = engineWith();
  const a = await submit(e);
  await answer(e, a, [[PRICE, "rejected", "Confidential price"], [RATE, "deferred", "Later"]], false);
  e.store.update(a.id, (r) => void (r.rubric_meta.confidential = true)); // saved with the review, as for a confidential rubric
  await assert.rejects(submit(e, { follows: a.id }), /follows: decisions from rubric proposal cannot be checked \(Rubric "proposal" is confidential/);
});

test("reviewers that disagree on a repeat keep the ordinary rule; the model does not decide for them", async () => {
  const plain = { type: "command", command: node, args: [path.join(ROOT, "test/fake-reviewer.mjs")] };
  const { engine: e } = engineWith(["--auto-repeat"], { repeats: [], adapters: { plain } });
  const r1 = await submit(e, { reviewers: ["fake", "plain"] });
  await answer(e, r1, [[PRICE, "rejected", "Intentional"], [RATE, "deferred", "Later"]], true);
  await e.settled(r1.id);
  const r = e.get(r1.id);
  const rate = byClaim(r, RATE);
  assert.equal(rate.agreement, 2);
  assert.deepEqual([rate.repeats, rate.repeat ?? null, rate.blocking], [null, null, true]);
  assert.equal(r.rounds[1].repeat_check, undefined); // nothing unmarked to check
});

test("a newer acceptance supersedes an older rejection: a recurrence after it blocks, and follows carries the acceptance", async () => {
  const { engine: e } = engineWith([], { repeats: [] });
  const r1 = await submit(e);
  await answer(e, r1, [[PRICE, "rejected", "Intentional"], [RATE, "rejected", "Not a promise"]], true);
  await e.settled(r1.id);
  const r2 = e.get(r1.id);
  assert.deepEqual([byClaim(r2, RATE).repeat?.of, byClaim(r2, RATE).blocking], ["r1.f2", false]); // the model matched the rejection
  // The author now agrees and accepts it; the next version still has the problem.
  await answer(e, r2, [[PRICE, "rejected", "Intentional"], [RATE, "accepted", "Will reword"]], true);
  await e.settled(r1.id);
  const r3 = e.get(r1.id);
  assert.deepEqual([byClaim(r3, RATE).repeat ?? null, byClaim(r3, RATE).blocking], [null, true]); // newest decision: accepted
  assert.equal(byClaim(r3, PRICE).repeat?.of, byClaim(r2, PRICE).finding_id); // the newest rejection of the price point
  const report = readFileSync(path.join(e.store.dir(r1.id), "report.md"), "utf8");
  assert.match(report, /Decided earlier: 2 decision\(s\) shown to round 3's reviewers/);
  // Following this review carries round 2's acceptance, although the model had marked that finding as a repeat.
  assert.equal(r3.state, "escalated");
  const carried = decisionsOf(r3).items;
  assert.ok(carried.some((d) => d.ref === `${r1.id}/${byClaim(r2, RATE).finding_id}` && d.status === "accepted"), JSON.stringify(carried));
});

test("a previous-round finding answered as a repeat stands for its original when a reviewer cites it", async () => {
  const { engine: e } = engineWith(["--auto-repeat"]);
  const r1 = await submit(e);
  await answer(e, r1, [[PRICE, "rejected", "Intentional"], [RATE, "deferred", "Later"]], true);
  await e.settled(r1.id);
  const r2 = e.get(r1.id);
  // Round 2: answer the 70% point as a repeat of r1.f2 (the reviewer had marked it too).
  await e.respond(r2.id, [
    { finding_id: byClaim(r2, PRICE).finding_id, status: "rejected", note: "Intentional" },
    { finding_id: byClaim(r2, RATE).finding_id, status: "repeat", repeat_of: "r1.f2" },
  ], { resubmit: true });
  await e.settled(r1.id);
  const r3 = e.get(r1.id);
  // The round 3 reviewer cites the round 2 id it was shown first; it resolves to r1.f2.
  assert.deepEqual([byClaim(r3, RATE).repeats, byClaim(r3, RATE).repeat?.of, byClaim(r3, RATE).blocking], [byClaim(r2, RATE).finding_id, "r1.f2", false]);
});

test("review_submit returns its notes (the same-name hint) while the reviewers are still working", async () => {
  const slow = { type: "command", command: node, args: [path.join(ROOT, "test/fake-reviewer.mjs"), "--sleep=3000"] };
  const { engine: e, file } = engineWith([], { adapters: { slow } });
  const a = await submit(e);
  await answer(e, a, [[PRICE, "rejected", "Intentional"], [RATE, "deferred", "Later"]], false);
  const client = new Client({ name: "test-author", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: node, args: [path.join(ROOT, "dist/src/server.js")], env: { ...(process.env as Record<string, string>), REVIEW_BUS_CONFIG: file }, stderr: "inherit" }));
  try {
    const res = (await client.callTool({ name: "review_submit", arguments: { artifact: FIXTURE, rubric: "proposal", intent: "x", reviewers: ["slow"] } })) as { content: { text: string }[] };
    const json = JSON.parse(res.content[0].text);
    assert.equal(json.state, "in_review");
    assert.ok(json.notes?.some((n: string) => n.startsWith(`${a.id} reviewed a file of the same name`)), res.content[0].text);
    await client.callTool({ name: "review_cancel", arguments: { review_id: json.review_id } });
  } finally {
    await client.close();
  }
});

test("carried approvals are checked again where the work leaves: at dispatch and at a pull reviewer's claim", async () => {
  const { engine: e, file } = engineWith([], { adapters: { person: { type: "pull" } }, extra: { allowed_reviewers: { proposal: ["fake", "person"] } } });
  const a = await submit(e);
  await answer(e, a, [[PRICE, "rejected", "Confidential price"], [RATE, "deferred", "Later"]], false);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  // Revoked between the submit's check and the dispatch (simulated: the submit-time check passes once).
  writeFileSync(file, JSON.stringify({ ...cfg, allowed_reviewers: { proposal: ["person"] } }));
  const real = (e as unknown as { unapprovedFor: (...x: unknown[]) => string | null }).unapprovedFor.bind(e);
  let first = true;
  (e as unknown as { unapprovedFor: unknown }).unapprovedFor = (...x: unknown[]) => (first ? ((first = false), null) : real(...x));
  const b = await submit(e, { follows: a.id, rubric: "plan" });
  const run = b.rounds[0].reviewers[0];
  assert.deepEqual([b.state, run.status], ["failed", "failed"]);
  assert.match(run.error ?? "", /fake is not approved for proposal, whose decisions would be carried; nothing was sent/);
  assert.ok(!readdirSync(e.store.roundDir(b.id, 1)).includes("fake.json"));
  (e as unknown as { unapprovedFor: unknown }).unapprovedFor = real;

  // A pull reviewer approved at submit, then removed from the source rubric's list: its claim is refused.
  writeFileSync(file, JSON.stringify(cfg));
  const p = await e.submit(
    { artifact: { path: FIXTURE }, pages: [], rubric: "plan", intent: "x", assumptions: [], criteria: [], reviewers: [{ name: "person" }], stage: "pre-merge", follows: a.id },
    AUTHOR,
  );
  writeFileSync(file, JSON.stringify({ ...cfg, allowed_reviewers: { proposal: ["fake"] } }));
  assert.throws(() => e.claim(p.id, "person", { by: "Test Person", client: null }), /person is not approved for proposal, whose decisions would be carried\. Nothing was sent/);
  writeFileSync(file, JSON.stringify(cfg));
});

test("confidentiality that applied when decisions were carried stays with them for later follows", async () => {
  const fake2 = { type: "command", command: node, args: [path.join(ROOT, "test/fake-reviewer.mjs")] };
  const rubrics = mkdtempSync(path.join(os.tmpdir(), "review-bus-v04-rubrics-"));
  const original = readFileSync(path.join(ROOT, "rubrics/proposal.md"), "utf8");
  const confidential = original.replace(/^---\n/, "---\nconfidential: true\n");
  writeFileSync(path.join(rubrics, "proposal.md"), original);
  const { engine: e, file } = engineWith([], { adapters: { fake2 }, extra: { rubric_paths: [rubrics] } });
  const a = await submit(e);
  await answer(e, a, [[PRICE, "rejected", "Confidential price"], [RATE, "deferred", "Later"]], false);
  // The rubric is made confidential, with fake approved; B follows A under it.
  writeFileSync(path.join(rubrics, "proposal.md"), confidential);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...cfg, allowed_reviewers: { proposal: ["fake"] } }));
  const b = await submit(e, { follows: a.id, rubric: "plan" });
  assert.deepEqual(b.request.inherited_rubrics, [{ rubric: "proposal", confidential: true }]);
  await answer(e, b, [[PRICE, "rejected", "Still confidential"], [RATE, "deferred", "Later"]].filter(([p]) => byClaim(b, p)?.blocking) as never, false);
  // The flag and the approval list go away: following B still needs approval for proposal.
  writeFileSync(path.join(rubrics, "proposal.md"), original);
  writeFileSync(file, JSON.stringify(cfg));
  await assert.rejects(submit(e, { follows: b.id, rubric: "plan", reviewers: ["fake2"] }), /decisions from rubric proposal cannot be checked \(Rubric "proposal" is confidential/);
});

test("an answer can name the earlier finding on the same point: an accepted recurrence then stops the old rejection from softening it", async () => {
  const { engine: e, file } = engineWith();
  const r1 = await submit(e);
  await answer(e, r1, [[PRICE, "rejected", "Intentional"], [RATE, "rejected", "Not a promise"]], true);
  await e.settled(r1.id);
  const r2 = e.get(r1.id);
  // A wrong id is refused before anything is saved.
  await assert.rejects(
    e.respond(r2.id, [{ finding_id: byClaim(r2, RATE).finding_id, status: "accepted", repeat_of: "r1.f9" }], { resubmit: false }),
    /repeat_of r1\.f9 is not an earlier finding of this review or a decision it carries\. Nothing was saved/,
  );
  // Nobody marked round 2's 70% point; the author accepts it and names round 1's rejection. The text
  // still has the problem, and the round 3 reviewer cites round 1's rejection.
  const old = byClaim(r1, RATE).finding_id;
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  cfg.adapters.fake.args.push(`--repeat-ref=${old}`);
  writeFileSync(file, JSON.stringify(cfg));
  await e.respond(r2.id, [
    { finding_id: byClaim(r2, PRICE).finding_id, status: "rejected", note: "Intentional" },
    { finding_id: byClaim(r2, RATE).finding_id, status: "accepted", repeat_of: old },
  ], { resubmit: true });
  await e.settled(r1.id);
  const r3 = e.get(r1.id);
  assert.equal(byClaim(r3, RATE).repeats, old);
  assert.deepEqual([byClaim(r3, RATE).repeat ?? null, byClaim(r3, RATE).blocking], [null, true]);
  assert.equal(r3.rounds[1].findings.find((f) => f.claim.includes(RATE))?.response?.supersedes, old);
});

test("internal model calls keep their files apart from the reviewers'", async () => {
  const { engine: e } = engineWith([], { repeats: [] });
  const r = await twoRounds(e);
  const dir = e.store.roundDir(r.id, 2);
  assert.ok(readdirSync(path.join(dir, "internal")).some((f) => f.startsWith("repeats.")));
  assert.ok(!readdirSync(dir).some((f) => f.startsWith("repeats.")));
});
