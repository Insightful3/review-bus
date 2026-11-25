---
require_signoff: false
---
# Code

## Purpose

Check a code change before it is merged or released: it does what the author intends, does not break what worked before, and does not open a security hole or lose data. Review the diff first and read the surrounding code in tree/ when you need context.

## What to check

- Correctness: the change does what the intent says, including edge cases (empty input, nulls, limits, time zones, concurrency, retries).
- Regressions: callers of changed functions still work; changed behaviour that other code relies on.
- Security: injection (SQL, shell, HTML), missing authorization checks, secrets in code or logs, unsafe deserialization, paths or URLs taken from user input, weakened validation.
- Data: migrations that can lose or corrupt data, missing transactions, writes that are not idempotent where retries happen.
- Errors: failures that are swallowed, error paths that leave state half written, missing timeouts on network calls.
- Tests: changed behaviour has a test that would fail without the change. Name the missing test.
- Resource use: obvious performance traps on hot paths (queries in loops, unbounded memory, missing pagination).

## Out of scope

- Formatting and anything a linter or formatter handles.
- Naming and style preferences.
- Refactoring suggestions that do not fix a defect.

## Impact anchors

- critical: data loss or corruption, a security hole an outsider can use, a crash on the main path.
- high: wrong results users act on, a regression in existing behaviour, a security weakness that needs insider access.
- medium: an edge case that fails, missing tests for changed behaviour, an error that is swallowed.
- low: minor inefficiency or unclear code that does not cause a defect.
