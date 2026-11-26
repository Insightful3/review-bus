# v0.1 task list

Order follows "thinnest slice first, then widen". See `SPEC.md` for details.

## Slice 1: one document review loop (in progress)

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
- [ ] Hosted multi-user mode (accounts instead of one token), Gemini adapter, GitHub sync
- [ ] claude.ai web and phone without the desktop app: `rb serve` as a remote connector (a tunnel plus OAuth, since claude.ai connectors cannot send our bearer token)
- [ ] `rb submit -` reading the document from stdin

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
