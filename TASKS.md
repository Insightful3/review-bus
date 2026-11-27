# Task list

Order follows "thinnest slice first, then widen". See `SPEC.md` for details. Released versions are in `CHANGELOG.md`; the next one is planned under v0.3 at the end.

## Slice 1: one document review loop (done)

- [x] Project scaffold: TypeScript, Node 22+, ESM, `@modelcontextprotocol/sdk`, `zod`
- [x] Reviewer output schema in zod, JSON Schema generated into `spec/` (Codex strict rules)
- [x] Config loader (`REVIEW_BUS_CONFIG`, `~/.review-bus/config.json`, cwd)
- [x] Rubric loader from `rubric_paths` (Markdown + front matter), `proposal` rubric
- [x] Document snapshot for Markdown and plain text (copy + SHA-256)
- [x] Reviewer prompt builder
- [x] Adapters: generic command (fake reviewer for tests), Codex (`codex exec`)
- [x] Risk policy: matrix, draft stage, no failure scenario means advisory, cap of 5 blocking
- [x] Storage: `review.json` + `report.md` per review, outside the repo
- [x] MCP tools `review_submit` and `review_result` over stdio
- [x] End-to-end test: MCP client submits a Markdown doc, fake reviewer runs, result comes back
- [x] Codex flags checked against `codex exec --help` (codex-cli 0.172.0); fake `codex` in tests checks them
- [x] One real Codex review of the fixture proposal through the MCP server (about 30 s, 3 blocking, 2 advisory)
- [x] Model and effort (SPEC 8a): config, rubric front matter, stage defaults, per-call override; passed as CLI flags; actual `adapter:model:effort` on findings and in `report.md`
- [x] Reviewer vendor differs from author (SPEC 8a): adapter `vendor`, `author_vendors` from MCP `clientInfo.name` (names checked), `author_vendor` override

## Slice 2: close the loop (done)

- [x] `review_respond` (accepted / rejected with reason / deferred) and resubmit as round n+1, previous round in the prompt
- [x] Round cap of 3, then `escalated`
- [x] `review_status` (live reviewer status), `review_wait`, `review_list`, `review_cancel` (kills reviewers)
- [x] `review_signoff` and `require_signoff` from rubric front matter
- [x] Mark running rounds `failed` after a restart; late results from an old round do not change state
- [x] `report.md` keeps earlier rounds with the author's answers

## Slice 3: widen (done)

- [x] Claude adapter (`claude -p ... --restricted`), fake `claude` in tests; real run with Codex as the author over MCP and Claude reviewing (SPEC 11.3)
- [x] Git snapshots: uncommitted, base, commit; patch + `git archive` copy (nothing written to the author's repo)
- [x] Page review: headless Chrome screenshots (desktop, mobile, tiled), page facts, broken links; images to Codex (`--image`), Claude (Read) and command reviewers
- [x] `webpage` rubric
- [x] DOCX (mammoth) and PDF (pdftotext, else unpdf) to Markdown; fictional DOCX and PDF fixtures from `scripts/make-fixtures.mjs`
- [x] Duplicate finding merge across reviewers (`agreement`): word-based rules for near-identical findings, optional `merge_with` model for the rest, validated, with fallback
- [x] `contract-b2b` rubric: sign-off, not-legal-advice notice, `effort: high`, `confidential: true`
- [x] Per-rubric `allowed_reviewers`
- [x] Client timeouts: waits capped at `max_wait_seconds` (default 50), `review_submit` tells the agent to poll `review_wait`
- [x] Several server processes share storage: rounds record their runner; others leave a live runner's review alone
- [x] Policy: high and critical assumption challenges block (by the matrix); medium and low stay advisory
- [x] `related` documents (for example the accepted proposal for a contract), compared for price, scope and timeline
- [x] Rubrics: `code`, `client-email`, `linkedin-post`, `sop`, `plan`
- [x] CLI `rb`: submit, status, show, list, respond, signoff, cancel
- [x] Tests from SPEC section 11, README, LICENSE

## Later

- [x] Reviewer reads confined to the review folder: Codex permission profile, Claude --restricted; `npm run check:isolation`
- [x] Public pages cannot reach private addresses (blocked; a redirect into one refuses the capture); reviewers stop when their runner dies (watchdog); Codex image viewer confirmed confined
- [ ] Residual: DNS rebinding for page capture; the redirected request is still made before the capture stops
- [x] Decided (25 Nov 2026): agents with terminal access may run `rb signoff`; no extra confirmation.
- [x] Return the review_id before slow page capture (self-review round 2, f10): saved first, snapshot in the background; failures within `snapshot_wait_seconds` are still errors on submit
- [x] Optional `model` for Codex: already supported as `adapters.codex.model`; left unset by the owner's choice (Codex's default model)
- [x] Optional `codex exec review` native pass (SPEC 8): `type: "codex-review"`, scratch repo in the round folder, second pass to findings; checked with real Codex (gpt-6.2-sol, 45 s)
- [x] MCP Tasks, 2025-11-25 form (task-capable submit, respond, wait; tested with the SDK client)
- [x] Claude Code waits for the finished review in one call: progress notifications every 10 s keep the call alive (checked with Claude Code 2.1.316 and a 70 s review)
- [ ] 2026-07-28 Tasks extension, if Claude Code ever needs it over stdio: the v2 SDK 2.4.0 serves 2026-07-28 over HTTP only
- [ ] Resubmit with pages: return before the capture too
- [ ] Hosted multi-user mode (accounts instead of one token), GitHub sync
- [ ] claude.ai web and phone without the desktop app: `rb serve` as a remote connector (a tunnel plus OAuth, since claude.ai connectors cannot send our bearer token)

