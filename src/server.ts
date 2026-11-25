#!/usr/bin/env node
import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  type CreateTaskRequestHandlerExtra,
  type TaskRequestHandlerExtra,
  type ToolTaskHandler,
} from "@modelcontextprotocol/sdk/experimental/tasks/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { Engine, isActive, onlyPullLeft } from "./engine.js";
import { GitSpec } from "./git.js";
import { ReviewerSpec, Vendor } from "./settings.js";
import { describeArtifact } from "./snapshot.js";
import { listRubrics } from "./rubrics.js";
import { renderSummary } from "./store.js";
import type { AuthorInfo, Review } from "./types.js";

/** Present when only pull reviewers are left: waiting returns at once, so say what to do instead. */
function pullHint(review: Review) {
  if (!onlyPullLeft(review)) return {};
  const round = review.rounds.at(-1);
  return {
    waiting_for_pull: (round?.reviewers ?? []).filter((r) => r.status === "waiting" || r.status === "running").map((r) => r.name),
    next: "Only pull reviewers are left; they may take hours or days. Do other work and check back later with review_status, not a review_wait loop.",
  };
}

function resultPayload(review: Review, includeAdvisory: boolean) {
  const round = review.rounds.at(-1);
  // Challenges to the author's assumptions are always shown, even when advisory (SPEC 6).
  // Findings over the blocking limit are shown too: they would block on their own.
  const findings = (round?.findings ?? []).filter((f) => includeAdvisory || f.blocking || f.over_limit || f.assumption_challenge);
  return {
    review_id: review.id,
    state: review.state,
    round: round?.n ?? 0,
    snapshot_sha256: round?.snapshot.sha256 ?? null,
    author: review.author,
    notice: typeof review.rubric_meta.report_notice === "string" ? review.rubric_meta.report_notice : null,
    notes: review.notes,
    reviewers: (round?.reviewers ?? []).map((r) => ({
      name: r.name,
      label: r.label,
      vendor: r.vendor,
      model: r.model,
      model_source: r.model_reported ? "reported" : r.model_source,
      effort: r.effort,
      effort_source: r.effort_reported ? "reported" : r.effort_source,
      status: r.status,
      verdict: r.verdict,
      summary: r.summary,
      error: r.error,
    })),
    counts: {
      blocking: round?.findings.filter((f) => f.blocking).length ?? 0,
      advisory: round?.findings.filter((f) => !f.blocking).length ?? 0,
      over_limit: round?.findings.filter((f) => f.over_limit).length ?? 0,
    },
    max_blocking: round?.policy?.max_blocking ?? null,
    findings,
    ...pullHint(review),
  };
}

