import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AdapterConfig } from "../config.js";
import { ReviewerOutput, reviewerOutputJsonSchema } from "../spec/reviewer-output.js";
import { describeFailure, runProcess } from "./run.js";

export interface ReviewJob {
  reviewerName: string;
  prompt: string;
  /** Working dir for the reviewer: the round folder holding the document copy. */
  cwd: string;
  /** Where adapter files (schema, raw output) go. */
  outDir: string;
  model: string | null;
  effort: string | null;
  signal?: AbortSignal;
  /** Screenshots (absolute paths, inside cwd). Codex gets them attached; Claude opens them with Read. */
  images?: string[];
  /** JSON Schema for the answer; defaults to the reviewer output schema. */
  schema?: Record<string, unknown>;
  /** Claude only: "read" (Read, Grep, Glob) for reviews, "none" for tasks that need no files. */
  tools?: "read" | "none";
}

/** The CLI's JSON answer before validation, plus what it reported about itself. */
export interface RawResult {
  json: unknown;
  reportedModel: string | null;
  reportedEffort: string | null;
}

export interface AdapterResult {
  output: ReviewerOutput;
  /** Values the CLI reported it actually used; null when it does not report them. */
  reportedModel: string | null;
  reportedEffort: string | null;
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${source} did not return valid JSON`);
  }
}

function validateOutput(json: unknown, source: string): ReviewerOutput {
  const parsed = ReviewerOutput.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${source} output does not match the reviewer schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/**
 * Generic command: prompt on stdin, reviewer output JSON on stdout.
 * {model} and {effort} in args are substituted (empty string when unset); also passed as env vars.
 */
async function runCommand(cfg: AdapterConfig, job: ReviewJob): Promise<RawResult> {
  const args = cfg.args.map((a) => a.replaceAll("{model}", job.model ?? "").replaceAll("{effort}", job.effort ?? ""));
  const r = await runProcess(cfg.command, args, {
    cwd: job.cwd,
    stdin: job.prompt,
    timeoutMs: cfg.timeout_seconds * 1000,
    env: {
      REVIEW_BUS_ROUND_DIR: job.cwd,
      REVIEW_BUS_MODEL: job.model ?? "",
      REVIEW_BUS_EFFORT: job.effort ?? "",
      REVIEW_BUS_IMAGES: (job.images ?? []).join("\n"),
    },
    signal: job.signal,
  });
  writeFileSync(path.join(job.outDir, `${job.reviewerName}.raw.txt`), r.stdout);
  if (r.code !== 0 || r.timedOut) throw new Error(describeFailure(cfg.command, r));
  return { json: parseJson(r.stdout, cfg.command), reportedModel: null, reportedEffort: null };
}

/**
 * Codex: `codex exec` in a read-only sandbox, prompt on stdin, structured output via --output-schema.
 * Flags checked against `codex exec --help` on codex-cli 0.172.0.
 * --ephemeral keeps reviewer sessions (which contain the document) off disk.
 */
async function runCodex(cfg: AdapterConfig, job: ReviewJob): Promise<RawResult> {
  const schemaFile = path.join(job.outDir, `${job.reviewerName}.schema.json`);
  const outFile = path.join(job.outDir, `${job.reviewerName}.out.json`);
  writeFileSync(schemaFile, JSON.stringify(job.schema ?? reviewerOutputJsonSchema(), null, 2));
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    "--cd",
    job.cwd,
    "--output-schema",
    schemaFile,
    "--output-last-message",
    outFile,
    ...(job.model ? ["-m", job.model] : []),
    // Codex has no effort flag; this is the config key ~/.codex/config.toml uses.
    ...(job.effort ? ["-c", `model_reasoning_effort="${job.effort}"`] : []),
    // --image=<file> form: the flag takes several values, so the bare form would swallow the final "-".
    ...(job.images ?? []).map((f) => `--image=${f}`),
    ...cfg.args,
    "-", // read prompt from stdin
  ];
  const r = await runProcess(cfg.command, args, {
    cwd: job.cwd,
    stdin: job.prompt,
    timeoutMs: cfg.timeout_seconds * 1000,
    signal: job.signal,
  });
  writeFileSync(path.join(job.outDir, `${job.reviewerName}.log.txt`), `${r.stdout}\n--- stderr ---\n${r.stderr}`);
  if (r.code !== 0 || r.timedOut) throw new Error(describeFailure("codex exec", r));
  // Codex prints its session header ("model: ...", "reasoning effort: ...") in its log output.
  const log = `${r.stderr}\n${r.stdout}`;
  return {
    json: parseJson(readFileSync(outFile, "utf8"), "codex exec"),
    reportedModel: log.match(/^model:\s*(\S+)/m)?.[1] ?? null,
    reportedEffort: log.match(/^reasoning effort:\s*(\S+)/m)?.[1] ?? null,
  };
}

/**
 * Claude: `claude -p` with the prompt on stdin and structured output via --json-schema.
 * Flags checked against `claude --help` on Claude Code 2.1.316:
 * --restricted removes command-running tools, ignores user/project settings and confines file tools
 * to the working dir; --tools leaves only read tools; --permission-prompts none denies anything else.
 * The answer is in `structured_output`; the model that ran is the key of `modelUsage`.
 * Claude does not report effort, so the requested effort is recorded.
 */
async function runClaude(cfg: AdapterConfig, job: ReviewJob): Promise<RawResult> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(job.schema ?? reviewerOutputJsonSchema()),
    "--tools",
    job.tools === "none" ? "" : "Read,Grep,Glob",
    "--permission-prompts",
    "none",
    "--restricted",
    "--strict-mcp-config",
    "--no-session-persistence",
    ...(job.model ? ["--model", job.model] : []),
    ...(job.effort ? ["--effort", job.effort] : []),
    ...cfg.args,
  ];
  const r = await runProcess(cfg.command, args, {
    cwd: job.cwd,
    stdin: job.prompt,
    timeoutMs: cfg.timeout_seconds * 1000,
    signal: job.signal,
  });
  writeFileSync(path.join(job.outDir, `${job.reviewerName}.out.json`), r.stdout);
  if (r.stderr.trim()) writeFileSync(path.join(job.outDir, `${job.reviewerName}.log.txt`), r.stderr);
  if (r.code !== 0 || r.timedOut) throw new Error(describeFailure("claude -p", r));
  let envelope: { is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown; modelUsage?: Record<string, unknown> };
  try {
    envelope = JSON.parse(r.stdout);
  } catch {
    throw new Error("claude -p did not return valid JSON");
  }
  if (envelope.is_error) throw new Error(`claude -p reported an error (${envelope.subtype ?? "unknown"}): ${String(envelope.result ?? "").slice(0, 300)}`);
  if (envelope.structured_output == null) throw new Error("claude -p returned no structured_output");
  const models = Object.keys(envelope.modelUsage ?? {});
  return {
    json: envelope.structured_output,
    // Several keys can appear if Claude used a helper model; the job's model, if set, wins.
    reportedModel: (job.model && models.find((m) => m.includes(job.model!))) || models[0] || null,
    reportedEffort: null,
  };
}

function runRaw(cfg: AdapterConfig, job: ReviewJob): Promise<RawResult> {
  switch (cfg.type) {
    case "command":
      return runCommand(cfg, job);
    case "codex":
      return runCodex(cfg, job);
    case "claude":
      return runClaude(cfg, job);
  }
}

/** Runs a reviewer and validates its answer against the reviewer output schema. */
export async function runAdapter(cfg: AdapterConfig, job: ReviewJob): Promise<AdapterResult> {
  const r = await runRaw(cfg, job);
  return { output: validateOutput(r.json, cfg.type === "command" ? cfg.command : `${cfg.type} adapter`), reportedModel: r.reportedModel, reportedEffort: r.reportedEffort };
}

/** Runs an adapter for a task with its own JSON Schema (for example merging findings). The caller validates. */
export function runStructured(cfg: AdapterConfig, job: ReviewJob & { schema: Record<string, unknown> }): Promise<RawResult> {
  return runRaw(cfg, job);
}
