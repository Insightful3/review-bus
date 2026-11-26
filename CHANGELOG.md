# Changelog

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
