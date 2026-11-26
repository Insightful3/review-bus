// DOCX and PDF snapshots, the contract-b2b rubric, and per-rubric approved reviewers.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { htmlToMarkdown } from "../src/convert.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTRACT = path.join(ROOT, "test/fixtures/contract-northwind-bluefin.docx");
const PDF = path.join(ROOT, "test/fixtures/proposal-bluefin.pdf");

let tmp: string;
let client: Client;
type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { res, text: res.content[0].text, json: res.isError ? null : JSON.parse(res.content.at(-1)!.text) };
}

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "review-bus-docs-"));
  mkdirSync(path.join(tmp, "rubrics"));
  writeFileSync(path.join(tmp, "rubrics", "secret-test.md"), "---\nconfidential: true\n---\n# Secret\n\nCheck anything.\n");
  const fake = { type: "command", command: process.execPath, args: [path.join(ROOT, "test/fake-reviewer.mjs")], timeout_seconds: 30 };
  const configFile = path.join(tmp, "config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      rubric_paths: [path.join(tmp, "rubrics")],
      storage: { documents: path.join(tmp, "reviews") },
      default_reviewers: ["fake2", "fake"],
      adapters: { fake, fake2: fake },
      allowed_reviewers: { "contract-b2b": ["fake"] },
    }),
  );
  client = new Client({ name: "docs-author", version: "0.0.0" });
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
});

