#!/usr/bin/env node
// rb: review-bus for people. Same engine and storage as the MCP server.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { Engine } from "./engine.js";
import type { GitSpec } from "./git.js";
import type { Stage } from "./policy.js";
import { Effort, type ReviewerSpec } from "./settings.js";
import { renderSummary } from "./store.js";
import type { AuthorInfo, Review, ReviewState } from "./types.js";

const USAGE = `rb: submit work for review by other agents, and answer the findings.

Usage:
  rb submit <file> --rubric <name> --intent <text> [options]
  rb submit --git <repo> [--mode uncommitted|base|commit|all] [--base <branch>] [--commit <sha>] --rubric <name> --intent <text> [options]
  rb submit --page <url> [--page <url>...] --rubric webpage --intent <text> [options]
  rb status <review_id>
  rb show <review_id>
  rb list [--state <state>] [--limit <n>]
  rb respond <review_id> <finding_id>=<accepted|rejected|deferred>[:note] ... [--resubmit] [--artifact <file>]
  rb signoff <review_id> --by <your name> [--note <text>]
  rb cancel <review_id>

Submit options:
  --reviewer <name[:model[:effort]]>   repeatable; default: default_reviewers from config
  --page <url>                         repeatable; render and screenshot (start your dev server first)
  --related <file>                     repeatable; compare against, not under review
  --assumption <text>                  repeatable
  --criterion <text>                   repeatable
  --stage draft|pre-merge|release      default pre-merge

submit and respond --resubmit wait until the reviewers finish (Ctrl-C cancels the review).
Exit codes: 0 approved or awaiting sign-off, 2 changes requested, escalated or failed, 1 error.
Config: REVIEW_BUS_CONFIG, else ~/.review-bus/config.json, else ./review-bus.config.json.`;

/** A person at the terminal: no vendor, so no reviewer is filtered out and no note is added. */
const PERSON: AuthorInfo = { client: "rb", vendor: null, vendor_source: "person" };

function fail(msg: string): never {
  console.error(`rb: ${msg}`);
  process.exit(1);
}

function parseReviewer(s: string): ReviewerSpec {
  const [name, model, effort] = s.split(":");
  if (!name) fail(`bad --reviewer "${s}"`);
  if (effort && !Effort.safeParse(effort).success) fail(`bad effort "${effort}" in --reviewer ${s}`);
  return { name, ...(model ? { model } : {}), ...(effort ? { effort: effort as Effort } : {}) };
}

function exitCodeFor(state: ReviewState): number {
  return state === "approved" || state === "awaiting_signoff" ? 0 : 2;
}

