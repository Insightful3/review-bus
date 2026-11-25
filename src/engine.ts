import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAdapter } from "./adapters/index.js";
import { loadConfig, type Config } from "./config.js";
import { buildPrompt, screenshotFiles } from "./prompt.js";
import { applyGroups, MERGE_SCHEMA, mergeFindings, mergePrompt, type CanBlock, type Merged, type Raised } from "./merge.js";
import { runStructured } from "./adapters/index.js";
import { computeBlocking, severityOf, wouldBlock, type PolicyOptions } from "./policy.js";
import { loadRubric } from "./rubrics.js";
import { describeArtifact, snapshotRound } from "./snapshot.js";
import { newReviewId, Store } from "./store.js";
import { checkEffort, resolveModelEffort, reviewerLabel, type ReviewerSpec } from "./settings.js";
import type { AuthorInfo, Finding, FindingResponse, Review, ReviewRequest, ReviewerRun, ReviewState, Round } from "./types.js";

export interface ResponseInput {
  finding_id: string;
  status: FindingResponse["status"];
  note?: string;
}

/** States in which nothing more happens without a person or a new submit. */
const FINAL: ReviewState[] = ["approved", "canceled"];
/** States from which the author may start the next round. */
const RESUBMITTABLE: ReviewState[] = ["changes_requested", "failed"];

const now = () => new Date().toISOString();


export class Engine {
  readonly store: Store;
  /** Rounds running in this process, keyed by review id. */
  private running = new Map<string, Promise<void>>();
  /** Aborts the reviewer processes of a running round (review_cancel). */
  private aborts = new Map<string, AbortController>();

  constructor(readonly config: Config) {
    this.store = new Store(config.storage.documents);
  }

  async submit(req: ReviewRequest, author: AuthorInfo, waitSeconds = 0): Promise<Review> {
    const rubric = loadRubric(req.rubric, this.config.rubric_paths);
    // Approvals as they are on disk now: a session may have started before one was revoked.
    const allowed = this.allowedReviewers(req.rubric, rubric.meta, this.currentConfig());
    const { specs, notes } = this.pickReviewers(req.reviewers, author, allowed);
    const runs = specs.map((spec) => this.planRun(spec, rubric.meta, req.stage));
    const id = newReviewId();
    const t = now();
    const review: Review = {
      id,
      kind: "document",
      created_at: t,
      updated_at: t,
      state: "submitted",
      request: { ...req, reviewers: specs },
      author,
      notes,
      rubric_meta: rubric.meta,
      rounds: [],
      history: [{ at: t, event: "submitted", detail: `${describeArtifact(req)} with rubric ${req.rubric}` }],
    };
    await this.startRound(review, runs, true);
    if (waitSeconds > 0) await this.waitFor(id, waitSeconds);
    return this.get(id);
  }