function reply(review: Review, includeAdvisory: boolean) {
  const payload = resultPayload(review, includeAdvisory);
  return {
    content: [
      { type: "text" as const, text: renderSummary(review, includeAdvisory) },
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function statusPayload(review: Review) {
  const round = review.rounds.at(-1);
  const blocking = round?.findings.filter((f) => f.blocking) ?? [];
  return {
    review_id: review.id,
    state: review.state,
    round: round?.n ?? 0,
    max_rounds: null as number | null,
    reviewers: (round?.reviewers ?? []).map((r) => ({
      name: r.name,
      label: r.label,
      status: r.status,
      ...(r.adapter === "pull" ? { pull: true, deadline: r.deadline ?? null, claimed_by: r.claim?.by ?? null } : {}),
    })),
    done: round?.reviewers.filter((r) => r.status === "done" || r.status === "failed").length ?? 0,
    pending: round?.reviewers.filter((r) => r.status === "pending" || r.status === "running" || r.status === "waiting").length ?? 0,
    counts: {
      blocking: blocking.length,
      advisory: (round?.findings.length ?? 0) - blocking.length,
      unanswered_blocking: blocking.filter((f) => !f.response).length,
    },
    signoff: review.signoff ?? null,
    updated_at: review.updated_at,
    ...pullHint(review),
  };
}

function jsonReply(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorReply(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
}

/** What a tool returns now, and (for a task call) what it resolves to once the review is done. */
interface Outcome {
  now: CallToolResult;
  /** Only called for task calls: plain calls never start a background wait. */
  later?: () => Promise<CallToolResult>;
}

/** Task results stay available this long; a task's lifetime counts from creation in the SDK store. */
const TASK_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * MCP Tasks (SPEC 4): review_submit, review_respond and review_wait accept task-augmented calls.
 * A task call returns a task at once and completes it when the round finishes; storing the result
 * sends notifications/tasks/status, which wakes the client instead of it polling review_wait.
 * Plain calls behave exactly as before (waits capped at max_wait_seconds).
 *
 * The SDK gives createTask the same inputs for both kinds of call, so the transport records which
 * request ids carried params.task: see trackTaskRequests.
 */
export function createServer(engine: Engine): { server: McpServer; trackTaskRequests: (transport: Transport) => void; taskStore: InMemoryTaskStore } {
  const taskStore = new InMemoryTaskStore();
  const server = new McpServer(
    { name: "review-bus", version: "0.2.0" },
    {
      capabilities: { tasks: { requests: { tools: { call: {} } } } },
      taskStore,
      taskMessageQueue: new InMemoryTaskMessageQueue(),
    },
  );
  const taskRequests = new Set<string | number>();
  const trackTaskRequests = (transport: Transport) => {
    const deliver = transport.onmessage;
    transport.onmessage = (message, extra) => {
      const m = message as { id?: string | number; method?: string; params?: { task?: unknown } };
      if (m.method === "tools/call" && m.id !== undefined && m.params?.task) taskRequests.add(m.id);
      // Opt-in diagnostics: which tool calls arrive, and whether as tasks (REVIEW_BUS_LOG=<file>).
      if (process.env.REVIEW_BUS_LOG && m.method) {
        const name = (m.params as { name?: string } | undefined)?.name;
        // Claim tokens are credentials: never written to the log.
        const params = m.params as { arguments?: Record<string, unknown> } | undefined;
        const safe = params?.arguments && "token" in params.arguments ? { ...params, arguments: { ...params.arguments, token: "[redacted]" } } : params;
        const detail = m.method === "initialize" || m.method === "server/discover" || m.method === "tools/call" || m.method?.startsWith("tasks/") ? { params: safe } : {};
        appendFileSync(process.env.REVIEW_BUS_LOG, JSON.stringify({ at: new Date().toISOString(), method: m.method, tool: name ?? null, task: Boolean(m.params?.task), ...detail }) + "\n");
      }
      deliver?.(message, extra);
    };
  };

  /** Resolves once the review's current round is over, wherever it runs. */
  const untilDone = async (id: string) => {
    // A task ends when the round does, or when only pull reviewers are left: they may take days,
    // longer than a task lives, and the result then says who is still to answer.
    while (isActive(engine.get(id).state) && !onlyPullLeft(engine.get(id))) await engine.waitFor(id, 30);
    return engine.get(id);
  };

  /**
   * How a plain call waits for a review. A client that sent a progressToken (Claude Code does) gets
   * notifications/progress every 10 s, which tells it the call is alive, so it can wait for the
   * whole round (up to max_wait_with_progress_seconds). Without one, waits stay under the usual
   * client timeout (max_wait_seconds).
   */
  interface CallContext {
    asTask: boolean;
    /** Waits up to `requested` seconds (capped as above) and returns how long it was allowed to wait. */
    wait: (id: string, requested: number) => Promise<number>;
    /** Seconds this call may still spend before answering (max_wait_seconds, minus time spent). */
    budget: () => number;
  }

  const progressText = (id: string, startedAt: number) => {
    const review = engine.get(id);
    if (review.state === "submitted") return `Taking the snapshot (rendering pages) (${Math.round((Date.now() - startedAt) / 1000)} s)`;
    const round = review.rounds.at(-1);
    const runs = round?.reviewers ?? [];
    const done = runs.filter((r) => r.status === "done" || r.status === "failed").length;
    const running = runs.filter((r) => r.status === "running").map((r) => r.label);
    const waiting = runs.filter((r) => r.status === "waiting").map((r) => r.name);
    return `Round ${round?.n ?? 0}: ${done} of ${runs.length} reviewer(s) done${running.length ? `; still working: ${running.join(", ")}` : ""}${waiting.length ? `; waiting for pull reviewer(s) to claim: ${waiting.join(", ")}` : ""} (${Math.round((Date.now() - startedAt) / 1000)} s)`;
  };

  const registerTaskTool = <Shape extends Record<string, z.ZodTypeAny>>(
    name: string,
    config: { description: string; inputSchema: Shape },
    run: (args: z.infer<z.ZodObject<Shape>>, ctx: CallContext) => Promise<Outcome>,
  ) => {
    const handler = {
        createTask: async (args: unknown, extra: CreateTaskRequestHandlerExtra) => {
          const asTask = taskRequests.delete(extra.requestId);
          const callStarted = Date.now();
          const task = await extra.taskStore.createTask({ ttl: Math.max(extra.taskRequestedTtl ?? 0, TASK_TTL_MS), pollInterval: 2000 });
          const progressToken = (extra._meta as { progressToken?: string | number } | undefined)?.progressToken;
          const ctx: CallContext = {
            asTask,
            budget: () => Math.max(0, engine.config.max_wait_seconds - (Date.now() - callStarted) / 1000),
            wait: async (id, requested) => {
              if (asTask || requested <= 0) return 0;
              if (progressToken === undefined) {
                // The whole call stays under max_wait_seconds: time already spent (for example on
                // page screenshots before the review id existed) counts.
                const seconds = Math.max(0, cap(requested) - (Date.now() - callStarted) / 1000);
                if (seconds > 0) await engine.waitFor(id, seconds);
                return Math.round(seconds);
              }
              const seconds = Math.min(requested, engine.config.max_wait_with_progress_seconds);
              const startedAt = Date.now();
              const until = startedAt + seconds * 1000;
              let step = 0;
              while (Date.now() < until && isActive(engine.get(id).state) && !onlyPullLeft(engine.get(id))) {
                await engine.waitFor(id, Math.min(10, (until - Date.now()) / 1000));
                if (!isActive(engine.get(id).state) || onlyPullLeft(engine.get(id))) break;
                await extra
                  .sendNotification({ method: "notifications/progress", params: { progressToken, progress: ++step, message: progressText(id, startedAt) } })
                  .catch(() => {});
              }
              return seconds;
            },
          };
          let outcome: Outcome;
          try {
            outcome = await run(args as z.infer<z.ZodObject<Shape>>, ctx);
          } catch (err) {
            outcome = { now: errorReply(err) };
          }
          if (asTask && outcome.later) {
            void outcome
              .later()
              .catch((err) => errorReply(err))
              .then((result) => extra.taskStore.storeTaskResult(task.taskId, "completed", result))
              .catch((err) => console.error(`review-bus: could not complete task ${task.taskId}: ${(err as Error).message}`));
            return { task };
          }
          // Plain call, or nothing to wait for: complete at once so the caller gets the answer now.
          await extra.taskStore.storeTaskResult(task.taskId, "completed", outcome.now);
          return { task: await extra.taskStore.getTask(task.taskId) };
        },
        getTask: async (_args: unknown, extra: TaskRequestHandlerExtra) => extra.taskStore.getTask(extra.taskId),
        getTaskResult: async (_args: unknown, extra: TaskRequestHandlerExtra) => (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
    };
    server.experimental.tasks.registerToolTask(name, { ...config, execution: { taskSupport: "optional" } }, handler as unknown as ToolTaskHandler<Shape>);
  };

  const cap = (seconds: number) => Math.min(seconds, engine.config.max_wait_seconds);

  // SPEC 8a: the author's vendor comes from the MCP client name unless declared.
  const detectAuthor = (declared?: Vendor): AuthorInfo => {
    const client = server.server.getClientVersion()?.name ?? null;
    if (declared) return { client, vendor: declared, vendor_source: "declared" };
    const vendor = client ? (engine.config.author_vendors[client] ?? null) : null;
    return { client, vendor, vendor_source: vendor ? "client" : "unknown" };
  };

  registerTaskTool(
    "review_submit",
    {
      description:
        "Submit work for review by other agents: a document (.md, .txt, .docx, .pdf), a git change ({git: {repo, mode}}), " +
        "and/or web pages to render and screenshot (pages: URLs, for example a local dev server). " +
        "Reviewers run read-only on a frozen snapshot. Returns review_id and state; returns the full result if the round finishes within wait_seconds " +
        "(capped at max_wait_seconds, default 50, to stay under client timeouts; clients that show progress, like Claude Code, can wait up to max_wait_with_progress_seconds, default 900: " +
        "pass wait_seconds 900 to get the finished review in one call). Otherwise poll review_wait until state is not in_review. " +
        "Called as an MCP task, it returns at once and the task completes with the result when the round finishes, or when only pull reviewers are left (waiting_for_pull: check back later with review_status).",
      inputSchema: {
        artifact: z
          .union([z.string(), z.object({ git: GitSpec })])
          .optional()
          .describe(
            'Absolute path to a document, or {"git": {"repo": "/path", "mode": "uncommitted" | "base" | "commit", "base"?: "main", "commit"?: "sha"}}. Optional when pages are given.',
          ),
        related: z
          .array(z.string())
          .max(3)
          .default([])
          .describe("Paths to documents to compare against, not under review (for example the accepted proposal when reviewing a contract)"),
        pages: z
          .array(z.string())
          .max(10)
          .default([])
          .describe("http(s) URLs to render at desktop and mobile width and screenshot, e.g. http://localhost:4321/ (start the dev server first)"),
        rubric: z.string().describe("Rubric name, e.g. proposal"),
        intent: z.string().describe("What the work is meant to achieve, in one or two sentences"),
        assumptions: z.array(z.string()).default([]),
        criteria: z.array(z.string()).default([]),
        reviewers: z
          .array(z.union([z.string(), ReviewerSpec]))
          .default([])
          .describe(
            "Reviewer names from config, or {name, model, effort} to override. Empty uses default_reviewers from a different vendor than the author.",
          ),
        author_vendor: Vendor.optional().describe("Your vendor (anthropic, openai, other). Detected from the MCP client when omitted."),
        stage: z.enum(["draft", "pre-merge", "release"]).default("pre-merge"),
        wait_seconds: z.number().int().min(0).max(3600).default(0).describe("Seconds to wait for the result; the server caps it (see the tool description)"),
      },
    },
    async (args, ctx) => {
      const submitted = await engine.submit(
        {
          artifact: args.artifact === undefined ? null : typeof args.artifact === "string" ? { path: args.artifact } : { git: args.artifact.git },
          pages: args.pages,
          related: args.related,
          rubric: args.rubric,
          intent: args.intent,
          assumptions: args.assumptions,
          criteria: args.criteria,
          reviewers: args.reviewers.map((r) => (typeof r === "string" ? { name: r } : r)),
          stage: args.stage,
        },
        detectAuthor(args.author_vendor),
        0,
        // Page screenshots must not hold back the review id past the client's timeout.
        { snapshotWaitSeconds: ctx.budget() },
      );
      await ctx.wait(submitted.id, args.wait_seconds);
      const review = engine.get(submitted.id);
      if (!isActive(review.state)) return { now: reply(review, false) };
      if (onlyPullLeft(review)) return { now: jsonReply({ ...status(review), review_id: review.id }) };
      const next =
        review.state === "submitted"
          ? "The snapshot (page screenshots) is being taken. Call review_wait with this review_id until state is neither submitted nor in_review, then review_result."
          : "Reviewers are working. Call review_wait with this review_id until state is not in_review, then review_result.";
      return {
        now: { content: [{ type: "text" as const, text: JSON.stringify({ review_id: review.id, state: review.state, next }) }] },
        later: () => untilDone(review.id).then((r) => reply(r, false)),
      };
    },
  );

  server.registerTool(
    "review_result",
    {
      description:
        "Get verdicts and findings for the latest round of a review, as a Markdown summary plus JSON. The author must answer every blocking finding.",
      inputSchema: {
        review_id: z.string(),
        include_advisory: z.boolean().default(false),
      },
    },
    async (args) => {
      try {
        return reply(engine.get(args.review_id), args.include_advisory);
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  const status = (review: Review) => ({ ...statusPayload(review), max_rounds: engine.config.policy.max_rounds });

  server.registerTool(
    "review_status",
    {
      description: "State, round, reviewers done and pending, and counts of blocking, advisory and unanswered blocking findings.",
      inputSchema: { review_id: z.string() },
    },
    async (args) => {
      try {
        return jsonReply(status(engine.get(args.review_id)));
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  registerTaskTool(
    "review_wait",
    {
      description:
        "Block until the current round finishes, only pull reviewers are left (waiting_for_pull: check back later instead of waiting), or the time runs out, then return the status. seconds is capped at max_wait_seconds (default 50), " +
        "or at max_wait_with_progress_seconds (default 900) for clients that show progress, like Claude Code; call again while state is in_review. " +
        "Called as an MCP task, it completes when the round finishes, with no cap.",
      inputSchema: { review_id: z.string(), seconds: z.number().int().min(1).max(3600).default(50) },
    },
    async (args, ctx) => {
      engine.get(args.review_id); // validates the id
      if (ctx.asTask) return { now: jsonReply(status(engine.get(args.review_id))), later: () => untilDone(args.review_id).then((r) => jsonReply(status(r))) };
      const waited = await ctx.wait(args.review_id, args.seconds);
      return { now: jsonReply({ ...status(engine.get(args.review_id)), waited_seconds: waited, ...(waited < args.seconds ? { wait_capped: true } : {}) }) };
    },
  );

  registerTaskTool(
    "review_respond",
    {
      description:
        "Answer findings of the latest round: accepted, rejected (reason required) or deferred. Every blocking finding needs an answer. " +
        "With resubmit=true, starts the next round on a fresh snapshot of the document (or of artifact, if given). " +
        "With resubmit=false and every blocking finding answered, closes the review (approved, or awaiting_signoff when the rubric requires a person; the person then signs off with rb signoff). " +
        "Called as an MCP task with resubmit=true, the task completes with the next round's result.",
      inputSchema: {
        review_id: z.string(),
        responses: z
          .array(
            z.object({
              finding_id: z.string(),
              status: z.enum(["accepted", "rejected", "deferred"]),
              note: z.string().default(""),
            }),
          )
          .default([]),
        resubmit: z.boolean().default(false),
        artifact: z.string().optional().describe("Path to the new version; defaults to the originally submitted path"),
        wait_seconds: z.number().int().min(0).max(3600).default(0).describe("Seconds to wait for the result; the server caps it (see the tool description)"),
      },
    },
    async (args, ctx) => {
      const responded = await engine.respond(args.review_id, args.responses, { resubmit: args.resubmit, artifact: args.artifact });
      if (args.resubmit) await ctx.wait(args.review_id, args.wait_seconds);
      const review = args.resubmit ? engine.get(args.review_id) : responded.review;
      const unanswered = responded.unanswered;
      if (review.state === "in_review") {
        return { now: jsonReply({ ...status(review), unanswered }), later: () => untilDone(review.id).then((r) => reply(r, false)) };
      }
      const r = reply(review, false);
      r.content.push({ type: "text" as const, text: JSON.stringify({ unanswered }) });
      return { now: r };
    },
  );

  // No review_signoff tool: sign-off stands for a person's decision, and an agent could call it with
  // any name. People sign off with `rb signoff` in their own terminal (SPEC 2).

  server.registerTool(
    "review_list",
    {
      description: "Recent reviews, newest first, optionally filtered by state.",
      inputSchema: {
        state: z
          .enum(["submitted", "in_review", "changes_requested", "awaiting_signoff", "approved", "escalated", "failed", "canceled", "needs_input"])
          .optional(),
        limit: z.number().int().min(1).max(200).default(20),
      },
    },
    async (args) => {
      try {
        const reviews = engine.list(args.state, args.limit).map((r) => ({
          review_id: r.id,
          state: r.state,
          round: r.rounds.length,
          rubric: r.request.rubric,
          artifact: describeArtifact(r.request),
          created_at: r.created_at,
          updated_at: r.updated_at,
        }));
        return jsonReply({ reviews });
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  server.registerTool(
    "review_cancel",
    {
      description: "Cancel a review. Stops running reviewers.",
      inputSchema: { review_id: z.string() },
    },
    async (args) => {
      try {
        return jsonReply(status(engine.cancel(args.review_id)));
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  server.registerTool(
    "review_rubrics",
    {
      description:
        "The rubrics you can name in review_submit, with their purpose: plain names (proposal, contract-b2b, code, ...) and rubric packs as pack/rubric. " +
        "confidential rubrics only go to reviewers approved for them; require_signoff rubrics end with a person's sign-off.",
      inputSchema: {},
    },
    async () => {
      try {
        const rubrics = listRubrics(engine.config.rubric_paths, engine.config.rubric_packs).map(({ file: _file, ...r }) => r);
        return jsonReply({ rubrics });
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  // Pull reviewers (SPEC 8b): a person or another agent fetches the work and posts the answer.
  server.registerTool(
    "review_pending",
    {
      description:
        "Work waiting for pull reviewers (reviewers configured with type pull, for example a person or an agent in another tool): " +
        "review id, round, reviewer name, rubric, intent, deadline. Claim one with review_claim.",
      inputSchema: { reviewer: z.string().optional().describe("Only this pull reviewer's work") },
    },
    async (args) => {
      try {
        return jsonReply({ pending: engine.pending(args.reviewer) });
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  server.registerTool(
    "review_claim",
    {
      description:
        "Claim a pull reviewer's work on a review. Returns the reviewer prompt (rubric, intent, the work or where to find it, output rules), " +
        "the files, the JSON Schema of the answer and a token. Review read-only, then send the answer with review_post. " +
        "Never review work you submitted yourself.",
      inputSchema: {
        review_id: z.string(),
        reviewer: z.string().describe("The pull reviewer's name from config"),
        by: z.string().describe("Who is reviewing: the person's name, or the agent and model"),
      },
    },
    async (args) => {
      try {
        const work = engine.claim(args.review_id, args.reviewer, { by: args.by, client: server.server.getClientVersion()?.name ?? null });
        const { prompt, output_schema, ...rest } = work;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(rest, null, 2) },
            { type: "text" as const, text: prompt },
            { type: "text" as const, text: JSON.stringify(output_schema) },
          ],
        };
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  server.registerTool(
    "review_release",
    {
      description: "Give up a claim of a pull reviewer's work (you cannot finish it): the work waits for a new claim.",
      inputSchema: {
        review_id: z.string(),
        reviewer: z.string(),
        by: z.string().describe("Who releases it"),
        claimed_at: z.string().describe("claimed_at of the claim you give up, from review_claim or review_pending"),
      },
    },
    async (args) => {
      try {
        return jsonReply(status(engine.release(args.review_id, args.reviewer, args.by, args.claimed_at)));
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  server.registerTool(
    "review_post",
    {
      description:
        "Send a pull reviewer's answer: output (verdict, summary, findings in the schema review_claim returned), or decline with a reason. " +
        "Needs the token from review_claim. The last answer of a round finishes it.",
      inputSchema: {
        review_id: z.string(),
        reviewer: z.string(),
        token: z.string(),
        output: z.record(z.string(), z.unknown()).optional().describe("Reviewer output JSON: {verdict, summary, findings}"),
        decline: z.string().optional().describe("Instead of output: why you cannot review this"),
        model: z.string().optional().describe("The model that reviewed, if an agent (recorded on the findings)"),
      },
    },
    async (args) => {
      try {
        if (!args.output === !args.decline) throw new Error("Give either output or decline.");
        const review = await engine.post(args.review_id, args.reviewer, args.token, { output: args.output, decline: args.decline, model: args.model });
        return jsonReply(status(review));
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  return { server, trackTaskRequests, taskStore };
}

async function main() {
  const engine = new Engine(loadConfig());
  const { server, trackTaskRequests, taskStore } = createServer(engine);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  trackTaskRequests(transport);
  // When the client disconnects, let running rounds finish (their results are saved), then clear the
  // task store's timers so the process can exit instead of waiting out task lifetimes.
  server.server.onclose = () => {
    void engine.idle().then(() => taskStore.cleanup());
  };
}

// Only as the entry point (review-bus, npm start): rb serve imports createServer from here, and a
// stdio server started on import would read rb's stdin.
const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
