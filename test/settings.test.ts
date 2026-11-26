import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { checkEffort, resolveModelEffort } from "../src/settings.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "test/fixtures/proposal-bluefin.md");
const adapter = { model: "cfg-model", effort: "low" as const };

test("precedence: call, rubric, stage, config, CLI default", () => {
  const rubric = { effort: "high", models: { codex: "rubric-model" } };
  assert.deepEqual(resolveModelEffort({ name: "codex", model: "m", effort: "max" }, adapter, rubric, "draft"), {
    model: "m", model_source: "call", effort: "max", effort_source: "call",
  });
  assert.deepEqual(resolveModelEffort({ name: "codex" }, adapter, rubric, "draft"), {
    model: "rubric-model", model_source: "rubric", effort: "high", effort_source: "rubric",
  });
  // Rubric models are per adapter name: another reviewer falls through to its config.
  assert.equal(resolveModelEffort({ name: "claude" }, adapter, rubric, "draft").model_source, "config");
  assert.deepEqual(resolveModelEffort({ name: "codex" }, adapter, {}, "release"), {
    model: "cfg-model", model_source: "config", effort: "high", effort_source: "stage",
  });
  assert.equal(resolveModelEffort({ name: "codex" }, adapter, {}, "draft").effort, "medium");
  assert.equal(resolveModelEffort({ name: "codex" }, adapter, {}, "pre-merge").effort_source, "config");
  assert.deepEqual(resolveModelEffort({ name: "codex" }, { model: null, effort: null }, {}, "pre-merge"), {
    model: null, model_source: "cli_default", effort: null, effort_source: "cli_default",
  });
  // An invalid effort in front matter is ignored rather than passed to the CLI.
  assert.equal(resolveModelEffort({ name: "codex" }, adapter, { effort: "huge" }, "pre-merge").effort, "low");
});

test("ultra is codex only", () => {
  assert.doesNotThrow(() => checkEffort("codex", "ultra", "codex"));
  assert.throws(() => checkEffort("claude", "ultra", "claude"), /ultra/);
});

test("no different-vendor default reviewer: submit fails; unknown author is noted", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "review-bus-settings-"));
  const file = path.join(tmp, "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      storage: { documents: path.join(tmp, "reviews") },
      default_reviewers: ["fake"],
      adapters: { fake: { type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs")], vendor: "anthropic" } },
    }),
  );
  process.env.REVIEW_BUS_CONFIG = file;
  const engine = new Engine(loadConfig());
  const req = { artifact: { path: FIXTURE }, pages: [], rubric: "proposal", intent: "x", assumptions: [], criteria: [], reviewers: [], stage: "pre-merge" as const };

  await assert.rejects(
    engine.submit(req, { client: "claude-code", vendor: "anthropic", vendor_source: "client" }),
    /No default reviewer from a different vendor than the author \(anthropic\)/,
  );
  const review = await engine.submit(req, { client: null, vendor: null, vendor_source: "unknown" }, 10);
  assert.deepEqual(review.notes, ["Author vendor unknown."]);
  assert.equal(review.state, "changes_requested");
});

test("client names map to vendors by default", () => {
  const cfg = loadConfig();
  assert.equal(cfg.author_vendors["claude-code"], "anthropic");
  assert.equal(cfg.author_vendors["codex-mcp-client"], "openai");
  assert.equal(cfg.author_vendors["antigravity-client"], "google"); // what agy 1.5.18 sends in initialize
});

test("an explicitly named config that does not exist is an error, not a silent fallback", () => {
  const before = process.env.REVIEW_BUS_CONFIG;
  process.env.REVIEW_BUS_CONFIG = "/nope/review-bus.json";
  try {
    assert.throws(() => loadConfig(), /REVIEW_BUS_CONFIG points to \/nope\/review-bus\.json, which does not exist/);
  } finally {
    process.env.REVIEW_BUS_CONFIG = before;
  }
});
