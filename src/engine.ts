import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runAdapter } from "./adapters/index.js";
import type { Config } from "./config.js";
import { buildPrompt, screenshotFiles } from "./prompt.js";
import { computeBlocking, severityOf } from "./policy.js";
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
    const allowed = this.allowedReviewers(req.rubric, rubric.meta);
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
    await this.startRound(review, runs);
    if (waitSeconds > 0) await this.waitFor(id, waitSeconds);
    return this.get(id);
  }

  /** Snapshots the artifact as round n+1, saves, and runs the reviewers in the background. */
  private async startRound(review: Review, runs: ReviewerRun[]): Promise<void> {
    const n = review.rounds.length + 1;
    const t = now();
    const snapshot = await snapshotRound(review.request.artifact, review.request.pages, this.store.dir(review.id), n, this.config.browser);
    const prev = review.rounds.at(-1);
    if (prev && prev.snapshot.sha256 === snapshot.sha256) {
      review.history.push({ at: t, event: "note", detail: `round ${n} document is unchanged since round ${prev.n}` });
    }
    review.rounds.push({ n, started_at: t, finished_at: null, snapshot, reviewers: runs, findings: [] });
    review.state = "in_review";
    review.history.push({ at: t, event: "round_started", detail: `round ${n}` });
    this.store.save(review);

    const abort = new AbortController();
    this.aborts.set(review.id, abort);
    const job = this.runRound(review.id, n, abort.signal).finally(() => {
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
    const review = this.get(id);
    const round = review.rounds.at(-1)!;
    if (review.state === "in_review") throw new Error(`Review ${id} is still in review (round ${round.n}). Wait for the result first.`);
    if (review.state === "canceled") throw new Error(`Review ${id} is canceled.`);

    const t = now();
    for (const r of responses) {
      const f = round.findings.find((x) => x.finding_id === r.finding_id);
      if (!f) {
        const older = review.rounds.some((rd) => rd.findings.some((x) => x.finding_id === r.finding_id));
        throw new Error(`Finding ${r.finding_id} is not in round ${round.n}${older ? " (it belongs to an earlier round)" : ""}.`);
      }
      const note = (r.note ?? "").trim();
      if (r.status === "rejected" && !note) throw new Error(`Rejecting ${r.finding_id} needs a reason in note.`);
      f.response = { status: r.status, note, at: t };
    }
    if (responses.length) {
      review.history.push({ at: t, event: "responded", detail: responses.map((r) => `${r.finding_id} ${r.status}`).join(", ") });
    }
    const unanswered = round.findings.filter((f) => f.blocking && !f.response).map((f) => f.finding_id);

    if (opts.resubmit) {
      if (review.state === "escalated") {
        throw new Error(`Review ${id} is escalated after ${round.n} rounds. A person decides with review_signoff.`);
      }
      if (FINAL.includes(review.state) || review.state === "awaiting_signoff") {
        throw new Error(`Review ${id} is ${review.state}; submit a new review instead of resubmitting.`);
      }
      if (unanswered.length) throw new Error(`Answer every blocking finding before resubmitting. Unanswered: ${unanswered.join(", ")}.`);
      if (round.n >= this.config.policy.max_rounds) {
        throw new Error(`Review ${id} has used all ${this.config.policy.max_rounds} rounds.`);
      }
      const rubric = loadRubric(review.request.rubric, this.config.rubric_paths);
      const runs = review.request.reviewers.map((spec) => this.planRun(spec, rubric.meta, review.request.stage));
      // A new document path replaces the old one; git changes and pages are simply captured again.
      if (opts.artifact) {
        if (!review.request.artifact?.path) throw new Error("artifact can only be changed for document reviews; git changes and pages are captured again on resubmit.");
        review.request.artifact = { path: opts.artifact };
      }
      await this.startRound(review, runs);
      if (opts.waitSeconds) await this.waitFor(id, opts.waitSeconds);
      return { review: this.get(id), unanswered: [] };
    }

    if (review.state === "changes_requested" && !unanswered.length) {
      const accepted = round.findings.filter((f) => f.blocking && f.response?.status === "accepted").length;
      review.state = review.rubric_meta.require_signoff === true ? "awaiting_signoff" : "approved";
      review.history.push({
        at: now(),
        event: "closed_by_author",
        detail: `all blocking findings answered, state ${review.state}${accepted ? `; ${accepted} accepted finding(s) not re-reviewed` : ""}`,
      });
      if (accepted) review.notes.push(`Round ${round.n}: ${accepted} accepted blocking finding(s) were closed without a re-review.`);
    }
    this.store.save(review);
    return { review, unanswered };
  }

  /** A person approves a review that awaits sign-off or was escalated. */
  signoff(id: string, by: string, note: string): Review {
    const review = this.get(id);
    if (review.state !== "awaiting_signoff" && review.state !== "escalated") {
      throw new Error(`Review ${id} is ${review.state}; only awaiting_signoff or escalated reviews can be signed off.`);
    }
    if (!by.trim()) throw new Error("Sign-off needs the person's name in by.");
    const t = now();
    review.signoff = { by: by.trim(), note: note.trim(), at: t, from_state: review.state };
    review.history.push({ at: t, event: "signed_off", detail: `by ${by.trim()} from ${review.state}${note.trim() ? `: ${note.trim()}` : ""}` });
    review.state = "approved";
    this.store.save(review);
    return review;
  }

  cancel(id: string): Review {
    const review = this.get(id);
    if (FINAL.includes(review.state)) throw new Error(`Review ${id} is already ${review.state}.`);
    review.state = "canceled";
    review.history.push({ at: now(), event: "canceled" });
    this.store.save(review);
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
  private allowedReviewers(rubricName: string, meta: Record<string, unknown>): string[] | null {
    const list = this.config.allowed_reviewers[rubricName];
    if (list) return list;
    if (meta.confidential === true) {
      throw new Error(
        `Rubric "${rubricName}" is confidential. List the reviewers approved for it in review-bus.config.json, ` +
          `for example "allowed_reviewers": {"${rubricName}": ["codex", "claude"]}.`,
      );
    }
    return null;
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
    if (!author.vendor) notes.push(`Author vendor unknown${author.client ? ` (MCP client "${author.client}")` : ""}.`);

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

  async waitFor(id: string, seconds: number): Promise<void> {
    const job = this.running.get(id);
    if (!job) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([job, new Promise<void>((r) => (timer = setTimeout(r, seconds * 1000)))]);
    clearTimeout(timer);
  }

  /** Loads a review. A round left in_review with no job in this process was cut off by a restart. */
  get(id: string): Review {
    const review = this.store.load(id);
    if (review.state === "in_review" && !this.running.has(id)) {
      review.state = "failed";
      review.history.push({ at: now(), event: "failed", detail: "round was running when the server stopped" });
      this.store.save(review);
    }
    return review;
  }

  /** Saves one reviewer's live status so review_status can show progress. Sync, so no interleaving. */
  private saveRun(id: string, n: number, run: ReviewerRun): void {
    const r = this.store.load(id);
    const rd = r.rounds.find((x) => x.n === n);
    if (!rd) return;
    rd.reviewers = rd.reviewers.map((x) => (x.name === run.name ? { ...run } : x));
    this.store.save(r);
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
    const prompt = buildPrompt(review.request, rubric, snap, text, snap.markdown_file ? path.basename(snap.markdown_file) : "", previous);
    writeFileSync(path.join(roundDir, "prompt.md"), prompt);

    const results = await Promise.all(
      round.reviewers.map(async (run) => {
        run.status = "running";
        run.started_at = now();
        this.saveRun(id, n, run);
        try {
          const res = await runAdapter(this.config.adapters[run.name], {
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

    // Reload state written meanwhile (e.g. cancel), then apply results.
    const fresh = this.store.load(id);
    const freshRound = fresh.rounds.find((r) => r.n === n)!;
    const findings: Finding[] = [];
    for (const { run, output } of results) {
      if (output) {
        for (const f of output.findings) {
          findings.push({
            ...f,
            finding_id: `r${n}.f${findings.length + 1}`,
            reviewer: run.label,
            round: n,
            blocking: false,
            severity: severityOf(f),
            agreement: 1,
            response: null,
          });
        }
      }
    }
    const blocking = computeBlocking(findings, {
      stage: fresh.request.stage,
      max_blocking: this.config.policy.max_blocking,
      high_blocks_always: fresh.rubric_meta.high_blocks_always === true,
    });
    findings.forEach((f, i) => (f.blocking = blocking[i]));
    freshRound.reviewers = round.reviewers;
    freshRound.findings = findings;
    freshRound.finished_at = now();
    // Canceled meanwhile, or a newer round started (after a restart marked this one failed):
    // keep this round's results but leave the review state alone.
    if (fresh.state !== "in_review" || fresh.rounds.at(-1)!.n !== n) return this.store.save(fresh);

    fresh.state = this.stateAfterRound(fresh, freshRound);
    fresh.history.push({
      at: now(),
      event: "round_finished",
      detail: `round ${n}: ${findings.filter((f) => f.blocking).length} blocking, ${findings.filter((f) => !f.blocking).length} advisory, state ${fresh.state}`,
    });
    this.store.save(fresh);
  }

  private stateAfterRound(review: Review, round: Round): ReviewState {
    if (round.reviewers.every((r: ReviewerRun) => r.status === "failed")) return "failed";
    const openBlocking = round.findings.some((f) => f.blocking);
    if (!openBlocking) return review.rubric_meta.require_signoff === true ? "awaiting_signoff" : "approved";
    if (round.n >= this.config.policy.max_rounds) return "escalated";
    return "changes_requested";
  }
}
