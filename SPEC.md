# Review Bus v0.1 build spec

Goal of v0.1: one full review loop on real work, for one user on one machine. An author agent (Claude Code or Codex) submits a code change or a document, Codex and/or Claude review it headless, the author answers each finding, and the review closes or goes another round.

## 1. Scope

In v0.1:

- MCP server over stdio (HTTP later)
- Artifacts: git changes (uncommitted, branch vs base, single commit), documents (Markdown, plain text, DOCX, PDF from a local path), and web pages (rendered and screenshotted, alone or together with a git change)
- Reviewers (push mode, headless, read-only): Codex CLI, Claude Code CLI, generic command (for tests and custom reviewers)
- Rubrics as Markdown files: `code`, `contract-b2b`, `proposal`, `webpage` first; then `client-email`, `linkedin-post`, `sop`, `plan`
- Lifecycle with rounds (max 3), author responses, human sign-off where policy requires it
- Risk policy that computes which findings block
- Storage under `.reviews/` (one folder per review, JSON state + `report.md`)
- CLI `rb` for humans: `submit`, `status`, `show`, `list`, `respond`, `signoff`, `cancel`. `submit` and `respond --resubmit` run the round in the CLI process and wait for it (Ctrl-C cancels). Exit codes: 0 approved or awaiting sign-off, 2 changes requested, escalated or failed, 1 error. The author is a person (`vendor_source: "person"`), so no reviewer is skipped for vendor.
- `related` documents (up to 3) on `review_submit`: converted like documents, given to reviewers for comparison only (for example the accepted proposal for a contract), and part of the snapshot hash.
- Tool calls wait at most `max_wait_seconds` (default 50): MCP clients usually time out after 60 seconds.

Not in v0.1: hosted mode, web inbox, pull-mode reviewers (`list_pending`/`claim`/`post`), Gemini adapter, MCP Tasks, channels, GitHub sync, verification pass.

Added in v0.2 (25 Nov 2026): pull reviewers (8b), MCP over Streamable HTTP and a web inbox (8c), rubric packs (7a), Codex's native review as a reviewer type (8), and the review id before slow page capture (3). Still not in: hosted multi-user mode, a Gemini adapter, channels, GitHub sync, a verification pass.

## 2. Lifecycle

States: `submitted` (only while a review with pages takes its first snapshot in the background, see 3) → `in_review` → `changes_requested` | `awaiting_signoff` | `approved` | `escalated` | `failed` | `canceled`, plus `needs_input` (reserved for pull reviewers later).

- A round runs all configured reviewers on one frozen snapshot, in parallel.
- After a round: if no open blocking finding → `approved`, or `awaiting_signoff` when the policy requires a person. Otherwise `changes_requested`.
- The author answers every blocking finding with `accepted`, `rejected` (reason required) or `deferred`. Then either closes the review or resubmits a new snapshot (round n+1).
- After round 3 with blocking findings still open → `escalated` (a person decides).
- If the server restarts while a round is running, that round is marked `failed` on load.

Rules settled while building slice 2:

- Answers can come in several `review_respond` calls. A finding id must belong to the latest round.
- Closing (`resubmit: false`) happens once every blocking finding has an answer: `approved`, or `awaiting_signoff` when the rubric requires a person. If any blocking finding was `accepted` but not re-reviewed, the review gets a note saying so.
- Resubmitting is allowed from `changes_requested` and `failed`, never from `escalated`, `awaiting_signoff`, `approved` or `canceled`. If the new snapshot is identical to the previous one, the history says so.
- The next round's prompt lists the previous round's findings with the author's answers. Reviewers check that accepted findings are fixed and do not raise a rejected finding again unless the reason does not hold.
- Sign-off works from `awaiting_signoff` and from `escalated` (a person deciding after the round cap) and records who, when, and from which state. It is only in `rb signoff`, not an MCP tool. Decided by the owner (25 Nov 2026): an agent that can run commands in the owner's terminal may also run `rb signoff`; `rb signoff` asks for no extra confirmation. The sign-off record names whoever was given in `--by`.
- An author cannot close a round as approved while one of its reviewers failed; the answers are kept, and a resubmit runs the reviewers again (or a person signs off).
- `review_cancel` kills the running reviewer processes.
- A round that finishes after a newer round has started (possible after a restart) keeps its results but does not change the review state.

## 3. Snapshots

