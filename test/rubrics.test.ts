// Every rubric this repo ships loads, has the four sections and valid front matter.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRubric } from "../src/rubrics.js";
import { Effort } from "../src/settings.js";

const DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "rubrics");
const names = readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));

test("ships the rubrics the spec lists", () => {
  for (const n of ["code", "contract-b2b", "proposal", "webpage", "client-email", "linkedin-post", "sop", "plan"]) assert.ok(names.includes(n), n);
});

for (const name of names) {
  test(`rubric ${name}`, () => {
    const r = loadRubric(name, [DIR]);
    for (const h of ["## Purpose", "## What to check", "## Out of scope", "## Impact anchors"]) assert.ok(r.body.includes(h), `${name} lacks ${h}`);
    for (const level of ["critical:", "high:", "medium:", "low:"]) assert.ok(r.body.includes(level), `${name} lacks ${level}`);
    assert.ok(!r.body.includes("—"), `${name} has an em dash`);
    if (r.meta.effort !== undefined) assert.ok(Effort.safeParse(r.meta.effort).success, `${name} has a bad effort`);
    for (const k of ["require_signoff", "high_blocks_always", "confidential"]) {
      if (r.meta[k] !== undefined) assert.equal(typeof r.meta[k], "boolean", `${name}: ${k} must be true or false`);
    }
  });
}
