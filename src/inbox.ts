// The web inbox (rb serve, /inbox): reviews at a glance, reports, sign-off, and pull reviews by a
// person. Plain server-rendered HTML; the only script adds finding rows to the answer form.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ClaimedWork, Engine } from "./engine.js";
import { describeArtifact } from "./snapshot.js";
import type { Review } from "./types.js";

const esc = (s: unknown) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const STYLE = `
:root { --bg: #fbfaf8; --fg: #1d1d1b; --muted: #6b6a66; --line: #e3e0da; --card: #fff; --accent: #2f5d8a; --bad: #a33b2b; --ok: #2e6b3f; }
@media (prefers-color-scheme: dark) { :root { --bg: #171716; --fg: #ecebe7; --muted: #a3a19b; --line: #34332f; --card: #1f1f1d; --accent: #8db7e0; --bad: #e08a7b; --ok: #8cc79b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
a { color: var(--accent); }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 8px; } h3 { font-size: 15px; margin: 18px 0 6px; }
.muted { color: var(--muted); }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; color: var(--muted); font-size: 13px; }
.state { font-size: 12px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--line); white-space: nowrap; }
.state.changes_requested, .state.escalated, .state.failed { color: var(--bad); }
.state.approved { color: var(--ok); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 12px 0; }
.report { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, Menlo, monospace; }
.msg { background: var(--card); border-left: 3px solid var(--accent); padding: 8px 12px; }
.err { border-left-color: var(--bad); }
label { display: block; font-size: 13px; color: var(--muted); margin: 8px 0 2px; }
input[type=text], input[type=password], textarea, select { width: 100%; padding: 6px 8px; font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; }
textarea { min-height: 60px; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--bg); cursor: pointer; }
button.secondary { background: transparent; color: var(--accent); }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 640px) { .row { grid-template-columns: 1fr; } table { font-size: 13px; } }
.finding { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 10px 0; }
img.shot { max-width: 100%; border: 1px solid var(--line); margin: 6px 0; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main><script src="/inbox/app.js"></script></body></html>`;
}

export function renderLogin(error: string | null): string {
  return page(
    "Review inbox",
    `<h1>Review inbox</h1><p class="muted">Paste the token from the file named in http.token_file (default ~/.review-bus/http-token).</p>
${error ? `<p class="msg err">${esc(error)}</p>` : ""}
<form method="post" action="/inbox/login" class="card"><label for="token">Token</label><input id="token" name="token" type="password" autocomplete="off" required><p><button>Open the inbox</button></p></form>`,
  );
}

export function renderError(message: string): string {
  return page("Review inbox", `<p><a href="/inbox">Inbox</a></p><p class="msg err">${esc(message)}</p>`);
}

function stateBadge(state: string): string {
  return `<span class="state ${esc(state)}">${esc(state.replaceAll("_", " "))}</span>`;
}

function reviewRow(r: Review): string {
  return `<tr><td><a href="/inbox/review/${esc(r.id)}">${esc(r.id)}</a><div class="muted">${esc(describeArtifact(r.request))}</div></td><td>${esc(r.request.rubric)}</td><td>${stateBadge(r.state)}</td><td>r${r.rounds.length}</td><td class="muted">${esc(r.updated_at.slice(0, 16).replace("T", " "))}</td></tr>`;
}

