# review-bus

A review layer for AI agents. An agent submits its work (a document, a code change or web pages), other agents review it, and the verdict comes back as structured state the author has to answer: every blocking finding must be accepted, rejected with a reason or deferred before the review can close or go another round.

It runs as an MCP server, so any MCP client can be the author. Claude Code and Codex are both supported as authors and as reviewers, and by default a review always goes to a model from a different vendor than the author.

Status: v0.1, working name. See `SPEC.md` for the design and `TASKS.md` for what is built.

## What it reviews

- **Documents:** Markdown, plain text, DOCX and PDF. DOCX and PDF are converted to Markdown first.
- **Code changes in a git repo:** uncommitted work, a branch against its base, or a single commit.
- **Web pages:** rendered in headless Chrome at desktop and mobile width. Reviewers get the screenshots plus page facts a screenshot cannot show (meta tags, missing alt text, broken internal links, console errors). Use it together with a git change to review a website change before it goes live.

## Requirements

- Node.js 22 or newer, and git 2.40 or newer
- At least one reviewer CLI, logged in:
  - [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`, then `codex login`)
  - [Claude Code](https://claude.com/claude-code) (`claude`)
- Google Chrome, for web page review (used headless through Playwright, so no extra browser download)
- Optional: `pdftotext` (from poppler) for better PDF text; without it a built-in converter is used

## Install

```bash
git clone <this repo> review-bus
cd review-bus
npm install
npm run build
npm test
```

The tests use fake reviewers, so they need no model login.

## Configure

Copy the example config and edit it:

```bash
mkdir -p ~/.review-bus
cp review-bus.config.example.json ~/.review-bus/config.json
```

The config is the file named in `REVIEW_BUS_CONFIG`, else `~/.review-bus/config.json`. It is never read from the current folder: a config names commands to run, and a cloned repo is not a trusted source of commands. Relative paths in it are resolved against the config file's folder.

| Key | What it does |
| --- | --- |
| `adapters` | The reviewers you can use, each with `type` (`codex`, `claude` or `command`), `command`, `vendor`, `model`, `effort` and `timeout_seconds` |
| `default_reviewers` | Used when the author names none. Reviewers from the author's own vendor are skipped |
| `allowed_reviewers` | Per rubric, the reviewers you approve for that kind of content. Required for confidential rubrics such as `contract-b2b` |
| `rubric_paths` | Extra folders with rubric files. Later folders override earlier ones by rubric name. This repo's `rubrics/` always comes first |
| `storage.documents` | Where reviews are stored (default `~/.review-bus/reviews`) |
| `author_vendors` | Maps MCP client names to vendors. `claude-code` and `codex-mcp-client` are built in |
| `browser` | Headless browser for page review: `channel` (default `chrome`), `executable_path`, `max_height` (default 16000 px) |
| `merge_with` | Optional. A cheap model that merges the same finding from several reviewers, for example `{"adapter": "claude", "model": "haiku", "effort": "low"}`. Without it, only near-identical findings are merged |
| `max_wait_seconds` | Longest a tool call waits before returning (default 50, under the usual 60 second client timeout) |
| `policy` | `max_blocking` findings per round (5) and `max_rounds` (3) |

## Connect an author agent

Point the agent at the built server, `dist/src/server.js`.

### Claude Code

```bash
claude mcp add review-bus -s user -e REVIEW_BUS_CONFIG=$HOME/.review-bus/config.json -- node /path/to/review-bus/dist/src/server.js
```

### Codex

```bash
codex mcp add review-bus --env REVIEW_BUS_CONFIG=$HOME/.review-bus/config.json -- node /path/to/review-bus/dist/src/server.js
```

Then open `~/.codex/config.toml` and add two lines to the `[mcp_servers.review-bus]` section it created. Put them right after the `args` line, before `[mcp_servers.review-bus.env]`: anything below that header becomes an environment variable instead of a setting.

```toml
[mcp_servers.review-bus]
command = "node"
args = ["/path/to/review-bus/dist/src/server.js"]
default_tools_approval_mode = "approve"
tool_timeout_sec = 120

[mcp_servers.review-bus.env]
REVIEW_BUS_CONFIG = "/Users/you/.review-bus/config.json"
```

Without `default_tools_approval_mode`, `codex exec` refuses every review-bus tool call ("MCP tool call requires approval"). `tool_timeout_sec` gives tool calls more than the default 60 seconds. Check with `codex mcp get review-bus`, which should list both.

## Use it

Ask the author agent in plain words, for example:

> Submit `/path/to/proposal.docx` for review with the `proposal` rubric. The intent is to win the project at a fixed price. Then wait for the result and answer every blocking finding.

The loop the agent runs:

1. `review_submit` freezes a snapshot of the work and starts the reviewers in the background. It returns a `review_id`.
2. `review_wait` (or `review_status`) until the round is done, then `review_result` for the findings.
3. `review_respond` with an answer for each blocking finding: `accepted`, `rejected` (a reason is required) or `deferred`. Then either close the review (`resubmit: false`) or fix the work and start the next round (`resubmit: true`). The next round's reviewers see the previous findings and the author's answers.
4. After 3 rounds with blocking findings still open, the review is `escalated` and a person decides. Rubrics can also require a person to sign off before a review is approved. Sign-off is only in `rb signoff`, in your own terminal: there is no MCP tool for it, because an agent could call one with any name.

### Tools

| Tool | What it does |
| --- | --- |
| `review_submit` | Submit a document, a git change and/or pages. Takes `rubric`, `intent`, `assumptions`, `criteria`, `reviewers`, `stage` (`draft`, `pre-merge`, `release`) and `wait_seconds` |
| `review_status` | State, round, reviewers done and pending, counts of findings |
| `review_wait` | Wait until the round finishes or time runs out, then return the status |
| `review_result` | Verdicts and findings for the latest round, as Markdown plus JSON |
| `review_respond` | Answer findings; close, or resubmit for the next round |
| `review_list` | Recent reviews, optionally filtered by state |
| `review_cancel` | Cancel a review and stop its reviewers |

### What to submit

A document, compared with the accepted proposal (`related` documents are not reviewed themselves; differences in price, scope or dates become findings):

```json
{ "artifact": "/path/to/contract.docx", "related": ["/path/to/accepted-proposal.pdf"], "rubric": "contract-b2b", "intent": "Sign the services agreement." }
```

A branch against its base, plus the rendered pages from a running dev server:

```json
{
  "artifact": { "git": { "repo": "/path/to/site", "mode": "base", "base": "origin/main" } },
  "pages": ["http://localhost:4321/", "http://localhost:4321/sl/"],
  "rubric": "webpage",
  "intent": "Publish the new home page in both languages."
}
```

Git modes: `uncommitted` (working tree against HEAD, including new files), `base` (the commits on your branch since it left `base`; the default base is `origin/HEAD`, then `main`), `commit` (one commit, default HEAD), `all` (the whole project at HEAD, to review a codebase rather than a change). Lockfile and binary diffs are left out of the prompt; reviewers can still read those files. Start the dev server yourself before submitting pages; review-bus never runs your project's code.

### Waiting and timeouts

MCP clients usually give up on a tool call after about 60 seconds, and a careful review can take several minutes. So the server never waits longer than `max_wait_seconds` (default 50) in one call, and says so in the reply (`wait_capped`). The agent calls `review_wait` in a loop until the state is no longer `in_review`; `review_submit` tells it to. The review keeps running on the server either way, and another session (or `rb`) can follow it too.

### Reviewers, model and effort

Each reviewer runs with a model and an effort level (`low`, `medium`, `high`, `xhigh`, `max`; Codex also has `ultra`). The first one set wins:

1. The `review_submit` call: `"reviewers": [{"name": "codex", "model": "gpt-6.1-sol", "effort": "high"}]`
2. The rubric's front matter (`effort`, and `models` per reviewer)
3. The stage: `release` uses `high`, `draft` uses `medium`
4. The adapter's config

The model and effort that actually ran are recorded on every finding as `reviewer:model:effort`, for example `codex:gpt-6.1-sol:high`.

### Several reviewers

With more than one reviewer, the same problem usually comes back from each of them in different words. review-bus merges these: the highest-risk version is kept, `agreement` counts how many reviewers raised it, and `also_raised_by` lists the others' versions. Set `merge_with` to let a cheap model do the grouping (in a test on a real proposal, Claude Haiku grouped all five shared findings correctly in 5 seconds for a fraction of a cent). Without it, only near-identical findings are merged, because word-based matching cannot tell "the launch date is unconditional" and "the go-live date is stated as fixed" are the same problem without also merging unrelated findings. The merge model sees the findings and their quotes, so for a rubric with `allowed_reviewers` it is only used if it is on that list.

## Use it from the command line

`rb` does the same for people, without an agent. Link it once with `npm link` in this folder, or run `node dist/src/cli.js`.

```bash
rb submit proposal.docx --rubric proposal --intent "Win the project at a fixed price."
rb submit --git . --mode base --base origin/main --page http://localhost:4321/ --rubric webpage --intent "Publish the new home page."
rb submit contract.docx --related proposal.pdf --rubric contract-b2b --intent "Sign the agreement." --reviewer codex::high
rb list
rb show <review_id>
rb respond <review_id> r1.f1=accepted r1.f2=rejected:"Intentional, agreed with the client" --resubmit
rb signoff <review_id> --by "Your Name"
```

`submit` and `respond --resubmit` wait for the reviewers and print the report; Ctrl-C cancels the review. Exit codes: 0 approved or awaiting sign-off, 2 changes requested, escalated or failed, 1 error. A person is the author, so no reviewer is skipped for being the same vendor. Run `rb --help` for all options.

## Rubrics

Rubrics are Markdown files in `rubrics/` (or any folder in `rubric_paths`). This repo ships `proposal`, `contract-b2b`, `webpage`, `code`, `client-email`, `linkedin-post`, `sop` and `plan`. Keep client-specific rubrics in a private folder and add it to `rubric_paths`.

A rubric has optional front matter and four sections:

```markdown
---
effort: high
require_signoff: true
---
# Client email

## Purpose

What this kind of work must achieve.

## What to check

- One line per thing reviewers must check.

## Out of scope

- What reviewers must not comment on.

## Impact anchors

- critical: ...
- high: ...
- medium: ...
- low: ...
```

Front matter keys:

| Key | Effect |
| --- | --- |
| `effort` | Effort for every reviewer (see above) |
| `models` | Model per reviewer, for example `{"codex": "gpt-6.1-sol"}` |
| `require_signoff` | A person must sign off; reviewers alone cannot approve |
| `high_blocks_always` | High and critical findings block at any likelihood |
| `confidential` | Refuses to run until `allowed_reviewers` in config lists the reviewers for this rubric |
| `report_notice` | A notice shown at the top of every result and report |

## How findings block

Reviewers rate each finding by impact (`critical`, `high`, `medium`, `low`) and likelihood (`certain`, `likely`, `possible`, `remote`), and must describe a concrete failure scenario. The server decides what blocks:

| Impact | Certain | Likely | Possible | Remote |
| --- | --- | --- | --- | --- |
| Critical | block | block | block | block |
| High | block | block | block | advisory |
| Medium | block | block | advisory | advisory |
| Low | advisory | advisory | advisory | advisory |

A finding without a failure scenario is advisory. A finding that challenges one of the author's stated assumptions blocks only if it is high or critical. At most 5 findings block per round, highest risk first. At `stage: draft` only critical findings block.

## Where results go

Each review is a folder under `~/.review-bus/reviews/` (configurable), never inside this repo or the reviewed repo:

```
rv_<id>/
  review.json      full state: request, rounds, findings, answers, history
  report.md        readable report, rewritten on every change
  r1/              round 1: the snapshot, the prompt and each reviewer's raw output
    artifact.md    the document as Markdown (documents)
    change.patch   the change, and tree/ with the project as changed (git)
    pages/         screenshots and page text (pages)
```

## Security and privacy

- Reviewers are read-only. Codex runs in its read-only sandbox, without your Codex config's MCP servers, ChatGPT apps, plugins, hooks, browser or computer use, or web access (otherwise those would be reachable despite the sandbox). Claude runs with `--restricted` and only the Read, Grep and Glob tools, confined to the review folder. They work on a copy, never on your files or repo.
- review-bus does not write to the reviewed repo: the reviewers' copy is made with a temporary index (`git read-tree` and `git checkout-index`) and `git apply` inside the review folder.
- Several sessions and `rb` can use the same reviews at once: every change to a review holds a lock shared by all processes, and a cancel from any of them stops the reviewers (the whole process group, forcefully if they ignore the polite signal).
- Approvals (`allowed_reviewers`) are read from the config file again before each new round and merge, so revoking a reviewer takes effect without restarting sessions.
- Custom `command` reviewers run with your own permissions, like any program you run: review-bus does not sandbox them. Use them for tests and scripts you trust; the Codex and Claude adapters are the read-only ones.
- Whatever you submit is sent to the reviewer's vendor (OpenAI for Codex, Anthropic for Claude). Mark rubrics for confidential material with `confidential: true` and list approved reviewers in `allowed_reviewers`.
- Content under review is treated as data. Reviewer instructions come only from the rubric and the prompt.
- Every agent session starts its own review-bus server. A review records which process runs it, so other sessions leave a running review alone and only mark it failed once that process is gone.

## Known limits (v0.1)

Found when review-bus reviewed itself with Codex, and not fixed yet:

- **Reviewers can read your disk.** Codex's read-only sandbox stops writes, not reads, so a reviewer told to by the work it reviews could open other files on your machine (other reviews, for example) and include them in what it sends to its vendor.
- **Page redirects.** A public page you submit can redirect the headless browser to a private page your machine can reach (a local server, an intranet), and that page would be captured.
- **Crashed runners.** If the process running a review is killed outright, its reviewers can keep running until their own timeout.
- **Changing a reviewer's type or vendor while a session is open.** Approvals and the command are read again before each round, but which default reviewer is picked and its model and effort still follow the config the session started with. Start a new session after such a change.
- **A rubric made confidential during a resubmit** is checked with the rules it had when the review started.
- **Slow pages and the review ID.** `review_submit` returns the review ID only after the snapshot is taken, so a very slow page can take longer than the client waits.
- **Sign-off.** `rb signoff` records whatever name it is given, and anything that can run commands in your terminal (an agent included) can run it. This is a deliberate choice for v0.1, not an oversight.

## Development

```bash
npm run build                    # compile and regenerate spec/reviewer-output.schema.json
npm test                         # all tests, with fake reviewers
node scripts/make-fixtures.mjs   # rebuild the fictional DOCX and PDF test fixtures
```

Every adapter has a fake stand-in in `test/` (`fake-codex.mjs`, `fake-claude.mjs`, `fake-reviewer.mjs`) that checks the flags it receives. Test fixtures are fictional; real documents belong in a separate private repo.

## License

Apache License 2.0. See `LICENSE`.

Copyright 2026 Insightful3
