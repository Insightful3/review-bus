# review-bus

Have a second AI, from a different company, review your AI agent's work before you use it.

Your agent (Claude Code, Codex, the Claude desktop app, Antigravity or any MCP client) submits a document, a code change or web pages. Another model reviews a frozen copy read-only, against a rubric, and sends back findings. Every blocking finding must be fixed or answered (accepted, rejected with a reason, or deferred) before the review closes, and after at most 3 rounds a person decides. By default, a Claude agent's work goes to Codex and Codex's work goes to Claude. People can review too, from a web inbox or the `rb` command line.

Status: 0.3. See `CHANGELOG.md` for what changed, `SPEC.md` for the design and `TASKS.md` for what is open.

## Quick start

About two minutes, with Claude Code as the author. You need Node.js 22 or newer, git, and a reviewer from a different vendor than your agent, logged in. For Claude Code that is Codex:

```bash
npm install -g @openai/codex
codex login
```

(Antigravity works as the reviewer too; see Antigravity as a reviewer.)

1. Install review-bus and connect it to Claude Code:

   ```bash
   npm install -g review-bus
   claude mcp add review-bus -s user -- review-bus
   ```

2. Start a new Claude Code session and ask, in a git repo with uncommitted changes:

   > Review my uncommitted changes with review-bus (code rubric), then fix or answer every blocking finding.

   Or for a document, anywhere:

   > Review /path/to/proposal.docx with review-bus using the proposal rubric. The intent is to win the project at a fixed price. Then answer every blocking finding.

A review takes about a minute; a large change or high effort takes several. Claude Code waits for it, shows the findings, fixes or answers each blocking one and resubmits until the review closes. Every review is kept in `~/.review-bus/reviews`, with a readable `report.md`.

No config file is needed: without one, review-bus uses the settings in `review-bus.config.example.json` from the package. Copy it to `~/.review-bus/config.json` when you want to change reviewers, approvals or limits (see Configure). Other document rubrics: `contract-b2b`, `client-email`, `linkedin-post`, `plan`, `sop`; `rb rubrics` lists them all. The rest of this README covers other authors (Codex, the Claude desktop app, Antigravity), people as reviewers, the web inbox and writing your own rubrics.

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

From npm:

```bash
npm install -g review-bus
```

This installs two commands: `review-bus` (the MCP server) and `rb` (the command line and `rb serve`).

From source, to change it or run the tests:

```bash
git clone https://github.com/Insightful3/review-bus.git
cd review-bus
npm install
npm run build
npm test
```

The tests use fake reviewers, so they need no model login. With a source checkout, use `node /path/to/review-bus/dist/src/server.js` wherever the commands below say `review-bus`.

### Upgrading

```bash
npm install -g review-bus@latest
```

Then restart Claude Code, the Claude desktop app, or whatever runs the MCP server, so it starts the new version. Your config and your reviews stay where they are; settings a new version adds take their defaults until you set them. A review that is open during the upgrade keeps the rules each of its rounds started with. `CHANGELOG.md` lists what changed.

## Configure

Without a config file, review-bus uses the example config's settings. To change them, copy the example config (from the npm package or a source checkout) and edit it:

```bash
mkdir -p ~/.review-bus
cp "$(npm root -g)/review-bus/review-bus.config.example.json" ~/.review-bus/config.json
```

The example uses Codex and Claude Code as reviewers, approves both for `contract-b2b`, and looks for your own rubrics in `~/.review-bus/rubrics`. Remove a reviewer you do not have from `default_reviewers`.

The config is the file named in `REVIEW_BUS_CONFIG`, else `~/.review-bus/config.json`, else the example config's settings built in. It is never read from the current folder: a config names commands to run, and a cloned repo is not a trusted source of commands. Relative paths in it are resolved against the config file's folder.

