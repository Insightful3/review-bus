// The web inbox (rb serve, /inbox): reviews at a glance, reports, sign-off, and pull reviews by a
// person. Plain server-rendered HTML; the only script adds finding rows to the answer form.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pendingFrom, type ClaimedWork, type Engine } from "./engine.js";
import { describeArtifact } from "./snapshot.js";
import type { Review } from "./types.js";

/** Times are stored in UTC; shown as "2026-11-25 17:45 UTC". */
const fmt = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "");

/** A document path shown as its file name (the full path is in the title attribute). */
const shortArtifact = (r: Review) => {
  const full = describeArtifact(r.request);
  return { full, short: full.startsWith("/") ? path.basename(full) : full };
};

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
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); }
td a { overflow-wrap: anywhere; }
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
label > input, label > textarea, label > select { margin-top: 2px; color: var(--fg); }
fieldset.finding legend { font-size: 13px; color: var(--muted); padding: 0 4px; }
details.card summary { cursor: pointer; }
input[type=text], input[type=password], textarea, select { width: 100%; padding: 6px 8px; font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; }
textarea { min-height: 60px; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--bg); cursor: pointer; }
button.secondary { background: transparent; color: var(--accent); }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 640px) { .row { grid-template-columns: 1fr; } table { font-size: 13px; } }
.finding { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 10px 0; min-width: 0; }
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

/** The session expired while a form was being filled in: ask for the token and send the form as it was. */
export function renderReauth(action: string, payload: string, wrongToken: boolean): string {
  return page(
    "Review inbox",
    `<h1>Your inbox session expired</h1><p class="muted">What you sent is kept on this page. Paste the token (from http.token_file) to send it.</p>
${wrongToken ? `<p class="msg err">That token does not match.</p>` : ""}
<form method="post" action="${esc(action)}" class="card"><input type="hidden" name="_payload" value="${esc(payload)}">
<label>Token<input name="_reauth_token" type="password" autocomplete="off" aria-label="Token" required></label><p><button>Send it</button></p></form>`,
  );
}

export function renderError(message: string): string {
  return page("Review inbox", `<p><a href="/inbox">Inbox</a></p><p class="msg err">${esc(message)}</p>`);
}

function stateBadge(state: string): string {
  return `<span class="state ${esc(state)}">${esc(state.replaceAll("_", " "))}</span>`;
}

function reviewRow(r: Review): string {
  const a = shortArtifact(r);
  return `<tr><td><a href="/inbox/review/${esc(r.id)}">${esc(r.id)}</a><div class="muted" title="${esc(a.full)}">${esc(a.short)}</div></td><td>${esc(r.request.rubric)}</td><td>${stateBadge(r.state)}</td><td>r${r.rounds.length}</td><td class="muted">${esc(fmt(r.updated_at))}</td></tr>`;
}

function table(rows: string[], empty: string): string {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<div class="scroll"><table><thead><tr><th>Review</th><th>Rubric</th><th>State</th><th>Round</th><th>Updated</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

/** All sections from one pass over the saved reviews (newest first). */
export function renderInbox(all: Review[]): string {
  const reviews = all.slice(0, 100);
  const pending = pendingFrom(all);
  // Every review waiting for a decision, however old: not only those among the 100 most recent.
  const decide = all.filter((r) => r.state === "awaiting_signoff" || r.state === "escalated").sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const work = pending.length
    ? `<div class="scroll"><table><thead><tr><th>Review</th><th>Reviewer</th><th>Rubric</th><th>Status</th><th>Due</th></tr></thead><tbody>${pending
        .map(
          (w) =>
            `<tr><td><a href="/inbox/review/${esc(w.review_id)}">${esc(w.review_id)}</a><div class="muted" title="${esc(w.artifact)}">${esc(w.artifact.startsWith("/") ? path.basename(w.artifact) : w.artifact)}: ${esc(w.intent)}</div></td><td>${esc(w.reviewer)}</td><td>${esc(w.rubric)}</td><td>${esc(w.status === "claimed" ? `claimed by ${w.claimed_by}` : "waiting")}</td><td class="muted">${esc(fmt(w.deadline))}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
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
<p class="muted">Due ${esc(fmt(r.deadline))}. Claiming shows you the work and the answer form; nobody else can answer for ${esc(r.name)} after that.</p>
<label for="by-${esc(r.name)}">Your name</label><input id="by-${esc(r.name)}" name="by" type="text" required><p><button>Claim and review</button></p></form>`,
    )
    .join("");
  const claimed = (round?.reviewers ?? []).filter((r) => r.adapter === "pull" && r.status === "running" && r.claim && review.state === "in_review");
  const releaseForms = claimed
    .map(
      (r) => `<form method="post" action="/inbox/review/${esc(id)}/release/${esc(r.name)}" class="card"><h3>${esc(r.name)} is claimed by ${esc(r.claim!.by)}</h3>
<p class="muted">Claimed ${esc(fmt(r.claim!.at))}. If that review will not be finished (a closed tab, the wrong person), release the claim so someone else can take it.</p>
<input type="hidden" name="claim_id" value="${esc(r.claim!.id)}">
<label>Your name<input type="text" name="by" aria-label="Your name" required></label><p><button class="secondary">Release the claim</button></p></form>`,
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
${msg ? `<p class="msg">${esc(msg)}</p>` : ""}${claimForms}${releaseForms}${signoff}
<h2>Report</h2><div class="card report">${esc(report)}</div>${gallery}`,
  );
}

