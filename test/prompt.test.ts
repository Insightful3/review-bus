import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt, HISTORY_LIMITS } from "../src/prompt.js";
import type { Finding, ReviewRequest, Round, Snapshot } from "../src/types.js";

const req: ReviewRequest = { artifact: null, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" };
const rubric = { name: "proposal", file: "proposal.md", body: "Check it.", meta: {} };
const snap: Snapshot = { kind: "markdown", sha256: "x", markdown_file: null, warnings: [] };

function finding(n: number, i: number, status: "accepted" | "rejected" | "deferred" | null, over: Partial<Finding> = {}): Finding {
  return {
    finding_id: `r${n}.f${i}`,
    reviewer: "fake:m:e",
    round: n,
    blocking: true,
    severity: "major",
    agreement: 1,
    claim: `Claim ${n}.${i}`,
    failure_scenario: "x",
    evidence: "x",
    location: { path: "a.md", line_start: null, line_end: null, section: "Price", quote: null },
    likelihood: "likely",
    impact: "high",
    suggested_fix: null,
    assumption_challenge: false,
    confidence: 0.9,
    response: status ? { status, note: `Reason ${n}.${i}`, at: "2026-11-27T00:00:00Z" } : null,
    ...over,
  } as Finding;
}

const round = (n: number, findings: Finding[]): Round => ({ n, started_at: "", finished_at: "", snapshot: snap, reviewers: [], findings });

const prompt = (previous: Round, earlier: Round[]) => buildPrompt(req, rubric, snap, "Doc", "doc.md", previous, [], earlier);

test("earlier rounds: rejected and deferred findings are carried, accepted and unanswered ones are not", () => {
  const r1 = round(1, [finding(1, 1, "rejected"), finding(1, 2, "deferred"), finding(1, 3, "accepted"), finding(1, 4, null)]);
  const r2 = round(2, [finding(2, 1, "rejected")]);
  const r3 = round(3, [finding(3, 1, "accepted")]);
  const p = prompt(r3, [r1, r2]);
  assert.match(p, /## Previous round \(round 3\)[\s\S]*- r3\.f1/);
  const older = p.slice(p.indexOf("### Decided in earlier rounds"));
  // Newest first: round 2 before round 1.
  assert.ok(older.indexOf("r2.f1") < older.indexOf("r1.f1"));
  assert.match(older, /- r1\.f1 \(a\.md, Price\) \[high\/likely\] Claim 1\.1\n  Author's answer: rejected: Reason 1\.1/);
  assert.match(older, /- r1\.f2 [^\n]*\n  Author's answer: deferred: Reason 1\.2/);
  assert.doesNotMatch(older, /r1\.f3|r1\.f4/);
  assert.doesNotMatch(older, /left out/);
  // The place is the file and line, then the section, whichever are known.
  const at = (section: string | null) => prompt(round(2, []), [round(1, [finding(1, 1, "rejected", { location: { path: "src/a.ts", line_start: 42, line_end: null, section, quote: null } })])]);
  assert.match(at(null), /- r1\.f1 \(src\/a\.ts:42\) \[high\/likely\]/);
  assert.match(at("applyChanges"), /- r1\.f1 \(src\/a\.ts:42, applyChanges\) \[high\/likely\]/);
  // Rejected findings stay decided; deferred ones may come back only as an advisory reminder.
  assert.match(p, /Do not raise a rejected finding again unless the author's reason does not hold/);
  assert.match(p, /A deferred finding is known and planned for later: raise it again only as a reminder, with failure_scenario set to null/);
});

test("earlier rounds: nothing decided adds no section; an empty previous round still shows older decisions", () => {
  assert.doesNotMatch(prompt(round(2, [finding(2, 1, "accepted")]), [round(1, [finding(1, 1, "accepted")])]), /Decided in earlier rounds/);
  const p = prompt(round(2, []), [round(1, [finding(1, 1, "rejected")])]);
  assert.match(p, /## Previous round \(round 2\)\n[\s\S]*\(no findings\)[\s\S]*- r1\.f1/);
  assert.doesNotMatch(prompt(round(1, []), []), /Previous round/);
});

test("earlier rounds: long fields are cut, and the list stays within its item and character budget", () => {
  const long = (c: string) => c.repeat(5000);
  const big = finding(1, 1, "rejected", {
    claim: long("c"),
    location: { path: null, line_start: null, line_end: null, section: long("s"), quote: null },
    response: { status: "rejected", note: long("r"), at: "" },
  });
  const one = prompt(round(2, []), [round(1, [big])]);
  assert.match(one, new RegExp(`\\(s{${HISTORY_LIMITS.place - 3}}\\.\\.\\.\\) \\[high/likely\\] c{${HISTORY_LIMITS.claim - 3}}\\.\\.\\.\\n  Author's answer: rejected: r{${HISTORY_LIMITS.reason - 3}}\\.\\.\\.\\n`));

  // 100 decisions over 3 rounds: at most 40 items are shown, newest first, and the rest are counted.
  const many = [1, 2, 3].map((n) => round(n, Array.from({ length: 34 }, (_, i) => finding(n, i + 1, "rejected"))));
  const p = prompt(round(4, []), many);
  const shown = p.match(/^- r\d+\.f\d+ /gm) ?? [];
  assert.equal(shown.length, HISTORY_LIMITS.items);
  assert.match(p, /- r3\.f1 /);
  assert.doesNotMatch(p, /- r1\.f\d+ /); // the oldest round is the one left out
  assert.match(p, /62 older decision\(s\) are left out/);

  // Long items hit the character budget before the item cap.
  const heavy = [round(1, Array.from({ length: 40 }, (_, i) => finding(1, i + 1, "rejected", { claim: long("c"), response: { status: "rejected", note: long("r"), at: "" } })))];
  const h = prompt(round(2, []), heavy);
  const section = h.slice(h.indexOf("### Decided in earlier rounds"));
  const items = section.match(/^- r1\.f\d+ /gm) ?? [];
  assert.ok(items.length > 0 && items.length < 40, `${items.length} items`);
  // The whole section counts, heading and note included (it runs to the document section after it).
  const whole = h.slice(h.indexOf("\n### Decided in earlier rounds"), h.indexOf("\n## ", h.indexOf("### Decided in earlier rounds")));
  assert.ok(whole.length <= HISTORY_LIMITS.chars, `${whole.length} characters`);
  assert.ok(whole.length > HISTORY_LIMITS.chars - 700, `${whole.length} characters: the budget should be nearly used`);
  assert.match(section, new RegExp(`${40 - items.length} older decision\\(s\\) are left out`));
});
