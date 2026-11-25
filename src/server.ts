#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { Engine } from "./engine.js";
import { GitSpec } from "./git.js";
import { ReviewerSpec, Vendor } from "./settings.js";
import { describeArtifact } from "./snapshot.js";
import { renderSummary } from "./store.js";
import type { AuthorInfo, Review } from "./types.js";

function resultPayload(review: Review, includeAdvisory: boolean) {
  const round = review.rounds.at(-1);
  const findings = (round?.findings ?? []).filter((f) => includeAdvisory || f.blocking);
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
    },
    findings,
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
    reviewers: (round?.reviewers ?? []).map((r) => ({ name: r.name, label: r.label, status: r.status })),
    done: round?.reviewers.filter((r) => r.status === "done" || r.status === "failed").length ?? 0,
    pending: round?.reviewers.filter((r) => r.status === "pending" || r.status === "running").length ?? 0,
    counts: {
      blocking: blocking.length,
      advisory: (round?.findings.length ?? 0) - blocking.length,
      unanswered_blocking: blocking.filter((f) => !f.response).length,
    },
    signoff: review.signoff ?? null,
    updated_at: review.updated_at,
  };
}

function jsonReply(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorReply(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
}

export function createServer(engine: Engine): McpServer {
  const server = new McpServer({ name: "review-bus", version: "0.1.0" });

  // SPEC 8a: the author's vendor comes from the MCP client name unless declared.
  const detectAuthor = (declared?: Vendor): AuthorInfo => {
    const client = server.server.getClientVersion()?.name ?? null;
    if (declared) return { client, vendor: declared, vendor_source: "declared" };
    const vendor = client ? (engine.config.author_vendors[client] ?? null) : null;
    return { client, vendor, vendor_source: vendor ? "client" : "unknown" };
  };

  server.registerTool(
    "review_submit",
    {
      description:
        "Submit work for review by other agents: a document (.md, .txt, .docx, .pdf), a git change ({git: {repo, mode}}), " +
        "and/or web pages to render and screenshot (pages: URLs, for example a local dev server). " +
        "Reviewers run read-only on a frozen snapshot. Returns review_id and state; returns the full result if the round finishes within wait_seconds.",
      inputSchema: {
        artifact: z
          .union([z.string(), z.object({ git: GitSpec })])
          .optional()
          .describe(
            'Absolute path to a document, or {"git": {"repo": "/path", "mode": "uncommitted" | "base" | "commit", "base"?: "main", "commit"?: "sha"}}. Optional when pages are given.',
          ),
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
        wait_seconds: z.number().int().min(0).max(600).default(0),
      },
    },
    async (args) => {
      try {
        const review = await engine.submit(
          {
            artifact: args.artifact === undefined ? null : typeof args.artifact === "string" ? { path: args.artifact } : { git: args.artifact.git },
            pages: args.pages,
            rubric: args.rubric,
            intent: args.intent,
            assumptions: args.assumptions,
            criteria: args.criteria,
            reviewers: args.reviewers.map((r) => (typeof r === "string" ? { name: r } : r)),
            stage: args.stage,
          },
          detectAuthor(args.author_vendor),
          args.wait_seconds,
        );
        if (review.state === "in_review") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ review_id: review.id, state: review.state }) }] };
        }
        return reply(review, false);
      } catch (err) {
        return errorReply(err);
      }
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

  server.registerTool(
    "review_wait",
    {
      description: "Block until the current round finishes or the time runs out, then return the status.",
      inputSchema: { review_id: z.string(), seconds: z.number().int().min(1).max(600).default(120) },
    },
    async (args) => {
      try {
        engine.get(args.review_id); // validates the id
        await engine.waitFor(args.review_id, args.seconds);
        return jsonReply(status(engine.get(args.review_id)));
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  server.registerTool(
    "review_respond",
    {
      description:
        "Answer findings of the latest round: accepted, rejected (reason required) or deferred. Every blocking finding needs an answer. " +
        "With resubmit=true, starts the next round on a fresh snapshot of the document (or of artifact, if given). " +
        "With resubmit=false and every blocking finding answered, closes the review (approved, or awaiting_signoff when the rubric requires a person).",
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
        wait_seconds: z.number().int().min(0).max(600).default(0),
      },
    },
    async (args) => {
      try {
        const { review, unanswered } = await engine.respond(args.review_id, args.responses, {
          resubmit: args.resubmit,
          artifact: args.artifact,
          waitSeconds: args.wait_seconds,
        });
        if (review.state === "in_review") return jsonReply({ ...status(review), unanswered });
        const r = reply(review, false);
        r.content.push({ type: "text" as const, text: JSON.stringify({ unanswered }) });
        return r;
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  server.registerTool(
    "review_signoff",
    {
      description: "A person approves a review that is awaiting_signoff or escalated. Agents must not call this on their own; pass the person's name.",
      inputSchema: { review_id: z.string(), by: z.string().describe("The person's name"), note: z.string().default("") },
    },
    async (args) => {
      try {
        return jsonReply(status(engine.signoff(args.review_id, args.by, args.note)));
      } catch (err) {
        return errorReply(err);
      }
    },
  );

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

  return server;
}

async function main() {
  const engine = new Engine(loadConfig());
  const server = createServer(engine);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
