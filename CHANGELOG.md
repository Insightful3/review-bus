# Changelog

## 0.4.0 (2026-11-27)

Decisions that stay decided: a point you rejected or deferred does not come back as new, in the next round or the next review. From the launch post's reviews, where the same point came back in a second review.

- `review_submit` takes `follows`, an earlier closed review of the same work (`rb submit --follows`): its rejected, deferred and accepted findings, and blocking findings a person signed off without answering, go to the reviewers under "Decided earlier". A file with the same name as a recent closed review gets a hint to pass it.
- Reviewers mark a finding that repeats an earlier decision (`repeats`, a new field in the reviewer output). A repeat of a rejected, deferred or settled finding blocks only if it is critical, or high and certain; a repeat of an accepted one is not softened.
- With `merge_with`, its model also checks each round's blocking findings for repeats the reviewers did not mark (one call per round, only when there is something to compare).
- `review_respond` takes status `repeat` with `repeat_of` (CLI `r2.f1=repeat:r1.f3`): it counts as rejected, with the earlier reason. With another status, `repeat_of` names the earlier finding the answer supersedes.
- `follows` keeps reviewer approvals: carried decisions remember their rubric, and a reviewer or repeat-check model not approved for it never sees them. The newest decision on a point counts (an accepted recurrence is not hidden behind an older rejection). The web inbox form and Codex's native review can mark repeats too.
- Later rounds see every earlier round's decisions, not only the previous round's: findings rejected, deferred or accepted in round 1 are still in round 3's prompt, under "Decided earlier" (newest first, at most 40 items and 12,000 characters). A deferred finding may come back only as a reminder that does not block.
- After a resubmit with `changes`, the result's notes say the new version was kept as text and that the author's file (named when it was given as a path) does not have the edits.
- `linkedin-post` rubric: a post is not documentation. A detail left out (a default, an exception, an option) is low at most, as long as what the post says stays true.

## 0.3.1 (2026-11-27)

- The Antigravity CLI is recognised as a Google author: it connects as `antigravity-client`, now in the built-in `author_vendors`. The README shows the allow rule headless `agy -p` needs to call review-bus.

## 0.3.0 (2026-11-26)

From the first real use of 0.2.1: a client contract over 3 rounds, and a code review by Claude Code with Codex reviewing.

- From round 2 only critical findings, and high ones that are certain or likely, block; the rest are advisory, and a rubric's `high_blocks_always` applies to round 1 only. Later rounds mostly reacted to the previous round's fixes. `policy.later_rounds: "same"` keeps the old rule; a round keeps the rule it started with.
- Shorter results: `review_result` no longer repeats each finding's long texts in the JSON, and advisory findings are one line each in the Markdown. On the real contract, a result with advisory findings went from about 62,000 to 20,000 characters. `full: true` gives everything, as `report.md` does.
- `review_respond` takes `changes`, edits to the version the last round reviewed (each `find` exactly once, applied by position, all or nothing), instead of the whole text again. For `.md` and `.txt` documents.
- `long_wait_clients`: MCP clients that may wait as long as clients that show progress. The Claude desktop app sends no progress token, so its calls stay under 50 seconds unless it is listed.
- `rb submit -` reads the document from standard input (`--name` sets its file name).
- Antigravity CLI (`agy`, Google's successor to Gemini CLI) as a reviewer: `type: "agy"`, held read-only by deny rules for file writes, shell commands and MCP tools. `google` is a vendor, and the README shows Antigravity as an author too.
- No config file needed: without one, review-bus uses the settings of the example config it ships with (Codex and Claude as reviewers). The quick start is now two commands, `npm install -g review-bus` and `claude mcp add review-bus -s user -- review-bus`.
- README: a shorter introduction, a quick start that says which reviewer you need and how long a review takes, a document example, and how to upgrade.

## 0.2.1 (2026-11-26)

- `rb <command> --help` (or `-h`) shows the help. Before, `rb submit --help` failed with "Unknown option".
- The version the MCP server reports to clients now comes from `package.json`, so it always matches the installed release.

## 0.2.0 (2026-11-26)

First public release.

### Review loop

- An agent submits work with `review_submit` and gets a review id at once. Reviewers run read-only on a frozen snapshot, and the author must answer every blocking finding (accepted, rejected with a reason, or deferred) before the review closes or goes another round.
- After 3 rounds with blocking findings still open, the review is escalated and a person decides with `rb signoff`. Rubrics can require a person's sign-off before any review is approved.
- By default a review goes to a model from a different vendor than the author's: Claude Code's work goes to Codex, and Codex's work to Claude.
- The same finding from several reviewers is merged (optionally by a cheap model), and its agreement is counted.

### What it reviews

- Documents: Markdown, plain text, DOCX and PDF, with up to 3 related documents for comparison (for example the accepted proposal behind a contract).
- Documents sent as text (`{name, content}`), for clients that do not share the server's disk, such as a chat app or a sandboxed agent.
- Git changes: uncommitted work, a branch against its base, one commit, or the whole project.
- Web pages, rendered in headless Chrome at desktop and mobile width, with page facts a screenshot cannot show.
- Codex's native `codex exec review` as an optional reviewer.

### Who can author and review

- MCP over stdio for Claude Code, Codex and the Claude desktop app (chat and Cowork).
- MCP over HTTP with `rb serve`, with a bearer token, loopback only by default.
- Pull reviewers: people and agents in other tools claim waiting work and post their answer, from the web inbox, `rb` or MCP, before a deadline.
- A web inbox to read reports, review as a person and sign off.

### Rubrics

- Eight rubrics as editable Markdown: `proposal`, `contract-b2b`, `client-email`, `linkedin-post`, `plan`, `sop`, `code` and `webpage`.
- Rubric packs for sharing one client's rubrics as a unit, and `rb rubric-check` to check a rubric before it is used.
- Confidential rubrics run only with reviewers approved for them in the config.

### Privacy

- Reviews are stored in `~/.review-bus/reviews`, outside any repo, readable by you only.
- Reviewers read only their review folder: they cannot see your files, other reviews or your logins.

## 0.1.0 (2026-11-25)

Not published. The first working loop: documents, git changes and web pages reviewed by Codex and Claude Code over MCP.
