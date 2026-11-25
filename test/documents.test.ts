// DOCX and PDF snapshots, the contract-b2b rubric, and per-rubric approved reviewers.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
