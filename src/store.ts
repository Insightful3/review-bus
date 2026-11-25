import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeArtifact } from "./snapshot.js";
import type { Finding, Review } from "./types.js";

function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* not supported on every platform; the file itself is flushed */
  }
}

interface LockOwner {
  pid: number;
  host: string;
  token: string;
  at: number;
}

function readOwner(lock: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(path.join(lock, "owner"), "utf8"));
  } catch {
    return null;
  }
}

function isStale(lock: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return false; // released meanwhile
  }
  const owner = readOwner(lock);
  if (!owner) return age > 30_000; // created but owner not written yet, or left by a crash in between
  // On another machine (shared storage) liveness cannot be checked: fall back to age.
  if (owner.host !== os.hostname()) return Date.now() - owner.at > 120_000;
  // On this machine only a gone owner makes a lock stale, however long a live one holds it.
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "EPERM";
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit ms timestamp + 80 random bits, Crockford base32. */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}

export function newReviewId(): string {
  return `rv_${ulid().toLowerCase()}`;
}

export function isReviewId(id: string): boolean {
  return /^rv_[0-9a-z]{26}$/.test(id);
}

export class Store {
  constructor(readonly root: string) {}

  dir(id: string): string {
    if (!isReviewId(id)) throw new Error(`Invalid review id: ${id}`);
    return path.join(this.root, id);
  }

  roundDir(id: string, n: number): string {
    return path.join(this.dir(id), `r${n}`);
  }

  load(id: string): Review {
    return JSON.parse(readFileSync(path.join(this.dir(id), "review.json"), "utf8"));
  }

  /**
   * Writes review.json atomically (unique temp file, then rename): the rename is the commit point.
   * report.md is derived from it and regenerated on every save, so failing to write it does not
   * fail the save. Callers that read, change and write must hold the review's lock: use update().
   */
  save(review: Review): void {
    const dir = this.dir(review.id);
    mkdirSync(dir, { recursive: true });
    review.updated_at = new Date().toISOString();
    const suffix = `${process.pid}.${randomBytes(4).toString("hex")}`;
    const tmp = path.join(dir, `review.json.${suffix}.tmp`);
    // Flushed to disk before the rename, and the folder after it, so a confirmed save survives a
    // power cut. (Round files are not flushed one by one; a lost snapshot fails its round.)
    // Readable by the owner only: review state can name confidential work.
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(review, null, 2)); // writes every byte, or throws
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const first = !existsSync(path.join(dir, "review.json"));
    renameSync(tmp, path.join(dir, "review.json"));
    syncDir(dir);
    // A new review: also flush the folder holding it (and the storage folder's parent), so its
    // entry survives a power cut right after the id was handed out.
    if (first) {
      syncDir(this.root);
      syncDir(path.dirname(this.root));
    }
    const reportTmp = path.join(dir, `report.md.${suffix}.tmp`);
    try {
      writeFileSync(reportTmp, renderReport(review));
      renameSync(reportTmp, path.join(dir, "report.md"));
    } catch (err) {
      rmSync(reportTmp, { force: true });
      console.error(`review-bus: could not write report.md for ${review.id}: ${(err as Error).message}`);
    }
  }

  /**
   * Runs fn while holding the review's lock, shared by every process using this storage (several
   * agent sessions and rb). The lock is a directory created atomically, with an owner file
   * (pid, host, token). It is stale when its owner process on this host is gone, or after 120 s.
   * Taking over a stale lock happens under a second, short-lived steal lock and re-checks the
   * owner, so two processes recovering at once cannot remove each other's fresh lock. A process
   * only ever removes a lock that holds its own token. fn must be synchronous and must not lock again.
   */
  withLock<T>(id: string, fn: () => T): T {
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, ".lock");
    const token = `${process.pid}.${randomBytes(6).toString("hex")}`;
    const deadline = Date.now() + 15_000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        mkdirSync(lock);
        writeFileSync(path.join(lock, "owner"), JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: Date.now() }));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      this.takeOverIfStale(lock);
      if (Date.now() > deadline) throw new Error(`Review ${id} is locked by another process; try again.`);
      Atomics.wait(pause, 0, 0, 20);
    }
    try {
      return fn();
    } finally {
      if (readOwner(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
    }
  }

  /** Removes the lock only if it is stale, and only one process at a time may try. */
  private takeOverIfStale(lock: string): void {
    const steal = `${lock}.steal`;
    try {
      mkdirSync(steal);
    } catch {
      // Someone else is checking. A steal lock left by a crash goes after 10 s.
      try {
        if (Date.now() - statSync(steal).mtimeMs > 10_000) rmSync(steal, { recursive: true, force: true });
      } catch {
        /* gone already */
      }
      return;
    }
    try {
      if (isStale(lock)) rmSync(lock, { recursive: true, force: true });
    } finally {
      rmSync(steal, { recursive: true, force: true });
    }
  }

  /** Loads, changes and saves a review under its lock. If fn throws, nothing is saved. */
  update(id: string, fn: (review: Review) => void): Review {
    return this.withLock(id, () => {
      const review = this.load(id);
      fn(review);
      this.save(review);
      return review;
    });
  }
}