| Key | What it does |
| --- | --- |
| `adapters` | The reviewers you can use, each with `type` (`codex`, `claude`, `agy`, `codex-review`, `command` or `pull`), `command`, `vendor`, `model`, `effort` and `timeout_seconds`. Pull reviewers have no command; `claim_clients` limits which MCP clients may claim their work |
| `default_reviewers` | Used when the author names none. Reviewers from the author's own vendor are skipped |
| `allowed_reviewers` | Per rubric, the reviewers you approve for that kind of content. Required for confidential rubrics such as `contract-b2b` |
| `rubric_paths` | Extra folders with rubric files. Later folders override earlier ones by rubric name. This repo's `rubrics/` always comes first |
| `rubric_packs` | Folders of rubrics shared as one unit (for example one client's), named `pack/rubric` |
| `http` | For `rb serve`: `host` (default `127.0.0.1`), `port` (7777), `token_file` (`~/.review-bus/http-token`), `allow_remote` (false), `allowed_hosts`, `public_origin` (behind a TLS proxy) |
| `snapshot_wait_seconds` | How long `review_submit` waits for page screenshots before returning the review id (default 10) |
| `storage.documents` | Where reviews are stored (default `~/.review-bus/reviews`) |
| `author_vendors` | Maps MCP client names to vendors (`anthropic`, `openai`, `google`, `other`). `claude-code`, `codex-mcp-client`, `local-agent-mode-*` (the Claude desktop app) and `antigravity-client` (Antigravity CLI) are built in; a key ending in `*` matches names that start with the rest |
| `browser` | Headless browser for page review: `channel` (default `chrome`), `executable_path`, `max_height` (default 16000 px), `args` (extra Chrome flags) |
| `merge_with` | Optional. A cheap model that merges the same finding from several reviewers, for example `{"adapter": "claude", "model": "haiku", "effort": "low"}`, and checks whether new findings repeat earlier decisions. Without it, only near-identical findings are merged and there is no repeat check |
| `max_wait_seconds` | Longest a tool call waits before returning (default 50, under the usual 60 second client timeout) |
| `max_wait_with_progress_seconds` | Longest a call waits when the client shows progress, like Claude Code (default 900) |
| `long_wait_clients` | MCP clients (names, or prefixes ending in `*`) that may wait as long as `max_wait_with_progress_seconds` without showing progress. Empty by default; add a client only once you know it does not time out a long tool call |
| `policy` | `max_blocking` findings per round (5; a rubric can set its own), `max_rounds` (3) and `later_rounds` (`stricter`, the default, or `same`; see How findings block) |

## Connect an author agent

Any MCP client can be the author. These three are tested.

### Claude Code

```bash
claude mcp add review-bus -s user -- review-bus
```

It reads `~/.review-bus/config.json` when that exists. To use a config elsewhere, add `-e REVIEW_BUS_CONFIG=/path/to/config.json` before `--`.

### Codex

```bash
codex mcp add review-bus -- review-bus
```

Then open `~/.codex/config.toml` and add two lines to the `[mcp_servers.review-bus]` section it created, right after the `command` line (or `args`, from a source checkout). If the section has an `[mcp_servers.review-bus.env]` part, the lines go before it: anything below that header becomes an environment variable instead of a setting.

```toml
[mcp_servers.review-bus]
command = "review-bus"
default_tools_approval_mode = "approve"
tool_timeout_sec = 120
```

Without `default_tools_approval_mode`, `codex exec` refuses every review-bus tool call ("MCP tool call requires approval"). `tool_timeout_sec` gives tool calls more than the default 60 seconds. Check with `codex mcp get review-bus`, which should list both.

### Claude desktop app (chat and Cowork)

Add review-bus to `~/Library/Application Support/Claude/claude_desktop_config.json` (on Windows `%APPDATA%\Claude\claude_desktop_config.json`) and restart the app. Apps started from the Dock do not get your shell's `PATH`, so give the full path of `review-bus` (`which review-bus`) and a `PATH` that finds `node`, `codex`, `git` and `pdftotext`:

```json
{
  "mcpServers": {
    "review-bus": {
      "command": "/opt/homebrew/bin/review-bus",
      "env": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

The server runs on your computer, so reviewers use the Codex or Claude login there, even when you drive the app from your phone. The computer must be on. Chats and sandboxed sessions often cannot hand over a path on your disk: they send the document as text instead (see What to submit).

### Antigravity

Google's Antigravity CLI (`agy`) reads MCP servers from `~/.gemini/config/mcp_config.json`; the Antigravity app has its own list under Customizations, MCP Servers. The format is the same `mcpServers` block as for the Claude desktop app above.

The Antigravity CLI connects as `antigravity-client`, which review-bus counts as a Google author, so the default reviewers (Codex and Claude) both review its work. If another Antigravity client shows up as unknown, pass `author_vendor: "google"` in `review_submit`, or map its name (the `initialize` line of a `REVIEW_BUS_LOG` file) in `author_vendors`.

agy asks before it calls an MCP tool. In headless runs (`agy -p`) nobody can answer, so the call is refused; allow review-bus's tools in `~/.gemini/antigravity-cli/settings.json`:

```json
{ "permissions": { "allow": ["mcp(review-bus/*)"] } }
```

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
| `review_submit` | Submit a document, a git change and/or pages. Takes `rubric`, `intent`, `assumptions`, `criteria`, `reviewers`, `stage` (`draft`, `pre-merge`, `release`), `wait_seconds` and `follows` (an earlier review of the same work, see Decisions that stay decided) |
| `review_status` | State, round, reviewers done and pending, counts of findings |
| `review_wait` | Wait until the round finishes or time runs out, then return the status |
| `review_result` | Verdicts and findings for the latest round, as Markdown plus JSON. Blocking findings come in full, advisory ones (with `include_advisory`) one line each; `full: true` gives everything, as in `report.md` |
| `review_respond` | Answer findings (`accepted`, `rejected`, `deferred`, or `repeat` with `repeat_of`); close, or resubmit for the next round (with a new `artifact`, or `changes` to the last version) |
| `review_list` | Recent reviews, optionally filtered by state |
| `review_cancel` | Cancel a review and stop its reviewers |
| `review_rubrics` | The rubrics you can name, with their purpose, including rubric packs |
| `review_pending` | Work waiting for pull reviewers |
| `review_claim` | Claim a pull reviewer's work: returns the prompt, the files, the answer schema and a token |
| `review_post` | Send a pull reviewer's answer (or decline) with the token |
| `review_release` | Give up a claim so someone else can take it |
| `review_file` | Read a file of the claimed work (screenshots as images), for pull reviewers on another machine |

### What to submit

A document, compared with the accepted proposal (`related` documents are not reviewed themselves; differences in price, scope or dates become findings):

```json
{ "artifact": "/path/to/contract.docx", "related": ["/path/to/accepted-proposal.pdf"], "rubric": "contract-b2b", "intent": "Sign the services agreement." }
```

A document sent as text, for agents whose files are not on this computer (a chat, a sandbox). `.md` and `.txt` only, up to 1,000,000 characters; `related` documents can be text too. The text is saved in the review folder and reviewed like a file. To resubmit, send the new version the same way in `review_respond`'s `artifact`, or send only the edits in `changes` (below):

```json
{ "artifact": { "name": "post.md", "content": "The full text of the post" }, "related": [{ "name": "sources.md", "content": "The facts behind it" }], "rubric": "linkedin-post", "intent": "Publish the post on Thursday." }
```

Edits to the version submitted last, instead of the whole text again (`.md` and `.txt` documents, sent as text or as a path). Each `find` is copied exactly and must occur exactly once; if one does not, nothing is changed. The edited text becomes the next version, kept as text. A file you gave as a path is only read, so it does not get the edits; the result's notes remind you to make them there too:

```json
{ "review_id": "rv_...", "responses": [{ "finding_id": "r1.f1", "status": "accepted" }], "resubmit": true, "changes": [{ "find": "Total price: EUR 24,000", "replace": "Total price: EUR 22,500" }] }
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

A careful review can take several minutes, and MCP clients give up on a silent tool call after about 60 seconds. review-bus handles both kinds of client:

- **Clients that show progress (Claude Code does).** They send a progress token with each call. review-bus then sends a progress update every 10 seconds ("Round 1: 1 of 2 reviewer(s) done; still working: codex…"), which keeps the call alive, and waits up to `max_wait_with_progress_seconds` (default 900). So `review_submit` with `wait_seconds: 900` returns the finished review in one call. Checked with Claude Code 2.1.316: one call, a 70 second review, the full result back.
- **Other clients.** A call waits at most `max_wait_seconds` (default 50) and says so (`wait_capped`); the agent calls `review_wait` again until the state is no longer `in_review`. The Claude desktop app (chat, Cowork and the Code tab) is one of these: it sends no progress token. If you know a client does not time out long tool calls, list it in `long_wait_clients` and it waits as long as a client that shows progress.
- **Pages.** Rendering pages can take a while. A review with pages is saved first and its pages are rendered in the background; if that takes longer than `snapshot_wait_seconds` (default 10, and never longer than the call's own `max_wait_seconds`), `review_submit` returns the review id with state `submitted`, and a later capture error shows as a failed review. A page that fails to load within those seconds is still an error on submit.
- **Pull reviewers.** A wait (and an MCP task) ends as soon as only pull reviewers are left, since a person may answer tomorrow. The answer then carries `waiting_for_pull` and a hint to check back later with `review_status`. The review stays `in_review` until they post.

The review keeps running on the server either way, and another session (or `rb`) can follow it too.

### Reviewers, model and effort

Each reviewer runs with a model and an effort level (`low`, `medium`, `high`, `xhigh`, `max`; Codex also has `ultra`). The first one set wins:

1. The `review_submit` call: `"reviewers": [{"name": "codex", "model": "gpt-6.1-sol", "effort": "high"}]`
2. The rubric's front matter (`effort`, and `models` per reviewer)
3. The stage: `release` uses `high`, `draft` uses `medium`
4. The adapter's config

The model and effort that actually ran are recorded on every finding as `reviewer:model:effort`, for example `codex:gpt-6.1-sol:high`.

### Tasks

`review_submit`, `review_respond` (with `resubmit`) and `review_wait` can also be called as MCP tasks (2025-11-25 form): the call returns at once and the task completes with the result when the round finishes. Clients that do not use tasks are unaffected. Claude Code 2.1.316 does not use this form (it uses tasks only on 2026-07-28 connections), so it relies on progress updates instead (above). To see how a client calls review-bus, set `REVIEW_BUS_LOG` to a file path in the server's environment: every request is logged with whether it came as a task, and tool calls with their arguments (paths and intents included; claim tokens and the content of documents sent as text are replaced by `[redacted]` and the text's length, and resubmit `changes` by their number). The file is created readable by you only. Use it for debugging only.

### Several reviewers

With more than one reviewer, the same problem usually comes back from each of them in different words. review-bus merges these: the highest-risk version is kept, `agreement` counts how many reviewers raised it, and `also_raised_by` lists the others' versions. Set `merge_with` to let a cheap model do the grouping (in a test on a real proposal, Claude Haiku grouped all five shared findings correctly in 5 seconds for a fraction of a cent). Without it, only near-identical findings are merged, because word-based matching cannot tell "the launch date is unconditional" and "the go-live date is stated as fixed" are the same problem without also merging unrelated findings. The merge model sees the findings and their quotes, so for a rubric with `allowed_reviewers` it is only used if it is on that list.

### Antigravity as a reviewer

`type: "agy"` runs Google's Antigravity CLI headless (`agy -p` with `--output-format json` and the reviewer schema as `--json-schema`), with Gemini models by default. Install it and sign in once by running `agy`; `agy models` lists the model names for `model`.

```json
"agy": { "type": "agy", "command": "/Users/you/.local/bin/agy", "vendor": "google", "effort": "medium", "timeout_seconds": 600 }
```

It is held read-only by deny rules passed with `--settings`, which win over any allow rule in your own agy settings: no file writes, no shell commands, no MCP tools. This matters because agy 1.5.18 writes files in its default mode without asking, even headless, and its plan mode returned no answer. Reading files in the round folder stays allowed. The prompt, with the work under review, is written to `agy-prompt.md` in the round folder (readable by you only) and agy is told to read it: it never goes on agy's command line, where other users of the machine could see it. If Gemini tries a forbidden tool and gives no answer, the reviewer fails with the tool's name. agy does not report which model it used, so the result shows the requested model. Checked with agy 1.5.18 on a real proposal: 25 seconds, the planted price mismatch found.

### Codex's native review

`type: "codex-review"` runs Codex's built-in code reviewer (`codex exec review --uncommitted`) instead of a rubric prompt, for git changes only. It needs a git repo, so review-bus builds a scratch one inside the round folder (the base committed, the change uncommitted); the author's repo is not touched. Its answer is text, so a second, ordinary Codex pass turns it into findings (priorities P0 to P3 become critical to low). It runs under the same read-only permission profile as the `codex` reviewer. Add it next to `codex` and name it when you want it, for example `--reviewer codex-native`.

## Pull reviewers: people and agents in other tools

A reviewer with `type: "pull"` is not started by review-bus. Its work waits until someone claims it: a person in the web inbox or with `rb`, or an agent in any MCP client (another tool, another vendor). The round finishes when the last reviewer answers, from whichever process that happens in.

```json
"adapters": {
  "ana": { "type": "pull", "vendor": "other", "timeout_seconds": 172800 },
  "antigravity": { "type": "pull", "vendor": "google" }
}
```

- `review_pending` (or `rb pending`) lists waiting work. `review_claim` returns the prompt (rubric, intent, the work), the files, the answer's JSON Schema and a token; nobody else can claim it after that. `review_post` sends the answer: the same reviewer output JSON the headless reviewers return, or `decline` with a reason. `review_release` gives the work back; it names the claim by its `claim_id` (from the claim, or `review_pending`), so a release repeated after someone else claimed the work cannot drop their claim.
- `timeout_seconds` is the deadline (default 3 days for pull reviewers). A reviewer that misses it counts as failed, and the round finishes without it.
- `claim_clients` limits who may claim for that reviewer, by MCP client name. Without it any connected client can, including the author's own agent, so name the clients for anything that matters.
- Approvals apply as for every reviewer: a confidential rubric only goes to pull reviewers listed in `allowed_reviewers`, checked again at claim time, also when the rubric was made confidential after the review was submitted.
- A pull reviewer on another machine gets the files with `review_file` (screenshots as images), using the paths in `snapshot_files` from the claim.

## MCP over HTTP and the web inbox

`rb serve` runs one review-bus process with MCP over Streamable HTTP at `/mcp` and a web inbox at `/inbox`, on `127.0.0.1:7777` by default. Every request needs the token in `http.token_file` (created on first start, readable only by you).

```bash
rb serve
claude mcp add --transport http review-bus http://127.0.0.1:7777/mcp --header "Authorization: Bearer $(cat ~/.review-bus/http-token)"
```

Open `http://rb.localhost:7777/inbox` (or `http://127.0.0.1:7777/inbox`) and paste the token once. The browser then keeps a session for 12 hours, until `rb serve` restarts. The session cookie is not the token, and on `rb.localhost` it is not sent to other services you run on `localhost` or `127.0.0.1`, which share cookies regardless of port. The inbox shows work waiting for pull reviewers, reviews waiting for your decision and recent reviews. A person can claim a pull reviewer's work there (the page shows the brief, the rubric, the work and the screenshots, then a form for findings), release a claim, and sign off reviews that await sign-off or were escalated. Times are shown in UTC.

`rb serve` only listens on this machine. To listen on another address, set `http.allow_remote: true` and put TLS in front of it, since the token travels with every request. Behind a TLS proxy, set `http.public_origin` to the address people open (for example `https://reviews.example.com`), so the inbox accepts their form posts. For git reviews the inbox links the full patch, since the work shown on the page is cut at 120,000 characters. Requests that name another host (DNS rebinding) or come from another site's page are refused. Behind an HTTPS `public_origin` the inbox cookie is `Secure`. MCP sessions a client never closed are dropped after an hour without requests; at most 100 are kept, and with all of them busy a new client is asked to retry. If your inbox session expires while you write a review, sending it asks for the token and then sends what you wrote.

## Use it from the command line

`rb` does the same for people, without an agent. It comes with the npm package; from a source checkout, link it once with `npm link`, or run `node dist/src/cli.js`.

```bash
rb submit proposal.docx --rubric proposal --intent "Win the project at a fixed price."
rb submit --git . --mode base --base origin/main --page http://localhost:4321/ --rubric webpage --intent "Publish the new home page."
rb submit contract.docx --related proposal.pdf --rubric contract-b2b --intent "Sign the agreement." --reviewer codex::high
pbpaste | rb submit - --name post.md --rubric linkedin-post --intent "Publish on Thursday."
rb list
rb show <review_id>
rb respond <review_id> r1.f1=accepted r1.f2=rejected:"Intentional, agreed with the client" --resubmit
rb submit contract.docx --rubric contract-b2b --intent "Sign the agreement." --follows <earlier review_id>
rb signoff <review_id> --by "Your Name"
```

`rb post` asks for the claim token without showing it (scripts: `REVIEW_BUS_CLAIM_TOKEN`, or `--token-stdin`); it never takes the token as an argument, where it would land in shell history.

More commands: `rb rubrics` lists every rubric you can name; `rb rubric-check <file or folder>` checks rubrics before you use them; `rb pending`, `rb claim`, `rb post` and `rb release` are for pull reviewers; `rb serve` starts the HTTP server and inbox.

`submit` and `respond --resubmit` wait for the reviewers and print the report (or stop once only pull reviewers are left); Ctrl-C cancels the review. Exit codes: 0 approved or awaiting sign-off, 2 changes requested, escalated or failed, 1 error. A person is the author, so no reviewer is skipped for being the same vendor. Run `rb --help` for all options.

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
| `max_blocking` | How many findings may block per round for this rubric (default 5 from config) |
| `confidential` | Refuses to run until `allowed_reviewers` in config lists the reviewers for this rubric |
| `report_notice` | A notice shown at the top of every result and report |

### Rubric packs

A rubric pack is a folder of rubrics shared as one unit, for example the rubrics a client agreed on with you. Add it to `rubric_packs` and name its rubrics as `pack/rubric`:

```
acme-rubrics/
  pack.json         {"name": "acme", "description": "Acme's review rules", "version": "1.0.0"}
  contract-b2b.md
  proposal.md
```

```json
{ "rubric_packs": ["~/rubric-packs/acme-rubrics"] }
```

Then submit with `"rubric": "acme/contract-b2b"`. Plain names (`contract-b2b`) keep coming from `rubric_paths`. Approvals look for `acme/contract-b2b` in `allowed_reviewers` first, then for `contract-b2b`. Before sharing a pack, run `rb rubric-check acme-rubrics/`: it reports missing sections or impact levels, front matter values of the wrong type, unknown keys and em dashes.

## How findings block

Reviewers rate each finding by impact (`critical`, `high`, `medium`, `low`) and likelihood (`certain`, `likely`, `possible`, `remote`), and must describe a concrete failure scenario. The server decides what blocks:

| Impact | Certain | Likely | Possible | Remote |
| --- | --- | --- | --- | --- |
| Critical | block | block | block | block |
| High | block | block | block | advisory |
| Medium | block | block | advisory | advisory |
| Low | advisory | advisory | advisory | advisory |

A finding without a failure scenario is advisory. A finding that challenges one of the author's stated assumptions blocks only if it is high or critical.

From round 2 on, only critical findings, and high ones that are certain or likely, block; the rest are advisory, and a rubric's `high_blocks_always` applies to round 1 only. Later rounds mostly react to the previous round's fixes and find smaller things each time, and this keeps a review from going round after round on them. Set `policy.later_rounds` to `same` to use the table above in every round. A round keeps the rule it started with, so changing the setting does not affect a round already running. At most 5 findings block per round, highest risk first; a rubric can set its own limit with `max_blocking` in its front matter (`contract-b2b` uses 12). Findings that would block but are over the limit are marked "over the limit" and get their own section in the report, so they are not mistaken for minor points. At `stage: draft` only critical findings block.

### Decisions that stay decided

When you reject or defer a finding, the point should not come back as new in the next round or the next review.

- Every round sees your answers to the findings of all earlier rounds, with your reasons, under "Decided earlier", not only the previous round's: rejected and deferred ones, and accepted ones as fixed then. A deferred finding may come back only as a reminder that does not block.
- A new review of the same work can name an earlier, closed review (approved, awaiting sign-off or escalated) in `follows` (`rb submit --follows <review_id>`). Its decisions are copied into the new review once, at submit: rejected and deferred findings with your reasons, accepted ones (to check they did not come back), and blocking findings a person signed off without answering, as settled by that person. A review following another also carries what that one carried. Approvals still apply: if a carried decision comes from a rubric with `allowed_reviewers` (or one that was confidential when that review ran), every reviewer of the new review must be on that list, or `follows` is refused; this is checked again at every round and claim, and the merge model is held to it too. When you submit a file with the same name as a recent closed review without `follows`, the result suggests it.
- Reviewers mark a finding that repeats an earlier rejected, deferred or settled one (`repeats`). A repeat blocks only if it is critical, or high and certain. A repeat of an accepted finding is not softened: the fix did not hold. When the same point was decided more than once, the newest decision counts. People reviewing in the web inbox have a field for the earlier finding's id.
- With `merge_with` set, its model also checks the round's blocking findings that no reviewer marked against the earlier decisions, and marks the repeats the reviewers missed. It runs only if it is approved for every rubric the decisions come from. If the check fails, the round goes on under the ordinary rule, with a note.
- If a repeat still gets through, answer it `repeat` with `repeat_of` naming the earlier finding (`rb respond <id> r2.f1=repeat:r1.f3`): it counts as rejected, with the earlier reason. With another answer, `repeat_of` names the earlier finding on the same point, which your answer supersedes: accept a point you rejected before, and the old rejection no longer softens it.

The history shown to reviewers is at most 40 decisions and 12,000 characters, newest first, with long fields cut; the result says how many were left out.

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

- Reviewers are read-only and can read only their review folder. Codex runs under a permission profile that allows reading the round folder and the system paths common tools need, and denies everything else: the rest of your home folder, other reviews, its own login token and the temp folders. It also runs without your Codex config's MCP servers, ChatGPT apps, plugins, hooks, browser or computer use, or web access. Claude runs with `--restricted`, which confines its Read, Grep and Glob tools to the review folder. Codex permission profiles are beta, so after upgrading Codex run `npm run check:isolation`: it checks with canary files that a reviewer can read its folder and nothing private.
- review-bus does not write to the reviewed repo: the reviewers' copy is made with a temporary index (`git read-tree` and `git checkout-index`) and `git apply` inside the review folder.
- If the process running a review is killed outright, a small watchdog stops its reviewers within seconds, so they do not keep running and spending tokens.
- Page capture: a public page cannot load resources from private addresses (localhost, `10.x`, `192.168.x` and so on); they are blocked and listed. A public page that redirects into a private address is not captured at all.
- Several sessions and `rb` can use the same reviews at once: every change to a review holds a lock shared by all processes, and a cancel from any of them stops the reviewers (the whole process group, forcefully if they ignore the polite signal).
- Approvals (`allowed_reviewers`) are read from the config file again before each new round and merge, so revoking a reviewer takes effect without restarting sessions.
- Custom `command` reviewers run with your own permissions, like any program you run: review-bus does not sandbox them. Use them for tests and scripts you trust; the Codex and Claude adapters are the read-only ones.
- Whatever you submit is sent to the reviewer's vendor (OpenAI for Codex, Anthropic for Claude). Mark rubrics for confidential material with `confidential: true` and list approved reviewers in `allowed_reviewers`.
- Content under review is treated as data. Reviewer instructions come only from the rubric and the prompt.
- `rb serve` listens on `127.0.0.1` only unless `http.allow_remote` is set, needs the token for `/mcp` and the inbox, and refuses requests with another `Host` or `Origin` (DNS rebinding, other sites' pages). The inbox keeps a random session id in an `HttpOnly`, `SameSite=Strict` cookie (never the token), and pages are served with a strict Content Security Policy. The inbox serves only files review-bus wrote and recorded in a round's snapshot (the Markdown, related documents, screenshots), never through a symlink, so never `review.json`. Browser posts must come from the inbox's own origin, port included. A bad request cannot stop the server.
- Each review folder is readable by you only (mode 700), and its `review.json` and `report.md` too (mode 600), whatever your umask. A rubric whose front matter has a wrong type or an unknown key (for example `confidential: "true"` as text) is refused when a review is submitted, not only by `rb rubric-check`. Pull reviewer claim tokens are stored only as a SHA-256 hash, compared in constant time, and never appear in results, reports, the inbox's review pages or the `REVIEW_BUS_LOG` file. Documents sent as text are kept in the review folder only (never in the log), and removed if the review fails or is canceled before its first round. An answer after the deadline is refused.
- git variables in review-bus's environment (`GIT_DIR`, `GIT_INDEX_FILE` and the rest, as set inside a git hook) are removed before any git call and from every reviewer's environment, so they cannot point git at another repository.
- `codex-review` builds its scratch git repo inside the round folder, with your global and system git config ignored and filters and line-ending conversion switched off.
- Every agent session starts its own review-bus server. A review records which process runs it, so other sessions leave a running review alone and only mark it failed once that process is gone.

## Known limits

Found when review-bus reviewed itself with Codex, and not fixed yet:

- **Reviewer reads, what is left.** Codex and Claude reviewers are confined to their review folder, Codex's image viewer included (see Security). Not covered: custom `command` reviewers (they run with your permissions) and system files that tools need (for example `/etc`).
- **Private addresses from public pages, what is left.** A public page cannot load anything from a private address (your machine, your network), and a redirect into one stops the capture. But that one redirected request is still made before the capture stops, and a name that resolves differently for Chrome than for review-bus (DNS rebinding) is not caught. Pages you submit from your own dev server are not restricted.
- **Changing a reviewer's type or vendor while a session is open.** Approvals and the command are read again before each round, but which default reviewer is picked and its model and effort still follow the config the session started with. Start a new session after such a change.
- **A rubric made confidential during a resubmit** is checked with the rules it had when the review started.
- **Slow pages on resubmit.** A new review returns its id before slow page capture (see Waiting and timeouts), but a resubmit still captures the pages before it returns. Clients that show progress are not affected.
- **Who may act as a pull reviewer.** Without `claim_clients`, any connected MCP client can claim a pull reviewer's work, the author's own agent included. MCP client names are what the client says it is, so `claim_clients` keeps honest clients apart rather than stopping a determined one.
- **The inbox and the HTTP token.** One token opens everything, the same trust as your terminal: whoever has it can claim work, post answers and sign off. The HTTP server speaks plain HTTP; keep it on this machine or put TLS in front. On `127.0.0.1` or `localhost` (rather than `rb.localhost`), another local service that the browser visits receives the inbox session cookie.
- **Sign-off.** `rb signoff` and the inbox record whatever name they are given, and anything that can run commands in your terminal (an agent included) can run it. This is a deliberate choice, not an oversight.

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
