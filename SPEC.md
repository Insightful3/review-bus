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

## 2. Lifecycle

States: `submitted` → `in_review` → `changes_requested` | `awaiting_signoff` | `approved` | `escalated` | `failed` | `canceled`, plus `needs_input` (reserved for pull reviewers later).

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
- **Document:** copy the file into the review folder, record its SHA-256, convert to Markdown (DOCX via `mammoth` HTML output and a small converter that keeps headings, lists and tables; PDF via `pdftotext` if present, else `unpdf`, with a `## Page N` heading per page). Reviewers get the Markdown. Conversion warnings (for example a PDF with no text, likely scanned) are recorded on the snapshot and shown in the report. OCR is not supported.
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
- Max blocking findings per round: 5 (highest risk first; the rest become advisory).
- `stage: draft` uses a lighter matrix (only critical blocks).
- Duplicate findings across reviewers (same location, similar claim) are merged; `agreement` counts the reviewers and `also_raised_by` keeps the other versions. The highest-risk version is kept. Word-based matching only merges near-identical findings: on real Codex and Claude reviews of the same proposal it caught 1 of 5 shared problems, and lowering its thresholds would merge unrelated findings. So `merge_with` in config names a cheap model (for example Claude Haiku, low effort) that groups findings by meaning; its answer is validated (every id at most once, never two findings from one reviewer in a group) and on any failure the word-based rules are used and the round records why. For a rubric with `allowed_reviewers`, the merge model runs only if it is on that list, because it sees the quotes. Merging happens before the policy decides what blocks.
- Policy lives in `review-bus.config.json` and each rubric can override it.

Contract rubric overrides (`contract-b2b`):

- `require_signoff: true` (a person must sign off; agent approval alone never closes it)
- High and critical findings block at any likelihood
- Report header states that reviewers are not lawyers and this is not legal advice

## 7. Rubrics

Markdown files, each with: purpose, what to check, what is out of scope, impact anchors, policy overrides (front matter).

Rubrics are loaded from several folders, in order, with later folders overriding earlier ones by rubric name. Configured as `rubric_paths` in `review-bus.config.json`, for example `["./rubrics", "../review-bus-private/rubrics"]`. Generic rubrics ship in this repo's `rubrics/`; client-specific and Insightful3 packs live in the private repo.

- `code`: correctness, security, data loss, missing tests for changed behaviour. Out of scope: style the linter handles, naming preferences.
- `contract-b2b`: parties and registration details, scope and deliverables, price, payment terms and late interest, term and termination, liability cap and exclusions, IP ownership and licence, confidentiality, data protection (DPA needed when personal data is processed), governing law and jurisdiction, defined terms used consistently, numbers and dates consistent across clauses and annexes. Optional `related` artifact: the accepted proposal; any mismatch in price, scope or timeline is high impact. Assumptions should include jurisdiction and language (for example Slovenian law, Slovenian text).
- `proposal`: the client understands what they get, by when and for how much; no promise the author can't keep; dates that depend on the client are stated as such; price and terms match.

Document impact anchors: critical = wrong price, legal commitment, wrong client or leaked confidential data; high = wrong fact or misleading claim the reader acts on; medium = unclear ask or wrong tone for the audience; low = style.

## 8. Adapters

Configured in `review-bus.config.json`, not hard-coded. Each adapter: command, args template, timeout, how to read the output.

- **Codex, documents and code with rubric:** `codex exec` in read-only sandbox, prompt on stdin, `--output-schema <schema.json>`, `-o <out.json>`, working dir = worktree (code) or the review folder (documents).
- **Codex, native code review (optional):** `codex exec review --uncommitted|--base|--commit --json -o out.md`, then a second pass converts its text into the finding shape. Off by default.
- **Claude:** `claude -p` with `--output-format json`, `--json-schema <schema>`, `--tools Read,Grep,Glob`, `--permission-prompts none`, `--restricted` (no command tools, user and project settings ignored, file tools confined to the working dir), `--strict-mcp-config`, `--no-session-persistence`, working dir as above. The answer is in `structured_output` of the JSON envelope; `is_error: true` fails the reviewer.
- **Codex as a reviewer is isolated:** `--ignore-user-config` (the user's MCP servers, some of which run code or control the computer, are not loaded; login still works), `--disable` for `apps`, `plugins`, `remote_plugin`, `computer_use`, `browser_use`, `browser_use_external`, `hooks` and `image_generation`, and `-c web_search="disabled"`. Checked on codex-cli 0.172.0 by listing the tools a reviewer can call: without these flags it could reach `node_repl`, `cua_repl` and ChatGPT apps, none of which the read-only sandbox covers. Found by review-bus reviewing itself with Codex.
- **Codex as the author:** `codex exec` refuses MCP tool calls unless the server's tools are approved. Set `default_tools_approval_mode = "approve"` on the review-bus server (Codex 0.172.0 accepts `auto`, `prompt`, `writes`, `approve`).
- **Command:** any executable that reads the review prompt on stdin and prints reviewer output JSON on stdout. Used by tests with a fake reviewer.

Check the real flags with `--help` on this machine before relying on them.

The reviewer prompt contains: rubric, intent, assumptions, criteria, artifact (Markdown or the worktree), output rules (failure scenario required, use the fixed scales, quote exactly). It never contains the author's conversation.

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
- The server learns the author's vendor from the MCP `initialize` request (`clientInfo.name`), mapped through `author_vendors` in config. Built-in defaults: `{"claude-code": "anthropic", "codex-mcp-client": "openai"}` (the names Claude Code 2.1.316 and Codex 0.172.0 send, checked with a probe server on 25 Nov 2026). `review_submit` also takes an optional `author_vendor` to set it explicitly.
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

- Codex's read-only sandbox does not restrict reads: a reviewer can read files outside the snapshot.
- Headless page capture follows redirects from a public page to private addresses.
- Reviewers in their own process group can outlive a runner that is killed outright.
- The review id is returned after the snapshot; slow pages can exceed client timeouts.
- Reviewer selection, model and effort follow the config the server started with; only approvals and the reviewer's command are re-read before each round.
- A rubric's confidentiality is taken from when the review started, not re-read on resubmit.
- `rb signoff` cannot tell a person from a program running in the person's terminal. By the owner's decision this is accepted: agents with terminal access may sign off.

## 11. Done when

1. Tests pass with a fake command reviewer: document review, git review, respond and resubmit, round cap reaching `escalated`, contract needing sign-off, risk matrix cases.
2. From Claude Code: `review_submit` on a real contract with Codex as reviewer returns findings; responding and resubmitting works.
3. From Codex: the same tools work when Codex is the author and Claude is the reviewer.
4. README covers install, `claude mcp add` and `codex mcp add`, config, writing a rubric.
