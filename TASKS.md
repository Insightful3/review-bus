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

- [ ] Known limits from the self-review (README "Known limits"): reviewer reads outside the snapshot, page redirects to private addresses, reviewers outliving a killed runner.
- [x] Decided (25 Nov 2026): agents with terminal access may run `rb signoff`; no extra confirmation.
- [ ] Return the review_id before slow page capture (self-review round 2, f10). Trade-off: snapshot errors would then arrive as a failed review, not as an error on review_submit.
- [ ] Optional `model` for Codex in `~/.review-bus/config.json`: reviewers ignore `~/.codex/config.toml` now, so they use Codex's default model.
- [ ] Optional `codex exec review` native pass (SPEC 8)
- [x] MCP Tasks, 2025-11-25 form (task-capable submit, respond, wait; tested with the SDK client)
- [x] Claude Code waits for the finished review in one call: progress notifications every 10 s keep the call alive (checked with Claude Code 2.1.316 and a 70 s review)
- [ ] 2026-07-28 Tasks extension, if Claude Code ever needs it over stdio: the v2 SDK 2.4.0 serves 2026-07-28 over HTTP only
- [ ] HTTP transport, web inbox, pull-mode reviewers (v0.2+)