  /** Snapshots the artifact as round n+1, saves, and runs the reviewers in the background. */
  private async startRound(review: Review, runs: ReviewerRun[], isNew: boolean): Promise<void> {
    const n = review.rounds.length + 1;
    const t = now();
    // Each attempt builds its round in a private staging folder (relative paths stay r<n>/...).
    // It is moved into place under the lock, so two racing resubmits never touch each other's files.
    const reviewDir = this.store.dir(review.id);
    const staging = path.join(reviewDir, `.staging-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    const dropStaging = () => rmSync(staging, { recursive: true, force: true });
    let snapshot;
    try {
      snapshot = await snapshotRound(review.request.artifact, review.request.pages, staging, n, this.config.browser, review.request.related ?? []);
    } catch (err) {
      dropStaging();
      // A new review that never got saved leaves nothing behind.
      if (isNew && !existsSync(path.join(reviewDir, "review.json"))) rmSync(reviewDir, { recursive: true, force: true });
      throw err;
    }
    // Called under the lock, after checking the saved review has exactly n-1 rounds. A folder for
    // round n that the saved review does not reference is left by an attempt that stopped between
    // moving its files and saving: remove it, or every retry would be blocked.
    const publish = () => {
      rmSync(this.store.roundDir(review.id, n), { recursive: true, force: true });
      renameSync(path.join(staging, `r${n}`), this.store.roundDir(review.id, n));
    };
    const addRound = (r: Review) => {
      const prev = r.rounds.at(-1);
      if (prev && prev.snapshot.sha256 === snapshot.sha256) {
        r.history.push({ at: t, event: "note", detail: `round ${n} document is unchanged since round ${prev.n}` });
      }
      r.request.artifact = review.request.artifact;
      r.rounds.push({ n, started_at: t, finished_at: null, runner: { pid: process.pid, host: os.hostname(), started_at: t }, snapshot, reviewers: runs, findings: [] });
      r.state = "in_review";
      r.history.push({ at: t, event: "round_started", detail: `round ${n}` });
    };
    try {
      if (isNew) {
        addRound(review);
        this.store.withLock(review.id, () => {
          publish();
          this.store.save(review);
        });
      } else {
        // Another process may have changed the review while the snapshot was taken.
        this.store.update(review.id, (r) => {
          if (r.rounds.length !== n - 1 || !RESUBMITTABLE.includes(r.state)) {
            throw new Error(`Review ${review.id} changed while round ${n} was being prepared (now ${r.state}, round ${r.rounds.length}). Nothing was started.`);
          }
          publish();
          addRound(r);
        });
      }
    } finally {
      dropStaging(); // empty after a successful move; the whole attempt after a failed one
    }

    const abort = new AbortController();
    this.aborts.set(review.id, abort);
    // Errors outside a reviewer (writing the prompt, a full disk) must not crash the server process,
    // which may be running other reviews: record them on the round instead.
    const job = this.runRound(review.id, n, abort.signal)
      .catch((err) => this.recordRoundError(review.id, n, err, abort))
      .finally(() => {
      this.running.delete(review.id);
      this.aborts.delete(review.id);
    });
    this.running.set(review.id, job);
  }

  /**
   * Records the author's answers to findings of the latest round. With resubmit, starts the next
   * round on a fresh snapshot; without, closes the review once every blocking finding is answered.
   */
  async respond(
    id: string,
    responses: ResponseInput[],
    opts: { resubmit: boolean; artifact?: string; waitSeconds?: number },
  ): Promise<{ review: Review; unanswered: string[] }> {
    this.get(id); // marks a round cut off by a dead process as failed
    let unanswered: string[] = [];
    let closeRefused: string | null = null;
    // Answers, checks and (without resubmit) closing happen in one locked step.
    const review = this.store.update(id, (r) => {
      const round = r.rounds.at(-1)!;
      if (r.state === "in_review") throw new Error(`Review ${id} is still in review (round ${round.n}). Wait for the result first.`);
      if (r.state === "canceled") throw new Error(`Review ${id} is canceled.`);
      const t = now();
      for (const x of responses) {
        const f = round.findings.find((y) => y.finding_id === x.finding_id);
        if (!f) {
          const older = r.rounds.some((rd) => rd.findings.some((y) => y.finding_id === x.finding_id));
          throw new Error(`Finding ${x.finding_id} is not in round ${round.n}${older ? " (it belongs to an earlier round)" : ""}.`);
        }
        const note = (x.note ?? "").trim();
        if (x.status === "rejected" && !note) throw new Error(`Rejecting ${x.finding_id} needs a reason in note.`);
        f.response = { status: x.status, note, at: t };
      }
      if (responses.length) {
        r.history.push({ at: t, event: "responded", detail: responses.map((x) => `${x.finding_id} ${x.status}`).join(", ") });
      }
      unanswered = round.findings.filter((f) => f.blocking && !f.response).map((f) => f.finding_id);
      if (opts.resubmit) return; // checked below; the answers are saved either way
      const failed = round.reviewers.filter((x) => x.status === "failed").map((x) => x.label);
      if (r.state === "changes_requested" && !unanswered.length && failed.length) {
        // The answers are kept, but an incomplete review cannot be closed as approved.
        r.history.push({ at: now(), event: "note", detail: `not closed: reviewer(s) ${failed.join(", ")} failed in round ${round.n}` });
        closeRefused = `Round ${round.n} is incomplete: reviewer(s) ${failed.join(", ")} failed. Resubmit to run them again, or a person signs off with rb signoff.`;
        return;
      }
      if (r.state === "changes_requested" && !unanswered.length) {
        const accepted = round.findings.filter((f) => f.blocking && f.response?.status === "accepted").length;
        r.state = r.rubric_meta.require_signoff === true ? "awaiting_signoff" : "approved";
        r.history.push({
          at: now(),
          event: "closed_by_author",
          detail: `all blocking findings answered, state ${r.state}${accepted ? `; ${accepted} accepted finding(s) not re-reviewed` : ""}`,
        });
        if (accepted) r.notes.push(`Round ${round.n}: ${accepted} accepted blocking finding(s) were closed without a re-review.`);
      }
    });
    if (closeRefused) throw new Error(closeRefused);
    if (!opts.resubmit) return { review, unanswered };

    const round = review.rounds.at(-1)!;
    if (review.state === "escalated") throw new Error(`Review ${id} is escalated after ${round.n} rounds. A person decides with rb signoff.`);
    if (!RESUBMITTABLE.includes(review.state)) throw new Error(`Review ${id} is ${review.state}; submit a new review instead of resubmitting.`);
    if (unanswered.length) throw new Error(`Answer every blocking finding before resubmitting. Unanswered: ${unanswered.join(", ")}.`);
    if (round.n >= this.config.policy.max_rounds) throw new Error(`Review ${id} has used all ${this.config.policy.max_rounds} rounds.`);
    const rubric = loadRubric(review.request.rubric, this.config.rubric_paths);
    // Approvals can change between rounds: check the reviewers against the config on disk now (SPEC 9).
    const current = this.currentConfig();
    const allowed = this.allowedReviewers(review.request.rubric, rubric.meta, current);
    for (const spec of review.request.reviewers) {
      if (!current.adapters[spec.name] || !this.config.adapters[spec.name]) throw new Error(`Reviewer "${spec.name}" is no longer configured. Submit a new review.`);
      if (allowed && !allowed.includes(spec.name)) {
        throw new Error(`Reviewer "${spec.name}" is no longer approved for ${review.request.rubric} (approved: ${allowed.join(", ")}). Nothing was sent. Submit a new review.`);
      }
    }
    const runs = review.request.reviewers.map((spec) => this.planRun(spec, rubric.meta, review.request.stage));
    // A new document path replaces the old one; git changes and pages are simply captured again.
    if (opts.artifact) {
      if (!review.request.artifact?.path) throw new Error("artifact can only be changed for document reviews; git changes and pages are captured again on resubmit.");
      review.request.artifact = { path: opts.artifact };
    }
    await this.startRound(review, runs, false);
    if (opts.waitSeconds) await this.waitFor(id, opts.waitSeconds);
    return { review: this.get(id), unanswered: [] };
  }

  /** A person approves a review that awaits sign-off or was escalated. */
  signoff(id: string, by: string, note: string): Review {
    if (!by.trim()) throw new Error("Sign-off needs the person's name in by.");
    this.get(id);
    return this.store.update(id, (review) => {
      if (review.state !== "awaiting_signoff" && review.state !== "escalated") {
        throw new Error(`Review ${id} is ${review.state}; only awaiting_signoff or escalated reviews can be signed off.`);
      }
      const t = now();
      review.signoff = { by: by.trim(), note: note.trim(), at: t, from_state: review.state };
      review.history.push({ at: t, event: "signed_off", detail: `by ${by.trim()} from ${review.state}${note.trim() ? `: ${note.trim()}` : ""}` });
      review.state = "approved";
    });
  }

  /** Cancels a review. The process running its round (this one or another) stops the reviewers. */
  cancel(id: string): Review {
    this.get(id);
    const review = this.store.update(id, (r) => {
      if (FINAL.includes(r.state)) throw new Error(`Review ${id} is already ${r.state}.`);
      r.state = "canceled";
      r.history.push({ at: now(), event: "canceled" });
    });
    this.aborts.get(id)?.abort();
    return review;
  }

  /** Most recent first. */
  list(state?: ReviewState, limit = 50): Review[] {
    if (!existsSync(this.store.root)) return [];
    return readdirSync(this.store.root)
      .filter((d) => /^rv_[0-9a-z]{26}$/.test(d) && existsSync(path.join(this.store.root, d, "review.json")))
      .sort()
      .reverse()
      .map((d) => this.get(d))
      .filter((r) => !state || r.state === state)
      .slice(0, limit);
  }

  /**
   * SPEC 8a: default reviewers must be a different vendor than the author. Explicitly named
   * same-vendor reviewers are allowed but noted.
   */
  /**
   * SPEC 9: reviewers approved for this rubric, or null when any reviewer may see it.
   * A rubric marked `confidential: true` refuses to run until config lists its reviewers.
   */
  private allowedReviewers(rubricName: string, meta: Record<string, unknown>, config: Config = this.config): string[] | null {
    const list = config.allowed_reviewers[rubricName];
    if (list) return list;
    if (meta.confidential === true) {
      throw new Error(
        `Rubric "${rubricName}" is confidential. List the reviewers approved for it in review-bus.config.json, ` +
          `for example "allowed_reviewers": {"${rubricName}": ["codex", "claude"]}.`,
      );
    }
    return null;
  }

  /**
   * The config as it is on disk now, for decisions about what may be sent where (approvals can be
   * revoked while a server keeps running). Fails closed: if the file cannot be read, nothing is sent.
   */
  private currentConfig(): Config {
    if (!this.config.config_file) return this.config;
    try {
      return loadConfig(this.config.config_file);
    } catch (err) {
      throw new Error(`Could not re-read ${this.config.config_file}, so nothing was sent: ${(err as Error).message}`);
    }
  }

  private pickReviewers(
    requested: ReviewerSpec[],
    author: AuthorInfo,
    allowed: string[] | null = null,
  ): { specs: ReviewerSpec[]; notes: string[] } {
    const notes: string[] = [];
    const known = Object.keys(this.config.adapters);
    const check = (name: string) => {
      if (!this.config.adapters[name]) throw new Error(`Unknown reviewer "${name}". Configured: ${known.join(", ") || "(none)"}`);
    };
    if (!author.vendor && author.vendor_source !== "person") notes.push(`Author vendor unknown${author.client ? ` (MCP client "${author.client}")` : ""}.`);

    if (requested.length) {
      requested.forEach((s) => check(s.name));
      const refused = requested.filter((s) => allowed && !allowed.includes(s.name)).map((s) => s.name);
      if (refused.length) throw new Error(`Reviewer(s) ${refused.join(", ")} are not approved for this rubric. Approved: ${allowed!.join(", ")}.`);
      for (const s of requested) {
        const vendor = this.config.adapters[s.name].vendor;
        if (author.vendor && vendor === author.vendor) notes.push(`Reviewer "${s.name}" is the same vendor as the author (${vendor}).`);
      }
      return { specs: requested, notes };
    }

    const defaults = this.config.default_reviewers;
    if (!defaults.length) throw new Error("No reviewers given and no default_reviewers in config.");
    defaults.forEach(check);
    const approved = allowed ? defaults.filter((n) => allowed.includes(n)) : defaults;
    if (!approved.length) throw new Error(`None of default_reviewers (${defaults.join(", ")}) is approved for this rubric. Approved: ${allowed!.join(", ")}.`);
    const picked = author.vendor ? approved.filter((n) => this.config.adapters[n].vendor !== author.vendor) : approved;
    if (!picked.length) {
      throw new Error(
        `No default reviewer from a different vendor than the author (${author.vendor}). ` +
          `default_reviewers: ${defaults.join(", ")}. Add one to default_reviewers or name reviewers explicitly.`,
      );
    }
    return { specs: picked.map((name) => ({ name })), notes };
  }

  private planRun(spec: ReviewerSpec, rubricMeta: Record<string, unknown>, stage: ReviewRequest["stage"]): ReviewerRun {
    const cfg = this.config.adapters[spec.name];
    const r = resolveModelEffort(spec, cfg, rubricMeta, stage);
    checkEffort(cfg.type, r.effort, spec.name);
    return {
      name: spec.name,
      adapter: cfg.type,
      vendor: cfg.vendor,
      model: r.model,
      model_reported: false,
      model_source: r.model_source,
      model_requested: r.model,
      effort: r.effort,
      effort_reported: false,
      effort_source: r.effort_source,
      effort_requested: r.effort,
      label: reviewerLabel(spec.name, r.model, r.effort),
      status: "pending",
      verdict: null,
      summary: null,
      error: null,
      started_at: null,
      finished_at: null,
    };
  }

  /** Resolves when this process's round for the review has fully finished (reviewers exited). */
  async settled(id: string): Promise<void> {
    await this.running.get(id);
  }

  async waitFor(id: string, seconds: number): Promise<void> {
    const job = this.running.get(id);
    if (!job) {
      // Running in another process: poll the stored state.
      const until = Date.now() + seconds * 1000;
      while (Date.now() < until && this.get(id).state === "in_review") await new Promise((r) => setTimeout(r, 500));
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([job, new Promise<void>((r) => (timer = setTimeout(r, seconds * 1000)))]);
    clearTimeout(timer);
  }

  /** Loads a review. A round left in_review with no job in this process was cut off by a restart. */
  get(id: string): Review {
    const review = this.store.load(id);
    const cutOff = (r: Review) => r.state === "in_review" && !this.running.has(id) && !this.runningElsewhere(r);
    if (!cutOff(review)) return review;
    return this.store.update(id, (r) => {
      if (!cutOff(r)) return; // changed meanwhile
      r.state = "failed";
      r.history.push({ at: now(), event: "failed", detail: "round was running when the server stopped" });
    });
  }

  /**
   * True when another live server process (another agent session, or the rb CLI) is running the
   * latest round. A round older than the longest reviewer timeout plus 10 minutes counts as dead,
   * in case the process id was reused.
   */
  private runningElsewhere(review: Review): boolean {
    const round = review.rounds.at(-1);
    const runner = round?.runner;
    if (!round || !runner || runner.pid === process.pid) return false;
    if (runner.host !== os.hostname()) return true; // shared storage on another machine: cannot check
    const maxTimeout = Math.max(600, ...Object.values(this.config.adapters).map((a) => a.timeout_seconds));
    if (Date.now() - Date.parse(runner.started_at) > (maxTimeout + 600) * 1000) return false;
    try {
      process.kill(runner.pid, 0); // signal 0 only checks that the process exists
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /** Saves one reviewer's live status so review_status can show progress. Sync, so no interleaving. */
  private saveRun(id: string, n: number, run: ReviewerRun): void {
    this.store.update(id, (r) => {
      const rd = r.rounds.find((x) => x.n === n);
      if (rd) rd.reviewers = rd.reviewers.map((x) => (x.name === run.name ? { ...run } : x));
    });
  }

  private async runRound(id: string, n: number, signal: AbortSignal): Promise<void> {
    const review = this.store.load(id);
    const round = review.rounds.find((r) => r.n === n)!;
    const reviewDir = this.store.dir(id);
    const roundDir = this.store.roundDir(id, n);
    const rubric = loadRubric(review.request.rubric, this.config.rubric_paths);
    const snap = round.snapshot;
    const text = snap.markdown_file ? readFileSync(path.join(reviewDir, snap.markdown_file), "utf8") : null;
    const images = screenshotFiles(snap).map((f) => path.join(reviewDir, f));
    const previous = review.rounds.find((r) => r.n === n - 1) ?? null;
    const related = (snap.related ?? []).map((r) => ({ name: path.basename(r.source_path), text: readFileSync(path.join(reviewDir, r.markdown_file), "utf8") }));
    const prompt = buildPrompt(review.request, rubric, snap, text, snap.markdown_file ? path.basename(snap.markdown_file) : "", previous, related);
    writeFileSync(path.join(roundDir, "prompt.md"), prompt);

    // A cancel can come from another process (rb cancel, another session): watch the stored state.
    const watcher = setInterval(() => {
      try {
        if (this.store.load(id).state === "canceled") this.aborts.get(id)?.abort();
      } catch {
        /* mid-write; try again next tick */
      }
    }, 1000);
    try {
      await this.finishRound(id, n, review, round, prompt, images, roundDir, signal);
    } finally {
      clearInterval(watcher);
    }
  }

  private async finishRound(
    id: string,
    n: number,
    review: Review,
    round: Round,
    prompt: string,
    images: string[],
    roundDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Last check before anything leaves the machine: approvals and reviewer definitions as they
    // are on disk right now, from the same read (a reviewer repointed to another provider runs as
    // configured now, not as configured when this server started).
    let dispatchError: (name: string) => string | null;
    let adapterFor: (name: string) => Config["adapters"][string] | undefined = () => undefined;
    try {
      const current = this.currentConfig();
      const allowed = this.allowedReviewers(review.request.rubric, review.rubric_meta, current);
      adapterFor = (name) => current.adapters[name];
      dispatchError = (name) =>
        !current.adapters[name]
          ? "no longer configured; nothing was sent"
          : allowed && !allowed.includes(name)
            ? `no longer approved for ${review.request.rubric}; nothing was sent`
            : null;
    } catch (err) {
      const message = (err as Error).message;
      dispatchError = () => message;
    }
    const results = await Promise.all(
      round.reviewers.map(async (run) => {
        run.status = "running";
        run.started_at = now();
        this.saveRun(id, n, run);
        try {
          const refused = dispatchError(run.name);
          if (refused) throw new Error(refused);
          const res = await runAdapter(adapterFor(run.name)!, {
            reviewerName: run.name,
            prompt,
            cwd: roundDir,
            outDir: roundDir,
            images,
            model: run.model_requested,
            effort: run.effort_requested,
            signal,
          });
          writeFileSync(path.join(roundDir, `${run.name}.json`), JSON.stringify(res.output, null, 2));
          // Record what actually ran when the CLI reports it (SPEC 8a).
          if (res.reportedModel) Object.assign(run, { model: res.reportedModel, model_reported: true });
          if (res.reportedEffort) Object.assign(run, { effort: res.reportedEffort, effort_reported: true });
          run.label = reviewerLabel(run.name, run.model, run.effort);
          run.status = "done";
          run.verdict = res.output.verdict;
          run.summary = res.output.summary;
          return { run, output: res.output };
        } catch (err) {
          run.status = "failed";
          run.error = signal.aborted ? "canceled" : err instanceof Error ? err.message : String(err);
          return { run, output: null };
        } finally {
          run.finished_at = now();
          this.saveRun(id, n, run);
        }
      }),
    );

    // Merge the same finding from several reviewers before the policy decides what blocks.
    // This awaits a model, so it happens before the final reload below (a cancel may land meanwhile).
    const raised = results.flatMap(({ run, output }) => (output ? output.findings.map((finding) => ({ finding, reviewer: run.label })) : []));
    const policy: PolicyOptions = {
      stage: review.request.stage,
      max_blocking: this.config.policy.max_blocking,
      high_blocks_always: review.rubric_meta.high_blocks_always === true,
    };
    const { merged, merge } = await this.merge(raised, review.request.rubric, review.rubric_meta, roundDir, signal, (f) => wouldBlock(f, policy));
    const findings: Finding[] = merged.map((m, i) => ({
      ...m.finding,
      finding_id: `r${n}.f${i + 1}`,
      reviewer: m.reviewer,
      round: n,
      blocking: false,
      severity: severityOf(m.finding),
      agreement: m.agreement,
      also_raised_by: m.also_raised_by,
      response: null,
    }));
    const blocking = computeBlocking(findings, policy);
    findings.forEach((f, i) => (f.blocking = blocking[i]));

    // Apply the results to the latest stored state, under the lock.
    this.store.update(id, (fresh) => {
      const freshRound = fresh.rounds.find((r) => r.n === n);
      if (!freshRound) return;
      freshRound.reviewers = round.reviewers;
      freshRound.findings = findings;
      freshRound.merge = merge;
      freshRound.finished_at = now();
      // Canceled meanwhile, or a newer round started (after a restart marked this one failed):
      // keep this round's results but leave the review state alone.
      if (fresh.state !== "in_review" || fresh.rounds.at(-1)!.n !== n) return;
      fresh.state = this.stateAfterRound(fresh, freshRound);
      const failed = freshRound.reviewers.filter((r) => r.status === "failed").map((r) => r.label);
      if (failed.length && fresh.state !== "failed") {
        fresh.notes.push(`Round ${n}: reviewer(s) ${failed.join(", ")} failed; their review is missing from this round.`);
      }
      fresh.history.push({
        at: now(),
        event: "round_finished",
        detail: `round ${n}: ${findings.filter((f) => f.blocking).length} blocking, ${findings.filter((f) => !f.blocking).length} advisory${failed.length ? `, failed: ${failed.join(", ")}` : ""}, state ${fresh.state}`,
      });
    });
  }

  private recordRoundError(id: string, n: number, err: unknown, abort: AbortController): void {
    abort.abort();
    const message = err instanceof Error ? err.message : String(err);
    try {
      this.store.update(id, (r) => {
        const round = r.rounds.find((x) => x.n === n);
        if (round && !round.finished_at) round.finished_at = now();
        // Leave a canceled review, or a newer round, alone.
        if (r.state !== "in_review" || r.rounds.at(-1)?.n !== n) return;
        r.state = "failed";
        r.history.push({ at: now(), event: "failed", detail: `round ${n}: ${message}` });
      });
    } catch (e) {
      console.error(`review-bus: round ${n} of ${id} failed (${message}) and could not be recorded: ${(e as Error).message}`);
    }
  }

  /**
   * Merges duplicates across reviewers: with the configured model when there is one (and it may see
   * this rubric's content), else with conservative word-based rules.
   */
  private async merge(
    raised: Raised[],
    rubricName: string,
    rubricMeta: Record<string, unknown>,
    roundDir: string,
    signal: AbortSignal,
    canBlock: CanBlock,
  ): Promise<{ merged: Merged[]; merge: NonNullable<Round["merge"]> }> {
    const reviewers = new Set(raised.map((r) => r.reviewer));
    if (reviewers.size < 2) return { merged: mergeFindings(raised, canBlock), merge: { method: "none", by: null, error: null } };
    // The merge model sees quotes from the work: check approvals as they are on disk now.
    let current: Config;
    let allowed: string[] | null;
    try {
      current = this.currentConfig();
      // Throws for a confidential rubric whose approval entry was removed: then no model sees it.
      allowed = this.allowedReviewers(rubricName, rubricMeta, current);
    } catch (err) {
      return { merged: mergeFindings(raised, canBlock), merge: { method: "rules", by: null, error: (err as Error).message } };
    }
    const mw = current.merge_with;
    if (!mw || !current.adapters[mw.adapter] || (allowed && !allowed.includes(mw.adapter))) {
      return { merged: mergeFindings(raised, canBlock), merge: { method: "rules", by: null, error: mw ? `${mw.adapter} is not approved for ${rubricName}` : null } };
    }
    const label = reviewerLabel(mw.adapter, mw.model, mw.effort);
    try {
      const res = await runStructured(current.adapters[mw.adapter], {
        reviewerName: "merge",
        prompt: mergePrompt(raised),
        cwd: roundDir,
        outDir: roundDir,
        model: mw.model,
        effort: mw.effort,
        signal,
        schema: MERGE_SCHEMA as unknown as Record<string, unknown>,
        tools: "none",
      });
      const merged = applyGroups(raised, (res.json as { groups?: unknown } | null)?.groups, canBlock);
      if (!merged) throw new Error("the grouping put a finding in two groups");
      return { merged, merge: { method: "model", by: reviewerLabel(mw.adapter, res.reportedModel ?? mw.model, res.reportedEffort ?? mw.effort), error: null } };
    } catch (err) {
      return { merged: mergeFindings(raised, canBlock), merge: { method: "rules", by: label, error: `model merge failed, used rules: ${(err as Error).message}` } };
    }
  }

  private stateAfterRound(review: Review, round: Round): ReviewState {
    if (round.reviewers.every((r: ReviewerRun) => r.status === "failed")) return "failed";
    const openBlocking = round.findings.some((f) => f.blocking);
    // A requested reviewer that failed means the review is incomplete: never approve it.
    // With blocking findings from the others the author has work anyway; without, resubmit to retry.
    const someFailed = round.reviewers.some((r: ReviewerRun) => r.status === "failed");
    if (!openBlocking && someFailed) return "failed";
    if (!openBlocking) return review.rubric_meta.require_signoff === true ? "awaiting_signoff" : "approved";
    if (round.n >= this.config.policy.max_rounds) return "escalated";
    return "changes_requested";
  }
}
