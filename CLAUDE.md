# Review Bus

Cross-agent review layer: any agent submits work (code or documents), other agents or people review it, and the verdict comes back as structured state the author must answer. Ships as an MCP server plus headless reviewer adapters, the `rb` CLI and a web inbox.

`SPEC.md` is the build spec and records the design decisions. Read it before writing code. `TASKS.md` lists what is built and what is open; `README.md` is the user documentation.

## Stack

- TypeScript, Node 22+, ESM. `@modelcontextprotocol/sdk` and `zod`
- License: Apache-2.0

## How to work

- Build the thinnest slice that runs one full review loop end to end, then widen.
- Every adapter must be testable with a fake reviewer command (no model login needed in tests). `npm test` runs everything with fakes.
- Reviewers are read-only. Never let a reviewer write to the author's files or repo.
- Don't invent CLI flags. Check `codex exec --help`, `codex exec review --help` and `claude --help` on this machine before using a flag.
- Keep rubrics as editable Markdown files, not code. `rb rubric-check rubrics/` must pass.
- No em dashes in user-facing text (README, rubrics, reports).

## Data in this repo

- Only synthetic test data. The fixtures in `test/fixtures/` are fictional (Northwind, Bluefin).
- Never commit real client documents, review results, personal config or API keys, not even briefly: the full git history is public.
- Review results are written to `~/.review-bus/` (configurable), never into this repo or a reviewed repo.
- Real documents and client rubrics belong in a separate private folder, added to `rubric_paths` or `rubric_packs` in the personal config.