- **Git:** record base SHA plus a patch of the change (`git diff` vs base, including untracked files, which are added as new-file patches without touching the index). The reviewers' copy is every tracked file of the base, written into `r<n>/tree/` through a temporary index outside the repo (`git read-tree` + `git checkout-index`; not `git archive`, which drops `export-ignore` files), with the patch applied. Patches are kept as bytes, so non-UTF-8 files arrive unchanged. Every git call is hardened against the reviewed repo's own config, which can name commands: attributes come from the empty tree (`--attr-source`, git 2.40+), so no clean/smudge filters or diff drivers run, and `core.fsmonitor` is off (self-review round 3; a test arms all three in a repo and checks none runs). Approvals are checked again right before each reviewer is started. Chrome runs with its sandbox on. This replaces the throwaway `git worktree` of the first draft: nothing is written to the author's `.git` (no worktree entries left behind after a crash, no refs). Store the patch in the review folder. Modes: `uncommitted` (working tree vs HEAD), `base` (merge-base of the base branch and HEAD, to HEAD; commits only, uncommitted edits are noted and left out; base defaults to `origin/HEAD`, then `main`, then `master`), `commit` (one commit vs its parent, or vs the empty tree for a root commit), `all` (the whole project at HEAD vs the empty tree, for reviewing a codebase). Lockfile and binary diffs are left out of the prompt text (they are in `tree/`). The prompt gets the changed files and the diff (up to 120,000 characters; beyond that reviewers read the files in `tree/`).
- **Pages:** `review_submit` takes `pages`, a list of http(s) URLs (for example the author's local dev server). The server, not the reviewer, renders each page in headless Chrome (Playwright with `channel: "chrome"`, so no browser download) at desktop (1366px) and mobile (390px) width. Screenshots are cut into tiles 1800px tall so text stays readable for the model, up to 16,000px per page by default (`browser.max_height`; real mobile home pages run to about 15,000px; the report says when a page is cut off). The server also records the facts a screenshot cannot show: HTTP status, title, meta description, `lang`, canonical, social tags, headings, images without alt text, broken same-origin links (up to 40 per page) and console errors. Codex gets the screenshots with `--image=<file>`; Claude opens them with its read tool (they are inside its working folder); command reviewers get their paths in `REVIEW_BUS_IMAGES`. Pages are captured again on resubmit. The dev server must be running; review-bus never starts the author's code.
- **Review id before slow capture (v0.2):** a new review with pages is saved first (state `submitted`, with the process taking the snapshot in `preparing`) and its snapshot runs in the background. `review_submit` waits `snapshot_wait_seconds` (default 10) for it: a snapshot that fails within that time is an error on submit and nothing is kept, as before; a slower one returns the review id, and a later failure makes the review `failed` with the reason in its notes. Another process marks a `submitted` review failed only when the process taking its snapshot is gone (by process id alone: page capture has no reviewer timeout to bound it). A plain `review_submit` without progress counts the time spent before the review id existed against `max_wait_seconds`, and the snapshot wait itself never runs past the call's remaining `max_wait_seconds`. Resubmits still capture before returning.
- **Document:** copy the file into the review folder, record its SHA-256, convert to Markdown (DOCX via `mammoth` HTML output and a small converter that keeps headings, lists and tables; PDF via `pdftotext` if present, else `unpdf`, with a `## Page N` heading per page). Reviewers get the Markdown. Conversion warnings (for example a PDF with no text, likely scanned) are recorded on the snapshot and shown in the report. OCR is not supported.
- **Document as text (v0.2):** `review_submit`'s `artifact`, each `related` item and `review_respond`'s `artifact` may be `{name, content}` instead of a path (a git change may not carry other keys, so text next to it is refused, not dropped), for authors that do not share the server's disk (chat apps, sandboxes such as Cowork's). Only `.md`, `.markdown` and `.txt` (no extension means `.md`); a plain file name, no folders, not starting with a dot; at most 1,000,000 characters, not blank. Every text is checked before anything is written. The review is saved first (state `submitted`, with the process taking the snapshot in `preparing`, as for pages), then the text is written to `source/<round>/NN/<name>` in the review folder (owner-only) and snapshotted like any document, so a process stopped at any point leaves nothing or a review that recovery finds; the request records the path with `inline: true`, and the report shows the name with "(sent as text)". A resubmit without a new `artifact` reviews the same text again; one with text writes it into a folder made for that attempt alone (`mkdtemp`, files created exclusively), removed again if the round does not start. The text, any half-made snapshot and any unrecorded round folder are removed (under the review's lock) when a review fails or is canceled before its first round, also when another process finds the one taking the snapshot gone; every failure before a review id is given out removes the whole review folder, and a round moved into place whose save then fails is taken back out. Because a process can stop between any two steps, this cleanup is retried whenever a review is looked at: a failed or canceled review with no round loses any text or snapshot left behind, and a review with rounds keeps only the text its rounds and request name, plus resubmit attempts (folders `r<n>-<pid>-...`) whose process is alive. Text is kept once its review is saved, whether or not the client received the review id (an interrupted call still leaves the review in `review_list` and the inbox). `REVIEW_BUS_LOG` logs `artifact` and `related` from an allowlist (a path, a git change's `repo`, `mode`, `base` and `commit` as short text, or a text's name and length); any other shape is logged as `[redacted]`, also for refused calls, and the log is created with mode 600. Over HTTP an MCP request may be up to 32 MB (enough for every call the schema accepts); a larger declared length gets a 413 with the reason at once, a larger streamed body gets it after the body (up to 64 MB; beyond that the connection is closed).
- A finding always refers to the snapshot of its round, even if the author keeps editing.

## 4. MCP tools (v0.1)

| Tool | Input | Output |
| --- | --- | --- |
| `review_submit` | `artifact` (path, or `{git: {repo, mode: uncommitted|base|commit, base?, commit?}}`), `rubric`, `intent`, `assumptions[]`, `criteria[]`, `reviewers[]` (names or `{name, model?, effort?}`; default from config, filtered by vendor, see 8a), `author_vendor?`, `stage` (draft|pre-merge|release), `wait_seconds` (default 0) | `review_id`, state; full result if it finished within `wait_seconds` |
| `review_status` | `review_id` | state, round, reviewers done/pending, counts of blocking and advisory findings |
| `review_wait` | `review_id`, `seconds` (max 600) | blocks until the round finishes or time runs out, then returns status |
| `review_result` | `review_id`, `include_advisory` (default false) | verdicts and findings for the latest round, as JSON plus a short Markdown summary |
| `review_respond` | `review_id`, `responses[]` of `{finding_id, status, note}`, `resubmit` (bool), optional new artifact | new state; starts round n+1 when `resubmit` is true |
| `review_list` | optional state filter | recent reviews |
| `review_cancel` | `review_id` | `canceled` |

Long rounds run in the background inside the server process.

Added in v0.2: `review_rubrics` (names, purpose, pack, confidential, require_signoff), and for pull reviewers (8b) `review_pending`, `review_claim`, `review_post`, `review_release`.

**MCP Tasks.** `review_submit`, `review_respond` and `review_wait` accept task-augmented calls in the 2025-11-25 form (`execution.taskSupport: "optional"`, `tasks/get`, `tasks/result`, `notifications/tasks/status`): a task call returns at once and completes when the round finishes; plain calls behave as before. The SDK gives the tool handler no way to tell the two apart, so the server notes which request ids carried `params.task` at the transport.

Checked on 25 Nov 2026 with `REVIEW_BUS_LOG`: Claude Code 2.1.316 does not use this form. It opens with `server/discover` on protocol 2026-07-28 and declares tasks only as the extension `io.modelcontextprotocol/tasks`, then falls back to 2025-11-25 and calls the tools plainly. In the 2026-07-28 Tasks extension the server decides per request to answer with `resultType: "task"` when the request declares the extension, and implements `tasks/get`, `tasks/update` and `tasks/cancel` (optionally `notifications/tasks` after `subscriptions/listen`). The v2 SDK (`@modelcontextprotocol/server` 2.4.0) implements 2026-07-28, but only over HTTP (`createMcpHandler`): on stdio both its server and its client negotiate 2025-11-25, and `server/discover` is turned away (checked 25 Nov 2026). Declaring the Tasks extension on a 2025-11-25 connection does not change Claude Code's behaviour either.

**Progress instead of tasks.** Claude Code sends a `progressToken` with every tool call. When a call carries one, review-bus sends `notifications/progress` every 10 s (reviewers done and still working) and waits up to `max_wait_with_progress_seconds` (default 900) instead of `max_wait_seconds`. Checked with Claude Code 2.1.316: `review_submit` with `wait_seconds: 600` stayed open through a 70 s review and returned the finished result in one call. This replaces polling for Claude Code; tasks remain for clients that use the 2025-11-25 form.

## 5. Data shapes

Reviewer output (what each adapter must return, validated with zod):

```json
{
  "verdict": "approve | changes_requested | comment",
  "summary": "one paragraph",
  "findings": [
    {
      "claim": "string",
      "failure_scenario": "string or null",
      "evidence": "string",
      "location": {"path": "string or null", "line_start": "int or null", "line_end": "int or null", "section": "string or null", "quote": "string or null"},
      "likelihood": "certain | likely | possible | remote",
      "impact": "critical | high | medium | low",
      "suggested_fix": "string or null",
      "assumption_challenge": "bool",
      "confidence": "number 0..1"
    }
  ]
}
```

For Codex `--output-schema`, the JSON Schema must use `additionalProperties: false` on every object and list every property in `required` (use `null` types for optional values). Generate the JSON Schema from the zod schema and keep one source of truth in `spec/`.

Server-added fields per finding: `finding_id`, `reviewer` (adapter:model:effort, see 8a), `round`, `blocking` (bool, computed), `severity` (derived), `agreement` (how many reviewers raised it), `response {status, note, at}`.

## 6. Risk policy

Default matrix (impact × likelihood → blocks?):

| Impact | Certain | Likely | Possible | Remote |
| --- | --- | --- | --- | --- |
| Critical | block | block | block | block |
| High | block | block | block | advisory |
| Medium | block | block | advisory | advisory |
| Low | advisory | advisory | advisory | advisory |

Rules:

- A finding with no `failure_scenario` is advisory, whatever the reviewer said.
- `assumption_challenge: true` findings are always shown. High and critical ones go through the matrix like any finding and can block (decided 25 Nov 2026 after a real contract review where "no governing law", raised as a challenge to the author's "Slovenian law", came out advisory). Medium and low ones never block on their own.
- Max blocking findings per round: 5 (highest risk first), or `max_blocking` from the rubric's front matter (`contract-b2b`: 12). Findings that would block on their own but are over the limit are marked `over_limit`, counted in `counts.over_limit`, shown in a section "Over the limit (would block)" in the report and included in `review_result` without `include_advisory`. They need no answer in that round. Added 25 Nov 2026 after the real contract review with the Insightful3 rubric: with a limit of 5, ten findings that would block, governing law among them, showed as plain advisory.
- Later rounds (v0.3, `policy.later_rounds`, default `stricter`): from round 2 only critical findings, and high ones that are certain or likely, block; medium and low are advisory, and a rubric's `high_blocks_always` applies to round 1 only. Draft stage is unchanged (only critical). Each round stores the rule it started with in its policy; rounds started before the setting existed keep the old rule. `same` applies the round 1 table to every round. Decided 26 Nov 2026 after the first real use of 0.2.1: in a contract review (11, then 4, then 3 blocking findings) and a code review, rounds 2 and 3 mostly reacted to the previous round's fixes. The first idea (high or critical, or about text changed since the last round) would have changed neither review. The reviewer prompt for later rounds also asks to look for problems the fixes introduced and to rate new findings as in a first round.
- `stage: draft` uses a lighter matrix (only critical blocks).
- Duplicate findings across reviewers (same location, similar claim) are merged; `agreement` counts the reviewers and `also_raised_by` keeps the other versions. The highest-risk version is kept. Word-based matching only merges near-identical findings: on real Codex and Claude reviews of the same proposal it caught 1 of 5 shared problems, and lowering its thresholds would merge unrelated findings. So `merge_with` in config names a cheap model (for example Claude Haiku, low effort) that groups findings by meaning; its answer is validated (every id at most once, never two findings from one reviewer in a group) and on any failure the word-based rules are used and the round records why. For a rubric with `allowed_reviewers`, the merge model runs only if it is on that list, because it sees the quotes. Merging happens before the policy decides what blocks.
- Policy lives in `review-bus.config.json` and each rubric can override it.

Contract rubric overrides (`contract-b2b`):

- `require_signoff: true` (a person must sign off; agent approval alone never closes it)
- High and critical findings block at any likelihood
- Report header states that reviewers are not lawyers and this is not legal advice

## 7. Rubrics

Markdown files, each with: purpose, what to check, what is out of scope, impact anchors, policy overrides (front matter).

Rubrics are loaded from several folders, in order, with later folders overriding earlier ones by rubric name. Configured as `rubric_paths` in `review-bus.config.json`, for example `["~/.review-bus/rubrics", "~/clients/acme/rubrics"]`. Generic rubrics ship in this repo's `rubrics/`, which always comes first; client-specific rubrics live in a private folder of your own.

- `code`: correctness, security, data loss, missing tests for changed behaviour. Out of scope: style the linter handles, naming preferences.
- `contract-b2b`: parties and registration details, scope and deliverables, price, payment terms and late interest, term and termination, liability cap and exclusions, IP ownership and licence, confidentiality, data protection (DPA needed when personal data is processed), governing law and jurisdiction, defined terms used consistently, numbers and dates consistent across clauses and annexes. Optional `related` artifact: the accepted proposal; any mismatch in price, scope or timeline is high impact. Assumptions should include jurisdiction and language (for example Slovenian law, Slovenian text).
- `proposal`: the client understands what they get, by when and for how much; no promise the author can't keep; dates that depend on the client are stated as such; price and terms match.

Document impact anchors: critical = wrong price, legal commitment, wrong client or leaked confidential data; high = wrong fact or misleading claim the reader acts on; medium = unclear ask or wrong tone for the audience; low = style.

## 7a. Rubric packs (v0.2)

A rubric pack is a folder of rubrics shared as one unit (one client's rubrics, a team's), listed in `rubric_packs`. Its name comes from `pack.json` (`name`, `description`, `version`), else the folder name; names are lowercase letters, digits and dashes, and two packs cannot share one. Pack rubrics are only reachable as `pack/rubric`; plain names keep resolving through `rubric_paths`, so a pack never silently replaces a rubric. `allowed_reviewers` is looked up by the full name, then by the base name (`acme/contract-b2b`, then `contract-b2b`). `rb rubric-check <file|folder>` and `checkRubric` report missing sections, missing impact levels, front matter of the wrong type, unknown front matter keys and em dashes; every rubric this repo ships passes it (a test checks).

## 8. Adapters

Configured in `review-bus.config.json`, not hard-coded. Each adapter: command, args template, timeout, how to read the output.

- **Codex, documents and code with rubric:** `codex exec` in read-only sandbox, prompt on stdin, `--output-schema <schema.json>`, `-o <out.json>`, working dir = worktree (code) or the review folder (documents).
- **No inherited git variables:** every git call (snapshots, the codex-review scratch repo) and every reviewer process runs without the `GIT_*` variables of review-bus's environment, which a git hook or shell could set to point git at another repository (found by review-bus reviewing v0.2 with Codex).
- **Codex, native code review (optional, `type: "codex-review"`, v0.2):** git changes only. Checked on codex-cli 0.172.0: `codex exec review` takes no prompt together with `--uncommitted`, has no `--cd` and ignores `--output-schema` (it answers in text with `[P0]` to `[P3]` comments). So the adapter copies `r<n>/tree` into `r<n>/<name>.native`, makes it a git repo (copied with symlinks kept verbatim; the index starts as the changed project, with `add -f` so tracked files that `.gitignore` matches are included, plus the changed submodule pointers from the patch's `+Subproject commit` lines; the base is made by reverse-applying the patch through the index and committed; the change applied again with `--index`, so it is staged; global and system git config ignored; `.git/info/attributes` switches off filters and line-ending conversion, because `--attr-source` crashes git 2.54 in a repo without commits), runs `codex exec review --uncommitted` there under the same isolation flags and read profile as `codex`, then converts the text with an ordinary `codex exec` pass using the reviewer output schema. The reported model and effort are those of the review pass. Off by default: name it, or add it to `default_reviewers`.
- **Antigravity CLI (`type: "agy"`, v0.3):** checked on agy 1.5.18. `agy -p <instruction> --output-format json --json-schema <file> --sandbox --disable-slash-commands --settings <deny rules>` with `--model` and `--effort` when set, started in the round folder with empty stdin. The answer is a JSON string in the envelope's `response`; agy was seen to print a schema-invalid attempt on the line before the valid one, so the adapter takes the whole response, else its last line that parses. `--mode plan` returned no answer headless (the model reached for a shell command, which headless mode denies), and the default mode wrote a file when asked, without a prompt, even with `--sandbox`. So the adapter passes deny rules for `write_file(/)`, `command(regex:.*)` and `mcp(*)`: in agy deny wins over allow, checked with allow rules for the same actions present. The prompt is written to `agy-prompt.md` in the round folder (mode 600) and `-p` only tells agy to read it with its file viewer: process arguments are visible to other users of a machine (Codex review of v0.3, r3.f1) and limited in size. agy reports no model, so the requested one is recorded. Vendor `google`.
- **Claude:** `claude -p` with `--output-format json`, `--json-schema <schema>`, `--tools Read,Grep,Glob`, `--permission-prompts none`, `--restricted` (no command tools, user and project settings ignored, file tools confined to the working dir), `--strict-mcp-config`, `--no-session-persistence`, working dir as above. The answer is in `structured_output` of the JSON envelope; `is_error: true` fails the reviewer.
- **Codex reads are confined:** instead of `--sandbox read-only`, a permission profile passed with `-c` (`permissions.review-bus.filesystem`: `:root` deny, `:minimal` read, temp folders deny, `:workspace_roots` `"."` read; selected with `default_permissions`). The workspace root is the round folder (`--cd`). Nothing is writable. Profiles and `--sandbox` do not combine, which is why `--sandbox` is no longer passed.
- **Codex as a reviewer is isolated:** `--ignore-user-config` (the user's MCP servers, some of which run code or control the computer, are not loaded; login still works), `--disable` for `apps`, `plugins`, `remote_plugin`, `computer_use`, `browser_use`, `browser_use_external`, `hooks` and `image_generation`, and `-c web_search="disabled"`. Checked on codex-cli 0.172.0 by listing the tools a reviewer can call: without these flags it could reach `node_repl`, `cua_repl` and ChatGPT apps, none of which the read-only sandbox covers. Found by review-bus reviewing itself with Codex.
- **Codex as the author:** `codex exec` refuses MCP tool calls unless the server's tools are approved. Set `default_tools_approval_mode = "approve"` on the review-bus server (Codex 0.172.0 accepts `auto`, `prompt`, `writes`, `approve`).
- **Command:** any executable that reads the review prompt on stdin and prints reviewer output JSON on stdout. Used by tests with a fake reviewer.

Check the real flags with `--help` on this machine before relying on them.

The reviewer prompt contains: rubric, intent, assumptions, criteria, artifact (Markdown or the worktree), output rules (failure scenario required, use the fixed scales, quote exactly). It never contains the author's conversation.

## 8b. Pull reviewers (v0.2)

An adapter with `type: "pull"` has no command. Its run starts as `waiting` with a `deadline` (its `timeout_seconds`; default 3 days for pull adapters). Anyone with access claims it (`review_claim`, `rb claim`, the inbox): approvals are checked against the config on disk at claim time, `claim_clients` (MCP client names) limits who may claim, and the claim records who (`by`), from which client, when, and a random token. The claim returns the round's `prompt.md`, the files (the Markdown, the project copy, screenshots, related documents), the reviewer output JSON Schema, and for people the brief and rubric on their own. `review_post` takes reviewer output JSON (validated with the same zod schema) or `decline` with a reason; the token must match (constant-time). `review_release` returns a claimed run to `waiting`; it needs the claim's `claim_id` (a random id per claim, returned by the claim and by `review_pending`) on every transport, so a repeated release cannot drop a newer claim, even one made in the same millisecond. If the inbox cannot build the page that hands a person their token, it releases the claim again. An answer after the deadline is refused under the lock, whether or not anyone noticed the deadline before. Tokens are redacted from `REVIEW_BUS_LOG`. MCP task calls complete when the round ends or only pull reviewers are left (a task lives 2 hours; a pull reviewer may take days), and results, status and waits then carry `waiting_for_pull` and a `next` hint.

The round no longer needs one process from start to end. The runner process runs the push reviewers and then tries to finish the round; whichever process records the last answer (a post, a missed deadline noticed on load) finishes it. Finishing is claimed under the lock (`round.finalizing`, the process doing it), so only one process merges and decides. A round counts as cut off (marked `failed` on load) only when its runner and its finisher are both gone and it is not merely waiting for pull reviewers. A round whose reviewers have all answered but whose finisher is gone (or never started) is finished by the next process that loads it, and is never marked cut off, so saved answers are not lost. When only pull reviewers are left, `review_status` and the wait tools return `waiting_for_pull` and a `next` hint to check back later. Waits (`review_wait`, `review_submit` with `wait_seconds`, `rb submit`) return as soon as only pull reviewers are left. The claim token never appears in results, reports or inbox pages; it is stored in `review.json`, which the inbox never serves.

## 8c. MCP over HTTP and the web inbox (v0.2)

`rb serve` runs one process with one Engine, MCP over Streamable HTTP at `/mcp` (one MCP session per client, each with its own server instance and author detection) and the web inbox at `/inbox`. Config `http`: `host` (default `127.0.0.1`), `port` (7777), `token_file` (created with 32 random bytes, mode 600), `allow_remote` (required to listen beyond loopback), `allowed_hosts`. `/mcp` needs `Authorization: Bearer <token>`. Every request's `Host` must be a loopback name or an allowed host with the server's port, and an `Origin`, if sent, must match: this blocks DNS rebinding and other sites' pages. The inbox logs in with a form post of the token and gets a random session id (12 hours, in memory) in an `HttpOnly`, `SameSite=Strict` cookie named `rb_session_<port>`; never the token itself, because cookies ignore ports and other services on the same host name would receive it. `rb.localhost` is accepted as a loopback name and recommended: a cookie set for it is not sent to `localhost` or `127.0.0.1`. A request target the URL parser rejects gets a 400; pages are server-rendered, every value is escaped, and the Content Security Policy allows only same-origin scripts and images (one small script adds finding rows). The referrer policy is `same-origin`, because with `no-referrer` browsers send `Origin: null` on form posts. The inbox lists waiting pull work, reviews awaiting sign-off or escalated, and recent reviews; shows a review's report and screenshots; lets a person claim, answer (findings form), decline, release, and sign off (same trust as `rb signoff`). It serves only files recorded in a round's snapshot (the Markdown, related documents, screenshots), as regular files reached without a symlink, so never `review.json` or the project copy. An `Origin`, when sent, must equal the request's own host and port (SameSite cookies ignore ports). A release from the inbox names the claim it saw (`claim_id`), so an old page cannot drop a newer claim. The decision list shows every review awaiting sign-off or escalated, however old. A post that arrives with an expired session is kept in a page that asks for the token and is then processed as sent, also when another tab renewed the session meanwhile. A new MCP session first takes the slot of the oldest idle one; With all session slots busy (`REVIEW_BUS_MAX_SESSIONS`, default 100), a new MCP session gets 503 with `retry-after`. The `Secure` cookie flag is set by the public HTTPS Host or Origin. Behind an HTTPS `public_origin` the session cookie is `Secure`. MCP sessions with no open request are closed after an hour idle (`REVIEW_BUS_SESSION_IDLE_MS`), and at most 100 are kept. Front matter lines must be flat `key: value` (or blank, or `#` comments); anything else is an error, so an indented `confidential: true` cannot be dropped silently. A claim reads everything it returns before it is saved, and is refused past the deadline. Approvals at claim, dispatch and the merge model use the rubric as saved, but confidential if the rubric is confidential now (looked up with the rubric folders and packs of the config as it is on disk now), or cannot be loaded now (fail closed). A review folder is made owner-only before the snapshot writes into it. `review_file` serves only the claimed round's files, checks the reviewer's approval again on every call, and returns at most 10 MB (larger files: the inbox, which streams them). Listings (the inbox) record missed pull deadlines and finish settled rounds whose finisher is gone as they scan. A round reads the config once at dispatch and builds the prompt and checks approvals from that same rubric. Resubmission follows the round cap the last round ran under; status reports it too. Posting a pull answer waits for a busy review's lock without blocking the event loop (other lock waits still block briefly). Git snapshots record every submodule pointer after the change, and codex-review puts them all in its scratch index. An empty front matter block is valid. Front matter delimiters may carry trailing spaces or tabs; the closing one must be a line of its own. `rb post` reads the token from a hidden prompt, `REVIEW_BUS_CLAIM_TOKEN` or `--token-stdin`, never from argv. The git worker also writes `change.md`, so the full patch never passes through the server thread; the inbox reads all reviews in one asynchronous pass. An early snapshot failure removes the review under its lock, keeping a cancel that got there first; a cancel from any process also stops a merge started by the last pull answer. A resubmitted round takes `max_blocking` from the rubric as it is now. The last pull answer is saved at once; `review_post` and the inbox wait at most `max_wait_seconds - 5` for the round to finish (a merge model can be slow), and it finishes in the background either way. `review_file` serves a claimed reviewer the recorded snapshot files (screenshots as images) by `snapshot_files` path, for reviewers without the server's disk. `pdftotext`, and copying and hashing documents, run asynchronously. Only a SHA-256 of the claim token is stored. `review.json` and `report.md` are written with mode 600, and review folders are mode 700. Rubric front matter is validated on every load (types and known keys), not only by `rb rubric-check`. Git snapshots run in a worker thread, so a large change never blocks the server or delays the review id. Codex's native review uses one deadline (its `timeout_seconds`) for the scratch repo (copied by `cp -R -P` and built by git in subprocesses killed at the deadline or on cancel, a half-made copy removed; Codex is not started with less than 5 s left), the review and the conversion; quoted paths in patch headers are decoded; gitlinks are taken only from files git's headers mark as mode 160000. Each round stores the policy it started with (`max_blocking`, `max_rounds`), and whichever process finishes it applies that one. A round's runner clock starts at dispatch, after the snapshot. A leading byte order mark in a rubric is ignored. `http.public_origin` names the origin people use behind a TLS proxy; its host is accepted and posts from it are allowed. Git reviews in the inbox link the full patch (served as plain text). `server.ts` starts its stdio server only as the entry point, so `rb serve` importing it does not read stdin.

## 8a. Model, effort and reviewer vendor

Every adapter takes a `model` and an `effort`. Both are passed to the reviewer CLI as flags, recorded on every finding, and shown in `report.md`.

**Effort scale:** `low | medium | high | xhigh | max`. Both CLIs accept all five (Claude Code 2.1.316, Codex 0.172.0 for every current model). Codex also has `ultra` on some models; it is allowed in config for the Codex adapter only. An adapter rejects a value its CLI does not accept, with a clear error, before starting the round.

**How each adapter passes them** (checked with `--help` on this machine, 25 Nov 2026):

| Adapter | Model | Effort |
| --- | --- | --- |
| Claude | `--model <model>` | `--effort <level>` |
| Codex | `-m <model>` | `-c model_reasoning_effort="<level>"` (Codex has no effort flag; this is the config key `~/.codex/config.toml` uses) |
| Command | `{model}` and `{effort}` placeholders in `args`, plus env vars `REVIEW_BUS_MODEL` and `REVIEW_BUS_EFFORT` | same |

When `model` is null the flag is left out and the CLI uses its own default.

**Precedence** (first one set wins):

1. `review_submit` call: `reviewers` entries may be objects, `{name, model?, effort?}`, as well as plain names.
2. Rubric front matter: `effort: high`, and per adapter `models: {"codex": "...", "claude": "..."}` (model names are vendor specific, effort is not).
3. Stage default: `release` uses `high`, `draft` uses `medium`. `pre-merge` has no stage default.
4. Adapter config in `review-bus.config.json` (`model`, `effort`). The example config uses `effort: medium`.

The rubric wins over the stage, so `contract-b2b` ships with `effort: high` in its front matter and stays `high` even at `stage: draft`.

**What gets recorded:**

- The model and effort that actually ran, as the CLI reports them (Codex prints `model:` and `reasoning effort:` in its log; Claude's `--output-format json` names the model in the keys of `modelUsage` but does not report effort, so Claude's effort is always recorded as `requested`). If the CLI does not report a value, record the requested one and mark it `requested`.
- Each finding's `reviewer` field is `adapter:model:effort`, for example `codex:gpt-6.1-sol:high`. `adapter` is the adapter's name in config (so two command reviewers stay apart), and `default` stands for a CLI default that was not reported.
- Each reviewer run in `review.json` stores `model`, `effort`, and where each came from (`call`, `rubric`, `stage`, `config`, `cli_default`).
- `report.md` lists every reviewer as `adapter:model:effort` in the Reviewers section and on each finding.

**Reviewer vendor must differ from the author's:**

- Each adapter in config has a `vendor` (`anthropic`, `openai`, `other`).
- The server learns the author's vendor from the MCP `initialize` request (`clientInfo.name`), mapped through `author_vendors` in config. Built-in defaults: `{"claude-code": "anthropic", "codex-mcp-client": "openai", "local-agent-mode-*": "anthropic"}` (the names Claude Code 2.1.316 and Codex 0.172.0 send, checked with a probe server on 25 Nov 2026; the Claude desktop app, chat and Cowork, sends `local-agent-mode-<server name>`, seen 26 Nov 2026). A key ending in `*` matches by prefix; an exact key wins, then the longest prefix. `review_submit` also takes an optional `author_vendor` to set it explicitly.
- When `reviewers` is not given, the server uses only those `default_reviewers` whose vendor differs from the author's. If none is left, `review_submit` fails with an error saying so; it never falls back to a same-vendor reviewer silently.
- When the caller names `reviewers` explicitly, a same-vendor reviewer is allowed, but the result and `report.md` carry a note: "Reviewer is the same vendor as the author."
- If the author's vendor is unknown, the server uses `default_reviewers` as configured and notes "Author vendor unknown" in the report.

## 9. Security

- Reviewers run read-only, in a throwaway worktree or a copy of the document.
- Per-rubric `allowed_reviewers` in config: contracts only go to reviewers the user has approved for confidential data. Explicitly named reviewers outside the list are refused; default reviewers are filtered to the list. A rubric with `confidential: true` in its front matter (like `contract-b2b`) refuses to run until config lists its reviewers.
- Rubric front matter `report_notice` is shown at the top of the result and `report.md` (`contract-b2b`: reviewers are not lawyers, not legal advice).
- Optional masking of names and amounts before dispatch (v0.2).
- Artifact content is data; reviewer instructions only come from the prompt and rubric.

## 10. Storage

```
.reviews/
  rv_<ulid>/
    review.json      # full state: request, rounds, findings, responses, history
    r1/artifact.*    # snapshot (patch or document copy + markdown)
    r1/<reviewer>.json
    report.md        # human-readable, regenerated on every change
```

Location: `~/.review-bus/reviews/` for everything in v0.1 (configurable as `storage.documents`). The first draft put code reviews in `.reviews/` inside the reviewed repo; that would mean writing to the author's repo and its `.gitignore`, so it is left for later as an opt-in. Each git round holds a full copy of the project in `r<n>/tree/`, so large repos use more disk. Review results never go into the review-bus repo itself. Start with JSON files; add a SQLite index only when listing gets slow.

## 10a. Several server processes

Every read-change-write of a `review.json` holds a per-review lock shared by all processes: a `.lock` directory created atomically, with an owner file (pid, host, token). A lock is stale when its owner process is gone (same host) or after 120 s; taking over a stale lock happens under a short `.lock.steal` lock with a re-check, and a process only removes a lock holding its own token. `review.json` is the commit point; `report.md` is derived and a failure to write it does not fail the save. A round is built in a private `.staging-*` folder and moved into place under the lock. A background round error is recorded on the round, never left to crash the server. Reviewers run in their own process group; a cancel or timeout sends SIGTERM to the group, then SIGKILL after 5 s. Saves write a uniquely named temp file and rename it. A resubmit takes its snapshot without the lock, then adds the round only if the review is still in the state it was checked in; otherwise it removes the new round folder and reports that the review changed meanwhile. The process running a round checks the stored state every second, so a cancel from any process stops its reviewers.

Each agent session starts its own server process over stdio, and `rb` runs reviews in its own process, all sharing the same storage. Each round records its runner (`pid`, host, start time). A process that finds a review `in_review` that it is not running leaves it alone while the runner is alive, and marks it `failed` only when the runner is gone (or the round is older than the longest reviewer timeout plus 10 minutes, in case the pid was reused). `review_wait` on a review running elsewhere polls the stored state.

## 10b. Config

`review-bus.config.json` is looked up in this order: path in `REVIEW_BUS_CONFIG` (an error if that file does not exist, never a silent fallback), then `~/.review-bus/config.json`. Never the current folder: a config names commands to run. Approvals and `merge_with` are re-read from the file before each new round and merge (fail closed if it cannot be read). It holds `rubric_paths`, `storage`, adapters (each with `vendor`, `model`, `effort`), default reviewers, `author_vendors`, the risk policy and per-rubric `allowed_reviewers`. Ship an example as `review-bus.config.example.json`; the real one lives in the private repo or `~/.review-bus/`.

## 10c. Repo hygiene

- `test/fixtures/` holds made-up documents only (a fictional contract between two fictional companies, a fictional proposal, a small sample code change).
- `.gitignore` covers `.reviews/`, `review-bus.config.json`, `*.docx`/`*.pdf` outside `test/fixtures/`, and `.env`.

## 10d. Known limits (v0.1)

From review-bus reviewing itself with Codex (4 high-effort passes); open, listed in README:

- Reviewer reads: Codex runs under a read-restricted permission profile (round folder plus `:minimal` platform paths; home folder, other reviews, auth and temp folders denied) and Claude under `--restricted` (file tools confined to the round folder), both checked with canaries on 25 Nov 2026. Codex's `view_image` tool is confined too (checked: an image outside the folder fails with "Operation not permitted", one inside opens). Not covered: `command` reviewers and `:minimal` system paths. `npm run check:isolation` re-checks the Codex profile.
- Page capture: when the submitted page is public, requests to private addresses are blocked (listed as `blocked_requests`, with a warning) and a redirect hop into one refuses the capture. The redirected request itself is still made, and DNS rebinding is not covered. Submitted private pages (dev servers) are unrestricted.
- Reviewers outliving their runner: a watchdog per reviewer checks the runner every second and stops the reviewer group (SIGTERM, then SIGKILL after 5 s) when it is gone; it ignores SIGINT and SIGHUP so it outlives the runner. Checked: a reviewer ignoring SIGTERM stops about 6 s after `rb` is SIGKILLed.
- A new review returns its id before slow page capture (v0.2); a resubmit still captures pages before returning.
- Pull reviewers: without `claim_clients`, any connected MCP client can claim, the author's agent included; client names are self-reported.
- `rb serve`: one token opens everything (claim, post, sign-off), and the server speaks plain HTTP (loopback by default; TLS in front is needed for `allow_remote`).
- Reviewer selection, model and effort follow the config the server started with; only approvals and the reviewer's command are re-read before each round.
- A rubric's confidentiality is taken from when the review started, not re-read on resubmit.
- `rb signoff` cannot tell a person from a program running in the person's terminal. By the owner's decision this is accepted: agents with terminal access may sign off.

## 11. Done when

1. Tests pass with a fake command reviewer: document review, git review, respond and resubmit, round cap reaching `escalated`, contract needing sign-off, risk matrix cases.
2. From Claude Code: `review_submit` on a real contract with Codex as reviewer returns findings; responding and resubmitting works.
3. From Codex: the same tools work when Codex is the author and Claude is the reviewer.
4. README covers install, `claude mcp add` and `codex mcp add`, config, writing a rubric.