function settingNote(value: string | null, reported: boolean, source: string): string {
  if (reported) return `${value} (reported by the CLI)`;
  if (value == null) return "CLI default (not reported)";
  return `${value} (requested, from ${source})`;
}

function findingLine(f: Finding): string {
  const loc = f.location.section ?? (f.location.line_start != null ? `line ${f.location.line_start}` : null);
  const parts = [
    `**${f.finding_id}** [${f.impact}/${f.likelihood}] ${f.claim}`,
    loc ? `  - Where: ${loc}` : null,
    f.location.quote ? `  - Quote: "${f.location.quote}"` : null,
    f.failure_scenario ? `  - Failure scenario: ${f.failure_scenario}` : null,
    f.suggested_fix ? `  - Suggested fix: ${f.suggested_fix}` : null,
    `  - Reviewer: ${f.reviewer}, confidence ${f.confidence}`,
    f.agreement > 1 ? `  - Also raised by: ${(f.also_raised_by ?? []).map((r) => `${r.reviewer} [${r.impact}/${r.likelihood}]`).join(", ")} (agreement ${f.agreement})` : null,
    f.response ? `  - Response: ${f.response.status}${f.response.note ? `, ${f.response.note}` : ""}` : null,
  ];
  return "- " + parts.filter(Boolean).join("\n");
}