test("DOCX contract: converted to Markdown, approved reviewers only, high effort, needs sign-off", async () => {
  const { json, text } = await call("review_submit", { artifact: CONTRACT, rubric: "contract-b2b", intent: "Sign the Bluefin services agreement.", wait_seconds: 10 });
  assert.ok(json, text);
  // default_reviewers is [fake2, fake]; only fake is approved for contract-b2b.
  assert.deepEqual(json.reviewers.map((r: { name: string }) => r.name), ["fake"]);
  assert.equal(json.reviewers[0].label, "fake:default:high"); // effort from the rubric
  assert.equal(json.state, "awaiting_signoff"); // no blocking findings, but a person must sign off
  assert.match(json.notice, /not lawyers/);

  const dir = path.join(tmp, "reviews", json.review_id);
  const review = JSON.parse(readFileSync(path.join(dir, "review.json"), "utf8"));
  assert.deepEqual([review.rounds[0].snapshot.kind, review.rounds[0].snapshot.converter], ["docx", "mammoth"]);
  assert.deepEqual(review.rounds[0].snapshot.warnings, []);
  assert.ok(existsSync(path.join(dir, "r1/original.docx")));
  const md = readFileSync(path.join(dir, "r1/artifact.md"), "utf8");
  assert.match(md, /^# Services Agreement/);
  assert.match(md, /# 3\. Price and payment\n\nThe total fixed price is EUR 24,000/);
  assert.match(md, /\| Total \| EUR 22,500 \|/);
  assert.match(readFileSync(path.join(dir, "report.md"), "utf8"), /^# Review rv_\w+\n\n> Reviewers are AI agents, not lawyers\./);
});

test("contract-b2b refuses a reviewer that is not approved for it", async () => {
  const { res, text } = await call("review_submit", { artifact: CONTRACT, rubric: "contract-b2b", intent: "x", reviewers: ["fake2"] });
  assert.equal(res.isError, true);
  assert.match(text, /fake2 are not approved for this rubric\. Approved: fake/);
});

test("a confidential rubric with no approved reviewers in config refuses to run", async () => {
  const { res, text } = await call("review_submit", { artifact: CONTRACT, rubric: "secret-test", intent: "x", reviewers: ["fake"] });
  assert.equal(res.isError, true);
  assert.match(text, /Rubric "secret-test" is confidential/);
});

test("PDF proposal: pages become headings, reviewers find the problems", async () => {
  const { json, text } = await call("review_submit", { artifact: PDF, rubric: "proposal", intent: "x", reviewers: ["fake"], wait_seconds: 10 });
  assert.ok(json, text);
  const dir = path.join(tmp, "reviews", json.review_id);
  const snap = JSON.parse(readFileSync(path.join(dir, "review.json"), "utf8")).rounds[0].snapshot;
  assert.equal(snap.kind, "pdf");
  assert.ok(["pdftotext", "unpdf"].includes(snap.converter));
  const md = readFileSync(path.join(dir, "r1/artifact.md"), "utf8");
  assert.match(md, /^## Page 1\n/);
  assert.match(md, /\n## Page 2\n/);
  assert.equal(json.state, "changes_requested");
  assert.equal(json.counts.blocking, 2);
});

test("unsupported file types are refused with the supported list", async () => {
  const rtf = path.join(tmp, "note.rtf");
  writeFileSync(rtf, "{\\rtf1 hello}");
  const { res, text } = await call("review_submit", { artifact: rtf, rubric: "proposal", intent: "x", reviewers: ["fake"] });
  assert.equal(res.isError, true);
  assert.match(text, /Supported: \.md, \.markdown, \.txt, \.docx, \.pdf/);
});

test("htmlToMarkdown handles mammoth's lists, tables and entities", () => {
  const html =
    "<h2>Terms &amp; conditions</h2><p>Pay <strong>EUR 1,000</strong> &lt;net&gt;.</p>" +
    "<ol><li>First</li><li>Second</li></ol><ul><li>Dot</li></ul>" +
    "<table><tr><td><p>A|B</p></td><td>C</td></tr><tr><td>D</td></tr></table>";
  assert.equal(
    htmlToMarkdown(html),
    "## Terms & conditions\n\nPay **EUR 1,000** <net>.\n\n1. First\n2. Second\n\n- Dot\n\n| A\\|B | C |\n| --- | --- |\n| D |  |\n",
  );
});

test("related documents are converted, put in the prompt for comparison, and part of the snapshot hash", async () => {
  const PROPOSAL_MD = path.join(ROOT, "test/fixtures/proposal-bluefin.md");
  const { json, text } = await call("review_submit", {
    artifact: CONTRACT,
    related: [PROPOSAL_MD, PDF],
    rubric: "contract-b2b",
    intent: "Sign the agreement that matches the accepted proposal.",
    wait_seconds: 10,
  });
  assert.ok(json, text);
  const dir = path.join(tmp, "reviews", json.review_id);
  const snap = JSON.parse(readFileSync(path.join(dir, "review.json"), "utf8")).rounds[0].snapshot;
  assert.deepEqual(snap.related.map((r: { markdown_file: string }) => r.markdown_file), ["r1/related/01-proposal-bluefin.md", "r1/related/02-proposal-bluefin.md"]);
  const prompt = readFileSync(path.join(dir, "r1/prompt.md"), "utf8");
  assert.match(prompt, /## Related documents \(for comparison, not under review\)/);
  assert.match(prompt, /<related name="proposal-bluefin\.md">\n# Proposal: Customer support assistant/);
  assert.match(prompt, /<related name="proposal-bluefin\.pdf">\n## Page 1/);
  // The contract itself is still the document under review.
  assert.match(prompt, /<document>\n# Services Agreement/);
  assert.match(readFileSync(path.join(dir, "report.md"), "utf8"), /compared with proposal-bluefin\.md, proposal-bluefin\.pdf/);

  const missing = await call("review_submit", { artifact: CONTRACT, related: ["/nope/proposal.md"], rubric: "contract-b2b", intent: "x" });
  assert.match(missing.text, /Related document not found/);
});

test("nested lists keep every item, including the ones after a sub-list (real mammoth output)", () => {
  const html =
    "<p>Scope</p><ul><li>Assistant on the website<ul><li>German</li><li>English</li></ul></li>" +
    "<li>Final delivery clause: go-live by 15 March 2027</li></ul><p>After the list</p>" +
    "<ol><li><p>First</p><ol><li>One a</li></ol></li><li>Second &amp; last</li></ol>";
  assert.equal(
    htmlToMarkdown(html),
    "Scope\n\n- Assistant on the website\n  - German\n  - English\n- Final delivery clause: go-live by 15 March 2027\n\nAfter the list\n\n1. First\n  1. One a\n2. Second & last\n",
  );
});

test("merged table cells keep every value under its own heading (real mammoth output)", () => {
  const html =
    '<table><tr><td><p>Service</p></td><td><p>Standard</p></td><td><p>Premium</p></td></tr>' +
    '<tr><td rowspan="2"><p>Support assistant</p></td><td><p>EUR 22,500</p></td><td><p>EUR 31,000</p></td></tr>' +
    "<tr><td><p>EUR 1,200 / month</p></td><td><p>EUR 2,000 / month</p></td></tr>" +
    '<tr><td colspan="2"><p>Total first year</p></td><td><p>EUR 55,000</p></td></tr></table>';
  assert.equal(
    htmlToMarkdown(html),
    "| Service | Standard | Premium |\n| --- | --- | --- |\n| Support assistant | EUR 22,500 | EUR 31,000 |\n" +
      "| Support assistant | EUR 1,200 / month | EUR 2,000 / month |\n| Total first year | Total first year | EUR 55,000 |\n",
  );
});

test("a document sent as text: reviewed like a file, a new version as text on resubmit, round 1 kept", async () => {
  const original = readFileSync(path.join(ROOT, "test/fixtures/proposal-bluefin.md"), "utf8");
  const { json: r1, text } = await call("review_submit", {
    artifact: { name: "proposal", content: original },
    related: [{ name: "sources.txt", content: "Bluefin asked for a fixed price of EUR 22,500." }],
    rubric: "proposal",
    intent: "Win the Bluefin project.",
    reviewers: ["fake"],
    wait_seconds: 10,
  });
  assert.ok(r1, text);
  assert.equal(r1.state, "changes_requested");
  const dir = path.join(tmp, "reviews", r1.review_id);
  const review = JSON.parse(readFileSync(path.join(dir, "review.json"), "utf8"));
  // No extension: saved as .md in the review folder, owner-only, outside any repo.
  const source = review.request.artifact.path;
  assert.equal(review.request.artifact.inline, true);
  assert.ok(source.startsWith(path.join(dir, "source") + path.sep) && source.endsWith("proposal.md"), source);
  assert.equal(statSync(source).mode & 0o777, 0o600);
  assert.equal(review.rounds[0].snapshot.kind, "markdown");
  assert.equal(readFileSync(path.join(dir, "r1/artifact.md"), "utf8").trim(), original.trim());
  assert.match(readFileSync(path.join(dir, "r1/prompt.md"), "utf8"), /<related name="sources\.txt">\nBluefin asked for a fixed price/);
  assert.match(readFileSync(path.join(dir, "report.md"), "utf8"), /proposal\.md \(sent as text\) \+ compared with sources\.txt/);

  const fixed = original
    .replace("Total price: EUR 24,000 excluding VAT.", "Total price: EUR 22,500 excluding VAT.")
    .replace("The assistant will resolve 70% of incoming support questions", "We target 70% of incoming support questions resolved");
  const answers = r1.findings.filter((f: { blocking: boolean }) => f.blocking).map((f: { finding_id: string }) => ({ finding_id: f.finding_id, status: "accepted", note: "Fixed." }));
  const r2 = await call("review_respond", { review_id: r1.review_id, responses: answers, resubmit: true, artifact: { name: "proposal.md", content: fixed }, wait_seconds: 10 });
  assert.notEqual(r2.res.isError, true, r2.text);
  const result = JSON.parse(r2.res.content.find((c) => c.text.trim().startsWith("{"))!.text); // the review, then the unanswered list
  assert.equal(result.round, 2);
  assert.equal(result.state, "approved");
  assert.match(readFileSync(path.join(dir, "r2/artifact.md"), "utf8"), /EUR 22,500 excluding VAT/);
  assert.match(readFileSync(path.join(dir, "r1/artifact.md"), "utf8"), /EUR 24,000 excluding VAT/);
});

test("text documents: folder names, binary formats and empty text are refused before anything is written", async () => {
  const before = readdirSync(path.join(tmp, "reviews")).length;
  for (const [artifact, pattern] of [
    [{ name: "../escape.md", content: "x" }, /plain file name/],
    [{ name: ".hidden.md", content: "x" }, /plain file name/],
    [{ name: "contract.docx", content: "x" }, /only \.md, \.markdown, \.txt can be sent as text/],
    [{ name: "post.md", content: "  \n" }, /is empty/],
  ] as const) {
    const { res, text } = await call("review_submit", { artifact, rubric: "proposal", intent: "x", reviewers: ["fake"] });
    assert.equal(res.isError, true, JSON.stringify(artifact));
    assert.match(text, pattern);
  }
  // A bad related text fails the whole submit, even with a good document.
  const bad = await call("review_submit", { artifact: { name: "post.md", content: "Hello" }, related: [{ name: "a/b.md", content: "x" }], rubric: "proposal", intent: "x", reviewers: ["fake"] });
  assert.match(bad.text, /plain file name/);
  // The text and a path together are refused by the schema.
  const both = await call("review_submit", { artifact: { name: "post.md", content: "Hello", path: "/x.md" }, rubric: "proposal", intent: "x", reviewers: ["fake"] });
  assert.equal(both.res.isError, true);
  assert.equal(readdirSync(path.join(tmp, "reviews")).length, before);
});
