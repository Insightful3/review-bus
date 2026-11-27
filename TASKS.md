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
- [ ] A new review knows nothing about an earlier one on the same document. The deferral point came back in the second review although the author had rejected it with a reason in the first. Let a submit name an earlier review, so its rejected findings and their reasons go to the reviewer as already decided
- [x] `changes` in `review_respond` edits the copy review-bus keeps, not the author's file (by design: review-bus never writes to it). The author's file then lacks the change unless the author edits it too, which is easy to miss. Say so in the result ("sent as text; your file is unchanged"), and in the README