const IMPACTS = ["critical", "high", "medium", "low"];
const LIKELIHOODS = ["certain", "likely", "possible", "remote"];

function findingFields(): string {
  const opt = (values: string[], selected: string) => values.map((v) => `<option${v === selected ? " selected" : ""}>${v}</option>`).join("");
  // Inputs sit inside their labels, so every field is named for screen readers without ids
  // (rows are cloned from a template).
  return `<fieldset class="finding"><legend>Finding</legend><label>Claim: what is wrong<input type="text" name="f_claim" aria-label="Claim"></label>
<div class="row"><label>Impact<select name="f_impact" aria-label="Impact">${opt(IMPACTS, "medium")}</select></label><label>Likelihood<select name="f_likelihood" aria-label="Likelihood">${opt(LIKELIHOODS, "likely")}</select></label></div>
<label>Failure scenario: when does it cause harm (a finding without one never blocks)<textarea name="f_failure" aria-label="Failure scenario"></textarea></label>
<label>Evidence: why you think so<textarea name="f_evidence" aria-label="Evidence"></textarea></label>
<div class="row"><label>Section or file<input type="text" name="f_section" aria-label="Section or file"></label><label>Exact quote (optional)<input type="text" name="f_quote" aria-label="Exact quote"></label></div>
<label>Suggested fix (optional)<textarea name="f_fix" aria-label="Suggested fix"></textarea></label>
<label>Repeats an earlier finding (its id from the previous round or Decided earlier, optional)<input type="text" name="f_repeats" aria-label="Repeats an earlier finding"></label>
<label>Challenges an assumption the author stated<select name="f_challenge" aria-label="Challenges an assumption"><option value="no">no</option><option value="yes">yes</option></select></label></fieldset>`;
}

export function renderClaimPage(engine: Engine, work: ClaimedWork, by: string): string {
  const reviewDir = engine.store.dir(work.review_id);
  const images = work.files.filter((f) => f.endsWith(".png")).map((f) => path.relative(reviewDir, f));
  const text = (f: string | undefined) => (f && existsSync(f) && f.endsWith(".md") ? readFileSync(f, "utf8") : null);
  const doc = text(work.files[0]);
  const list = (title: string, items: string[]) => (items.length ? `<h3>${esc(title)}</h3><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  return page(
    `Review ${work.review_id}`,
    `<p><a href="/inbox/review/${esc(work.review_id)}">Back to the review</a></p>
<h1>Reviewing ${esc(work.review_id)} as ${esc(work.reviewer)}</h1>
<p class="muted">Claimed by ${esc(by)}. Due ${esc(fmt(work.deadline))}. Keep this page open until you send the answer: the claim token is in the form.</p>
<h2>What the author wants</h2><p>${esc(work.intent)}</p>${list("The author's assumptions", work.assumptions)}${list("Criteria", work.criteria)}
<details class="card"><summary>Rubric: ${esc(work.rubric)}</summary><div class="report">${esc(work.rubric_text)}</div></details>
${doc ? `<h2>The work</h2><div class="card report">${esc(doc)}</div>` : ""}
${work.patch_file ? `<p><a href="/inbox/review/${esc(work.review_id)}/file/${work.patch_file.split("/").map(encodeURIComponent).join("/")}">The full change (patch)</a>: the text above is cut at 120,000 characters for large changes.</p>` : ""}
${images.map((f) => `<img class="shot" loading="lazy" alt="Screenshot" src="/inbox/review/${esc(work.review_id)}/file/${f.split("/").map(encodeURIComponent).join("/")}">`).join("")}
<details class="card"><summary>Everything an agent reviewer gets (instructions, related documents, the change)</summary><div class="report">${esc(work.prompt)}</div></details>
<h2>Your answer</h2>
<form method="post" action="/inbox/claim/${esc(work.review_id)}/${esc(work.reviewer)}/post" class="card">
<input type="hidden" name="claim_token" value="${esc(work.token)}">
<div class="row"><label>Verdict<select name="verdict" aria-label="Verdict"><option value="changes_requested">changes requested</option><option value="approve">approve</option><option value="comment">comment</option></select></label></div>
<label>Summary<textarea name="summary" aria-label="Summary"></textarea></label>
<p class="muted">One finding per problem. Leave the claim empty to skip a finding; with no findings, send an approval.</p>
<div id="findings">${findingFields()}</div>
<template id="finding-template">${findingFields()}</template>
<p><button type="button" class="secondary" id="add-finding">Add another finding</button></p>
<p><button>Send the review</button></p>
<details><summary>Decline instead</summary><label>Why you cannot review this<textarea name="decline"></textarea></label><p class="muted">With a reason here, the findings above are ignored.</p></details>
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
      repeats: pick("f_repeats", i) || null,
    }));
  return { verdict: form.get("verdict") ?? "comment", summary: (form.get("summary") ?? "").trim(), findings };
}