/** Waits for the round in this process, printing each reviewer as it finishes. Ctrl-C cancels. */
async function follow(engine: Engine, id: string): Promise<Review> {
  // Ctrl-C cancels the review and waits until its reviewers have really stopped (a reviewer that
  // ignores SIGTERM is killed after 5 s); a second Ctrl-C exits at once.
  let interrupted = false;
  const onInt = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    try {
      engine.cancel(id);
      console.error(`\nrb: canceling ${id}, waiting for reviewers to stop (Ctrl-C again to quit now)`);
    } catch {
      /* already finished */
    }
    void engine.settled(id).then(() => {
      console.error(`rb: canceled ${id}`);
      process.exit(130);
    });
  };
  process.on("SIGINT", onInt);
  const reported = new Set<string>();
  const t0 = Date.now();
  let review = engine.get(id);
  console.error(`rb: ${id} round ${review.rounds.length}, reviewers: ${review.rounds.at(-1)!.reviewers.map((r) => r.label).join(", ")}`);
  while (review.state === "in_review" && !interrupted) {
    await engine.waitFor(id, 5);
    review = engine.get(id);
    for (const r of review.rounds.at(-1)!.reviewers) {
      if ((r.status === "done" || r.status === "failed") && !reported.has(r.name)) {
        reported.add(r.name);
        console.error(`rb: ${r.label} ${r.status}${r.error ? `: ${r.error}` : ""} (${Math.round((Date.now() - t0) / 1000)} s)`);
      }
    }
  }
  if (interrupted) await new Promise(() => {}); // the Ctrl-C handler exits once reviewers stopped
  process.off("SIGINT", onInt);
  return review;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }
  const { values: v, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      rubric: { type: "string" },
      intent: { type: "string" },
      git: { type: "string" },
      mode: { type: "string" },
      base: { type: "string" },
      commit: { type: "string" },
      reviewer: { type: "string", multiple: true },
      page: { type: "string", multiple: true },
      related: { type: "string", multiple: true },
      assumption: { type: "string", multiple: true },
      criterion: { type: "string", multiple: true },
      stage: { type: "string" },
      state: { type: "string" },
      limit: { type: "string" },
      resubmit: { type: "boolean" },
      artifact: { type: "string" },
      by: { type: "string" },
      note: { type: "string" },
    },
  });
  const engine = new Engine(loadConfig());
  const id = () => pos[0] ?? fail(`${cmd} needs a review_id`);

  switch (cmd) {
    case "submit": {
      if (!v.rubric) fail("submit needs --rubric");
      if (!v.intent) fail("submit needs --intent");
      const stage = (v.stage ?? "pre-merge") as Stage;
      if (!["draft", "pre-merge", "release"].includes(stage)) fail(`bad --stage "${stage}"`);
      let artifact: { path?: string; git?: GitSpec } | null = null;
      if (v.git) {
        const mode = (v.mode ?? "uncommitted") as GitSpec["mode"];
        if (!["uncommitted", "base", "commit", "all"].includes(mode)) fail(`bad --mode "${mode}"`);
        artifact = { git: { repo: v.git, mode, ...(v.base ? { base: v.base } : {}), ...(v.commit ? { commit: v.commit } : {}) } };
      } else if (pos[0]) {
        artifact = { path: path.resolve(pos[0]) };
      }
      const review = await engine.submit(
        {
          artifact,
          pages: v.page ?? [],
          related: (v.related ?? []).map((r) => path.resolve(r)),
          rubric: v.rubric,
          intent: v.intent,
          assumptions: v.assumption ?? [],
          criteria: v.criterion ?? [],
          reviewers: (v.reviewer ?? []).map(parseReviewer),
          stage,
        },
        PERSON,
      );
      const done = await follow(engine, review.id);
      console.log(renderSummary(done, true));
      process.exitCode = exitCodeFor(done.state);
      return;
    }
    case "status": {
      const r = engine.get(id());
      const round = r.rounds.at(-1);
      const blocking = round?.findings.filter((f) => f.blocking) ?? [];
      console.log(`${r.id}  ${r.state}  round ${round?.n ?? 0}`);
      for (const x of round?.reviewers ?? []) console.log(`  ${x.label}: ${x.status}${x.error ? ` (${x.error})` : ""}`);
      console.log(`  findings: ${blocking.length} blocking (${blocking.filter((f) => !f.response).length} unanswered), ${(round?.findings.length ?? 0) - blocking.length} advisory`);
      return;
    }
    case "show": {
      const r = engine.get(id());
      console.log(readFileSync(path.join(engine.store.dir(r.id), "report.md"), "utf8"));
      return;
    }
    case "list": {
      const state = v.state as ReviewState | undefined;
      for (const r of engine.list(state, Number(v.limit ?? 20))) {
        console.log(`${r.id}  ${r.state.padEnd(17)}  r${r.rounds.length}  ${r.request.rubric.padEnd(14)}  ${r.created_at.slice(0, 16).replace("T", " ")}`);
      }
      return;
    }
    case "respond": {
      const reviewId = id();
      const responses = pos.slice(1).map((p) => {
        const m = p.match(/^(r\d+\.f\d+)=(accepted|rejected|deferred)(?::([\s\S]*))?$/);
        if (!m) fail(`bad answer "${p}"; use <finding_id>=<accepted|rejected|deferred>[:note], for example r1.f2=rejected:"Intentional"`);
        return { finding_id: m[1], status: m[2] as "accepted" | "rejected" | "deferred", note: m[3] ?? "" };
      });
      const { review, unanswered } = await engine.respond(reviewId, responses, { resubmit: Boolean(v.resubmit), artifact: v.artifact ? path.resolve(v.artifact) : undefined });
      if (v.resubmit) {
        const done = await follow(engine, reviewId);
        console.log(renderSummary(done, true));
        process.exitCode = exitCodeFor(done.state);
        return;
      }
      console.log(`${review.id}  ${review.state}${unanswered.length ? `  unanswered blocking: ${unanswered.join(", ")}` : ""}`);
      process.exitCode = exitCodeFor(review.state);
      return;
    }
    case "signoff": {
      if (!v.by) fail("signoff needs --by <your name>");
      const r = engine.signoff(id(), v.by, v.note ?? "");
      console.log(`${r.id}  ${r.state}  signed off by ${r.signoff?.by}`);
      return;
    }
    case "cancel": {
      const r = engine.cancel(id());
      console.log(`${r.id}  ${r.state}`);
      return;
    }
    default:
      fail(`unknown command "${cmd}". Run rb --help.`);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