function table(rows: string[], empty: string): string {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<table><thead><tr><th>Review</th><th>Rubric</th><th>State</th><th>Round</th><th>Updated</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

export function renderInbox(engine: Engine): string {
  const reviews = engine.list(undefined, 100);
  const pending = engine.pending();
  const decide = reviews.filter((r) => r.state === "awaiting_signoff" || r.state === "escalated");
  const work = pending.length
    ? `<table><thead><tr><th>Review</th><th>Reviewer</th><th>Rubric</th><th>Status</th><th>Due</th></tr></thead><tbody>${pending
        .map(
          (w) =>
            `<tr><td><a href="/inbox/review/${esc(w.review_id)}">${esc(w.review_id)}</a><div class="muted">${esc(w.artifact)}: ${esc(w.intent)}</div></td><td>${esc(w.reviewer)}</td><td>${esc(w.rubric)}</td><td>${esc(w.status === "claimed" ? `claimed by ${w.claimed_by}` : "waiting")}</td><td class="muted">${esc(w.deadline?.slice(0, 16).replace("T", " ") ?? "")}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No work waiting for pull reviewers.</p>`;
  return page(
    "Review inbox",
    `<h1>Review inbox</h1><p class="muted">${reviews.length} recent review(s).</p>
<h2>Waiting for a reviewer</h2>${work}
<h2>Waiting for your decision</h2>${table(decide.map(reviewRow), "Nothing awaits sign-off.")}
<h2>Recent</h2>${table(reviews.map(reviewRow), "No reviews yet.")}`,
  );
}

export function renderReviewPage(engine: Engine, id: string, msg: string | null): string {
  const review = engine.get(id);
  const dir = engine.store.dir(id);
  const report = existsSync(path.join(dir, "report.md")) ? readFileSync(path.join(dir, "report.md"), "utf8") : "";
  const round = review.rounds.at(-1);
  const claimable = (round?.reviewers ?? []).filter((r) => r.adapter === "pull" && r.status === "waiting" && review.state === "in_review");
  const claimForms = claimable
    .map(
      (r) => `<form method="post" action="/inbox/claim/${esc(id)}/${esc(r.name)}/start" class="card"><h3>Review this as ${esc(r.name)}</h3>
<p class="muted">Due ${esc(r.deadline ?? "")}. Claiming shows you the work and the answer form; nobody else can answer for ${esc(r.name)} after that.</p>
<label for="by-${esc(r.name)}">Your name</label><input id="by-${esc(r.name)}" name="by" type="text" required><p><button>Claim and review</button></p></form>`,
    )
    .join("");
  const signoff =
    review.state === "awaiting_signoff" || review.state === "escalated"
      ? `<form method="post" action="/inbox/review/${esc(id)}/signoff" class="card"><h3>Sign off</h3>
<p class="muted">${review.state === "escalated" ? "The round cap was reached with blocking findings open. Signing off approves the work as it is." : "Every blocking finding is answered. The rubric requires a person to approve."}</p>
<label for="by">Your name</label><input id="by" name="by" type="text" required><label for="note">Note (optional)</label><textarea id="note" name="note"></textarea><p><button>Sign off</button></p></form>`
      : "";
  const shots = (round?.snapshot.pages ?? []).flatMap((p) => p.screenshots.map((s) => ({ url: p.url, file: s.file, viewport: s.viewport })));
  const gallery = shots.length
    ? `<h2>Screenshots, round ${round!.n}</h2>${shots
        .map((s) => `<div><div class="muted">${esc(s.url)} (${esc(s.viewport)})</div><a href="/inbox/review/${esc(id)}/file/${s.file.split("/").map(encodeURIComponent).join("/")}"><img class="shot" loading="lazy" alt="Screenshot of ${esc(s.url)}" src="/inbox/review/${esc(id)}/file/${s.file.split("/").map(encodeURIComponent).join("/")}"></a></div>`)
        .join("")}`
    : "";
  return page(
    `Review ${id}`,
    `<p><a href="/inbox">Inbox</a></p><h1>${esc(id)} ${stateBadge(review.state)}</h1><p class="muted">${esc(review.request.rubric)}: ${esc(review.request.intent)}</p>
${msg ? `<p class="msg">${esc(msg)}</p>` : ""}${claimForms}${signoff}
<h2>Report</h2><div class="card report">${esc(report)}</div>${gallery}`,
  );
}

const IMPACTS = ["critical", "high", "medium", "low"];
const LIKELIHOODS = ["certain", "likely", "possible", "remote"];

function findingFields(): string {
  const opt = (values: string[], selected: string) => values.map((v) => `<option${v === selected ? " selected" : ""}>${v}</option>`).join("");
  return `<div class="finding"><label>Claim: what is wrong</label><input type="text" name="f_claim">
<div class="row"><div><label>Impact</label><select name="f_impact">${opt(IMPACTS, "medium")}</select></div><div><label>Likelihood</label><select name="f_likelihood">${opt(LIKELIHOODS, "likely")}</select></div></div>
<label>Failure scenario: when does it cause harm (needed for the finding to block)</label><textarea name="f_failure"></textarea>
<label>Evidence: why you think so</label><textarea name="f_evidence"></textarea>
<div class="row"><div><label>Section or file</label><input type="text" name="f_section"></div><div><label>Exact quote (optional)</label><input type="text" name="f_quote"></div></div>
<label>Suggested fix (optional)</label><textarea name="f_fix"></textarea>
<label>Challenges an assumption the author stated</label><select name="f_challenge"><option value="no">no</option><option value="yes">yes</option></select></div>`;
}

export function renderClaimPage(engine: Engine, work: ClaimedWork, by: string): string {
  const reviewDir = engine.store.dir(work.review_id);
  const images = work.files.filter((f) => f.endsWith(".png")).map((f) => path.relative(reviewDir, f));
  return page(
    `Review ${work.review_id}`,
    `<p><a href="/inbox/review/${esc(work.review_id)}">Back to the review</a></p>
<h1>Reviewing ${esc(work.review_id)} as ${esc(work.reviewer)}</h1>
<p class="muted">Claimed by ${esc(by)}. Due ${esc(work.deadline ?? "")}. Keep this page open until you send the answer: the claim token is in the form.</p>
<h2>The work and the instructions</h2><div class="card report">${esc(work.prompt)}</div>
${images.map((f) => `<img class="shot" loading="lazy" alt="Screenshot" src="/inbox/review/${esc(work.review_id)}/file/${f.split("/").map(encodeURIComponent).join("/")}">`).join("")}
<h2>Your answer</h2>
<form method="post" action="/inbox/claim/${esc(work.review_id)}/${esc(work.reviewer)}/post" class="card">
<input type="hidden" name="claim_token" value="${esc(work.token)}">
<div class="row"><div><label for="verdict">Verdict</label><select id="verdict" name="verdict"><option value="changes_requested">changes requested</option><option value="approve">approve</option><option value="comment">comment</option></select></div></div>
<label for="summary">Summary</label><textarea id="summary" name="summary"></textarea>
<div id="findings">${findingFields()}</div>
<template id="finding-template">${findingFields()}</template>
<p><button type="button" class="secondary" id="add-finding">Add another finding</button></p>
<p><button>Send the review</button></p>
<details><summary>Decline instead</summary><label for="decline">Why you cannot review this</label><textarea id="decline" name="decline"></textarea><p class="muted">With a reason here, the findings above are ignored.</p></details>
</form>`,
  );
}

export const INBOX_JS = `document.getElementById("add-finding")?.addEventListener("click", () => {
  const t = document.getElementById("finding-template");
  document.getElementById("findings").appendChild(t.content.cloneNode(true));
});
`;

/** Builds reviewer output JSON from the answer form; rows without a claim are skipped. */
export function answerFromForm(form: URLSearchParams): unknown {
  const all = (k: string) => form.getAll(k);
  const claims = all("f_claim");
  const pick = (k: string, i: number) => (all(k)[i] ?? "").trim();
  const findings = claims
    .map((c, i) => ({ c: c.trim(), i }))
    .filter(({ c }) => c)
    .map(({ c, i }) => ({
      claim: c,
      failure_scenario: pick("f_failure", i) || null,
      evidence: pick("f_evidence", i) || "Raised by a person reviewing the work.",
      location: { path: null, line_start: null, line_end: null, section: pick("f_section", i) || null, quote: pick("f_quote", i) || null },
      likelihood: pick("f_likelihood", i) || "likely",
      impact: pick("f_impact", i) || "medium",
      suggested_fix: pick("f_fix", i) || null,
      assumption_challenge: pick("f_challenge", i) === "yes",
      confidence: 0.8,
    }));
  return { verdict: form.get("verdict") ?? "comment", summary: (form.get("summary") ?? "").trim(), findings };
}