## v0.2 (25 Nov 2026)

- [x] Pull reviewers (SPEC 8b): `type: "pull"`, `review_pending`/`claim`/`post`/`release`, `rb pending`/`claim`/`post`/`release`, deadlines, `claim_clients`; the last answer finishes the round from any process
- [x] MCP over Streamable HTTP (SPEC 8c): `rb serve`, bearer token file, loopback only unless `allow_remote`, Host and Origin checks
- [x] Web inbox (SPEC 8c): waiting work, decisions, recent reviews, report and screenshots, person reviews with a findings form, release, sign-off; checked in a browser, phone width included
- [x] Rubric packs (SPEC 7a): `rubric_packs`, `pack/rubric`, approvals fall back to the base name, `rb rubrics`, `rb rubric-check`, `review_rubrics`
- [x] `server.ts` starts stdio only as the entry point (rb serve imports it)
- [x] Codex reviewed v0.2 with review-bus itself, 3 rounds (rv_01m89x5tve51aaxs476b8eygjf): 16 blocking findings fixed with tests; escalated at the round cap, a person decides
- [x] Advisories from round 3, fixed with tests: the snapshot wait is capped by the call's budget (f7); the inbox gives a claim back if its page cannot be built (f9); every release names its claim with claimed_at (f10); submodule pointers in codex-review (f12); results and task completions carry the pull-only hint (f13)
- [x] Documents sent as text (SPEC 3): `{name, content}` for the artifact, related documents and resubmits, for chat apps and sandboxes without this machine's disk; README shows the Claude desktop app setup
- [x] Codex review of documents sent as text (rv_01m8ba757d2tnwykkjd7vrft5b): text redacted from REVIEW_BUS_LOG, cleaned up on every failure path, a folder per resubmit, 413 with a reason over HTTP; the Claude desktop app recognised as an Anthropic author
- [x] Second Codex review of documents sent as text (rv_01m8bagnv47m5nqz4tv8npbzwq, 3 rounds, escalated at the cap): crash windows closed (review saved before its text, cleanup retried on every look, dead resubmit attempts pruned), allowlisted log fields, text next to a git change refused. Not changed: text is kept once its review is saved, even if the client never received the id

## v0.3 (26 Nov 2026; 0.3.1 on 27 Nov)

From the first real use of the released 0.2.1 (26 Nov 2026): a document review of a client contract over 3 rounds, and a code review by Claude Code over MCP with Codex reviewing.

