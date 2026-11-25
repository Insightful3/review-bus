import assert from "node:assert/strict";
import { test } from "node:test";
import { computeBlocking, type PolicyInput } from "../src/policy.js";

const f = (impact: PolicyInput["impact"], likelihood: PolicyInput["likelihood"], extra: Partial<PolicyInput> = {}): PolicyInput => ({
  impact,
  likelihood,
  failure_scenario: "something breaks",
  assumption_challenge: false,
  confidence: 0.8,
  ...extra,
});

const opts = { stage: "pre-merge" as const, max_blocking: 5 };

test("default matrix", () => {
  const cases: [PolicyInput, boolean][] = [
    [f("critical", "remote"), true],
    [f("high", "possible"), true],
    [f("high", "remote"), false],
    [f("medium", "likely"), true],
    [f("medium", "possible"), false],
    [f("low", "certain"), false],
  ];
  for (const [input, expected] of cases) {
    assert.equal(computeBlocking([input], opts)[0], expected, `${input.impact}/${input.likelihood}`);
  }
});

test("no failure scenario is advisory, assumption challenge never blocks", () => {
  assert.deepEqual(
    computeBlocking([f("critical", "certain", { failure_scenario: null }), f("critical", "certain", { assumption_challenge: true })], opts),
    [false, false],
  );
});

test("draft stage only blocks critical", () => {
  assert.deepEqual(computeBlocking([f("critical", "remote"), f("high", "certain")], { ...opts, stage: "draft" }), [true, false]);
});

test("caps blocking findings, highest risk first", () => {
  const findings = [f("medium", "likely"), f("critical", "certain"), f("high", "likely"), f("medium", "certain")];
  assert.deepEqual(computeBlocking(findings, { ...opts, max_blocking: 2 }), [false, true, true, false]);
});

test("rubric override: high blocks at any likelihood", () => {
  assert.deepEqual(computeBlocking([f("high", "remote")], { ...opts, high_blocks_always: true }), [true]);
});