export function renderSummary(review: Review, includeAdvisory = true): string {
  const round = review.rounds.at(-1);
  const lines: string[] = [`# Review ${review.id}`, ""];
  if (typeof review.rubric_meta.report_notice === "string") lines.push(`> ${review.rubric_meta.report_notice}`, "");
  lines.push(`- State: **${review.state}**`);
  lines.push(`- Rubric: ${review.request.rubric}, stage: ${review.request.stage}`);
  lines.push(`- Artifact: ${describeArtifact(review.request)}`);
  const a = review.author;
  lines.push(
    a.vendor_source === "person"
      ? `- Author: a person (${a.client})`
      : `- Author: ${a.vendor ?? "unknown vendor"}${a.client ? ` (${a.client})` : ""}${a.vendor_source === "declared" ? ", declared" : ""}`,
  );
  if (!round) {
    if (review.state === "submitted") lines.push("- Taking the snapshot (rendering pages).");
    if (review.notes.length) lines.push("", "## Notes", "", ...review.notes.map((n) => `- ${n}`));
  }
  if (round) {
    const snap = round.snapshot;
    lines.push(`- Round ${round.n}, snapshot sha256 ${snap.sha256.slice(0, 12)}${snap.converter && snap.converter !== "none" ? `, converted with ${snap.converter}` : ""}`);
    if (snap.git) {
      const g = snap.git;
      lines.push(`- Change: ${g.files.length} file(s), +${g.insertions} -${g.deletions}, ${g.mode}${g.base_ref ? ` vs ${g.base_ref} (${g.base_sha.slice(0, 12)})` : ""}${g.branch ? `, branch ${g.branch}` : ""}`);
      for (const n of g.notes) lines.push(`- ${n}`);
    }
    for (const p of snap.pages ?? []) {
      lines.push(`- Page ${p.url}: HTTP ${p.status ?? "?"}, ${p.screenshots.length} screenshot(s) in ${p.screenshots[0]?.file.split("/").slice(0, 2).join("/") ?? "?"}`);
    }
    for (const w of snap.warnings ?? []) lines.push(`- Warning: ${w}`);
    if (round.merge && round.merge.method !== "none") {
      lines.push(`- Duplicates across reviewers merged by ${round.merge.method === "model" ? `model (${round.merge.by})` : "word-based rules"}${round.merge.error ? `; ${round.merge.error}` : ""}`);
    }
    const blocking = round.findings.filter((f) => f.blocking);
    const overLimit = round.findings.filter((f) => !f.blocking && f.over_limit);
    const advisory = round.findings.filter((f) => !f.blocking && !f.over_limit);
    const limit = round.policy?.max_blocking;
    lines.push(
      round.finished_at || review.state !== "in_review"
        ? `- Findings: ${blocking.length} blocking, ${overLimit.length + advisory.length} advisory${overLimit.length ? ` (${overLimit.length} of them would block but are over the limit of ${limit ?? blocking.length} blocking per round)` : ""}`
        : "- Findings: not yet, the round is still running",
    );
    const unanswered = blocking.filter((f) => !f.response).length;
    if (blocking.length) lines.push(`- Unanswered blocking findings: ${unanswered}`);
    if (review.signoff) lines.push(`- Signed off by ${review.signoff.by} on ${review.signoff.at}${review.signoff.note ? `: ${review.signoff.note}` : ""}`);
    if (review.notes.length) {
      lines.push("", "## Notes", "", ...review.notes.map((n) => `- ${n}`));
    }
    lines.push("", "## Reviewers", "");
    for (const r of round.reviewers) {
      lines.push(`- ${r.label} (${r.adapter}, ${r.vendor}): ${r.status}${r.verdict ? `, ${r.verdict}` : ""}`);
      if (r.adapter === "pull") {
        if (r.model_reported) lines.push(`  - Model ${r.model} (given by the reviewer)`);
      } else {
        lines.push(`  - Model ${settingNote(r.model, r.model_reported, r.model_source)}; effort ${settingNote(r.effort, r.effort_reported, r.effort_source)}`);
      }
      if (r.adapter === "pull") {
        lines.push(r.claim ? `  - Claimed by ${r.claim.by}${r.claim.client ? ` (${r.claim.client})` : ""} on ${r.claim.at}` : `  - Not claimed yet; due ${r.deadline ?? "?"}`);
      }
      if (r.summary) lines.push(`  - ${r.summary}`);
      if (r.error) lines.push(`  - Error: ${r.error}`);
    }
    lines.push("", "## Blocking findings", "");
    lines.push(blocking.length ? blocking.map(findingLine).join("\n") : "None.");
    if (overLimit.length) {
      lines.push(
        "",
        "## Over the limit (would block)",
        "",
        `These would block on their own, but a round blocks on at most ${limit ?? blocking.length} findings, the riskiest first. They are not required answers in this round; treat them as serious, and they may block in the next round.`,
        "",
        overLimit.map(findingLine).join("\n"),
      );
    }
    if (includeAdvisory) {
      lines.push("", "## Advisory findings", "");
      lines.push(advisory.length ? advisory.map(findingLine).join("\n") : "None.");
    } else {
      // Challenges to the author's assumptions are always shown (SPEC 6).
      const challenges = advisory.filter((f) => f.assumption_challenge);
      if (challenges.length) lines.push("", "## Assumption challenges (advisory)", "", challenges.map(findingLine).join("\n"));
    }
  }
  return lines.join("\n") + "\n";
}

function renderReport(review: Review): string {
  const history = review.history.map((h) => `- ${h.at} ${h.event}${h.detail ? `: ${h.detail}` : ""}`);
  const earlier = review.rounds.slice(0, -1).reverse().map((r) => {
    const body = r.findings.length ? r.findings.map(findingLine).join("\n") : "No findings.";
    return `\n## Round ${r.n} (earlier)\n\nReviewers: ${r.reviewers.map((x) => x.label).join(", ")}\n\n${body}\n`;
  });
  return renderSummary(review, true) + earlier.join("") + "\n## History\n\n" + history.join("\n") + "\n";
}
