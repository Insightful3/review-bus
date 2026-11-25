# Review Bus

Cross-agent review layer: any agent submits work (code or documents), other agents or people review it, and the verdict comes back as structured state the author must answer. Ships as an MCP server plus headless reviewer adapters.

Build spec for v0.1: `SPEC.md` in this folder. Read it before writing code.

## Decisions (25 Nov 2026)

- Working name: `review-bus` (final name still open)
- Language: TypeScript, Node 22+, ESM. `@modelcontextprotocol/sdk` + `zod`
- License: Apache-2.0
- Owner: Insightful3
- v0.1 covers code AND documents from day one (documents are the main real use case)

## Repo layout

Two separate git repos, side by side under a plain parent folder (the parent is not a repo):

```
~/Projects/review-bus/
├── review-bus/            # THIS repo: core, private on Bitbucket now, public on GitHub (Insightful3 org) at launch
└── review-bus-private/    # separate repo, stays private: real samples, client rubric packs, personal config
```

- Only synthetic test data in this repo. Real documents live in `../review-bus-private`.
- Never commit real client contracts, proposals, review results or API keys here, not even briefly: the full git history goes public at launch.
- Review results for documents are written to `~/.review-bus/`, outside both repos.
- To test with real files, start Claude Code with `claude --add-dir ../review-bus-private`.

## How to work

- Build the thinnest slice that runs one full review loop end to end, then widen.
- Every adapter must be testable with a fake reviewer command (no model login needed in tests).
- Reviewers are read-only. Never let a reviewer write to the author's files or repo.
- Don't invent CLI flags. Check `codex exec --help`, `codex exec review --help` and `claude --help` on this machine before using a flag.
- Keep rubrics as editable Markdown files, not code.
- No em dashes in user-facing text (README, rubrics, reports).