- [x] Later rounds block less: from round 2 only critical findings, and high ones that are certain or likely, block (`policy.later_rounds`, default `stricter`). Decided 26 Nov 2026 over the first idea (high or critical, or about changed text), which would not have changed either review. In both reviews, rounds 2 and 3 mostly reacted to the previous round's fixes (a 4-line cart function grew to about 60 lines of exact decimal maths; half the contract's later findings came from earlier fixes)
- [x] Shorter results (about 62,000 to 20,000 characters on the contract): `review_result` for the contract was about 65,000 characters, too long for an agent to read in one call. Return the summary and blocking findings, with advisory findings and full quotes only on request
- [x] `review_wait` in the Claude desktop app's Code tab stopped after 50 s each call: the desktop app relays MCP itself and sends no progress token (client name `local-agent-mode-*`, shared with chat and Cowork). Opt-in `long_wait_clients` instead of a default, since the app's own timeout is unknown
- [x] Resubmit a document sent as text without sending all of it again (`changes` in `review_respond`): accept the changes (find and replace) against the last version, so an agent does not have to retype a long document
- [x] Antigravity CLI (`agy`, Google's successor to Gemini CLI) as an author: a `google` vendor and README setup for `~/.gemini/config/mcp_config.json`
- [x] Codex reviewed v0.3 with review-bus itself, 3 rounds (rv_01m8cqx36p89fpf553xwt9hj8z): 9 blocking findings fixed with tests (edits apply to the frozen version by position, are checked before answers are saved and bound to their round; full includes advisory; old rounds keep the old rule; the agy prompt never goes on the command line); escalated at the cap, a person decides
- [x] Decided (26 Nov 2026), not changed: a resubmit that fails after its answers are saved (a page capture failing, say) keeps the answers (Codex v0.3 r3.f2 asked to drop them). Keeping them is the earlier, tested design: after starting the dev server the author resubmits without answering again, and closing without a resubmit is allowed anyway, with a note on accepted findings that were not re-reviewed
- [x] Antigravity's MCP client name, `antigravity-client` (agy 1.5.18), is in the built-in `author_vendors`; headless agy needs `mcp(review-bus/*)` allowed to call review-bus
- [x] Antigravity CLI as a reviewer: `type: "agy"` (`agy -p`, `--output-format json`, `--json-schema`, `--sandbox`, deny rules in `--settings`), tested with a fake and with agy 1.5.18. Plan mode returned no answer headless, and default mode wrote files without asking, so deny rules hold it read-only. Output arrives when stdout is not a terminal
- [x] `rb submit -` reading the document from stdin

## Next

From reviewing the launch post with the `linkedin-post` rubric (27 Nov 2026; rv_01m8e7zq5nk0k7fn1y3eqs8yfr and rv_01m8e8kxyy6yqm1q0v7v11zq5r, Codex reviewing).

- [x] `linkedin-post` rubric: a post is not documentation. Codex rated true simplifications as high and likely ("3 rounds" without "by default", "fix it or say why not" without deferral). Say in the rubric that leaving out a detail is fine as long as what the post says stays true; a missing detail is low at most
- [ ] A new review knows nothing about an earlier one on the same document. The deferral point came back in the second review although the author had rejected it with a reason in the first. Let a submit name an earlier review, so its rejected findings and their reasons go to the reviewer as already decided (design: v0.4 below)
- [x] `changes` in `review_respond` edits the copy review-bus keeps, not the author's file (by design: review-bus never writes to it). The author's file then lacks the change unless the author edits it too, which is easy to miss. Say so in the result ("sent as text; your file is unchanged"), and in the README

## v0.4 design: decisions that stay decided (draft, 27 Nov 2026)

For discussion before any code. The problem: an author rejects or defers a finding with a reason, and the same point comes back anyway.

### What happens today

- Within a review, a round sees only the round before it (`buildPrompt` gets one `previous` round). A finding rejected in round 1 is not in round 3's prompt, so it can come back in round 3.
- The prompt asks reviewers not to raise a rejected finding again. Deferred findings are listed with their answer but not protected.
- A new review of the same document starts from nothing. On the launch post, the deferral point was answered in rv_01m8e7zq5nk0k7fn1y3eqs8yfr and raised again as blocking in rv_01m8e8kxyy6yqm1q0v7v11zq5r.
- When a point comes back, the author answers it again, and a blocking slot (5 per round) goes to it instead of to something new.

### Proposal

1. **Every earlier round, not just the last.** (Done 27 Nov 2026, for 0.3.2.) The prompt lists the findings of all earlier rounds that were rejected or deferred, with the author's reason, under "Decided in earlier rounds", plus the last round in full as today. Accepted findings from older rounds are left out: the version under review shows whether they were fixed. Within the budget of step 6 (`HISTORY_LIMITS` in `prompt.ts`).
2. **Deferred comes back only as a reminder (new behaviour).** (Done 27 Nov 2026, in the prompt.) A deferred finding is known and planned for later: the reviewer raises it again only as a reminder, with `failure_scenario` null so it is advisory, unless the author's reason does not hold for this version. In 0.4 the `repeats` mark (step 8) makes a repeated deferred finding advisory without relying on that.
3. **`follows` on submit.** `review_submit` takes `follows: "rv_..."` (CLI: `rb submit --follows rv_...`). Only a closed review can be followed: approved, awaiting sign-off or escalated. A review that is being prepared, in review, waiting for answers, failed or canceled is refused before anything is saved, as are an unknown id and a different kind of artifact (a document following a git change). A different rubric is allowed.
4. **Copied once, at submit.** The carried decisions are copied into the new review when it is submitted (`request.inherited`) and never read from the earlier review again, so later rounds see the same list the submit result announced ("Follows rv_...: 4 earlier decisions passed to the reviewers").
5. **What carries over.** From the followed review: findings answered rejected or deferred, each with its claim, rating, place and reason; accepted findings, as "fixed earlier, check it did not come back"; and the sign-off: a blocking finding still unanswered when a person signed off is carried as decided by that person, with the sign-off note as its reason. Because each review keeps its own copied list, following review B also brings what B inherited from A: no chain is walked at submit, and a missing or deleted earlier review cannot break anything later.
6. **A budget for the history.** Each carried item is cut to 200 characters of claim, 120 of place and 300 of reason; a sign-off note to 300. The whole rendered history (older rounds and carried decisions together) is at most 12,000 characters and 40 items. When it does not fit, the oldest items are dropped first, and the prompt and the result say how many were left out. The last round, shown in full as today, is outside this budget: it is bounded by that round's own findings. An item answered as a repeat (step 9) is stored as its original, so the same decision never takes two places.
7. **How the reviewer is told.** A section "Decided earlier" with the rule from step 2.
8. **Marking a repeat.** The reviewer output gets an optional `repeats` field naming the earlier finding (for example `rv_01m8e7zq.../r1.f3`). A finding marked as a repeat blocks only if it is critical, or high and certain; otherwise it is advisory, shown next to the earlier decision. A valid id is one of the decisions shown in that round's prompt (the last round, older rounds and carried history, after the budget). An id that is not among them is ignored: the finding follows the ordinary rule, and the result notes the bad reference.
9. **Unmarked repeats.** A reviewer can repeat a point in other words and leave `repeats` out; review-bus cannot tell reliably on its own. So the author gets a cheap answer for it: `review_respond` status `repeat` with the earlier finding's id. It counts as rejected, with the earlier reason copied, and needs no new argument. The id must be one of the decisions shown in the round that raised the finding; any other id refuses the whole answer before anything is saved. The result counts marked, model-found and author-reported repeats.
10. **A model call catches unmarked repeats.** After the reviewers finish and before blocking slots are given out, one call to a model (the same kind of call as the existing model merge of duplicate findings) compares the round's blocking candidates with the decisions shown in the prompt. A candidate it matches is treated as marked with `repeats` (step 8). It costs one call per round, and only when there are decisions to compare. If the call fails, the round goes on under the ordinary rule, with a note.
11. **A hint instead of guessing.** No automatic linking. When a new review's document has the same file path or file name as a recent closed review, the submit result adds a note: "rv_... reviewed a file of the same name on <date>; pass follows to carry its decisions." The agent decides.

### Decided (Mitja, 27 Nov 2026)

- Unmarked repeats: a model call catches them (step 10), not only the author's `repeat` answer.
- A sign-off settles the blocking findings still unanswered: the next review carries them as decided (step 5).
- `follows` carries accepted findings too, to check they did not come back (step 5).
- A deferred finding may come back, as an advisory reminder only (step 2).
- Hosted mode later: `follows` must check that the earlier review belongs to the same account.

### Still to settle before code (Codex, rv_01m8ecp4s3fpedvnpq3py3qxsb round 3)

- A last round with many long findings can still make the prompt large: cut its fields too, or give it its own budget.
- `request.inherited` is stored in review.json: copy only what fits the budget (40 items), not everything the earlier review had.
- When two reviewers raise the same point and their findings are merged, one marks it as a repeat and the other does not: say which wins (proposed: the merged finding is a repeat only if every reviewer that raised it marked the same earlier decision).

### Tests (with fakes)

- Round 3's prompt lists findings rejected and deferred in round 1, and the rule covers deferred ones. (Done: `test/prompt.test.ts`, `lifecycle.test.ts`.)
- The repeat check: a fake model marks one candidate as a repeat (advisory) and leaves another (blocks); a failing call leaves the ordinary rule with a note.
- A sign-off with an unanswered blocking finding: the next review carries it as decided by the person; accepted findings are carried as "check it did not come back".
- A review with `follows` gets the earlier decisions; following B brings what B inherited from A; the list does not change when B changes later.
- `follows` is refused for an unknown id and for a review that is preparing, in review, waiting for answers, failed or canceled, and for a different artifact kind, before anything is saved.
- Budget: an oversized claim, place, reason and sign-off note are cut; a history over 12,000 characters or 40 items drops the oldest and reports how many.
- A finding marked `repeats` is advisory unless critical or high and certain. An unknown id, or one dropped by the budget, leaves the finding under the ordinary rule with a note. An unmarked repeat blocks as before, and the author's `repeat` answer closes it with the earlier reason; an author `repeat` with an id not shown in that round is refused and saves nothing.
- A decision answered as a repeat and carried on is stored once, as its original.
- The same-name hint appears for a closed review of the same file and not for an open one.
