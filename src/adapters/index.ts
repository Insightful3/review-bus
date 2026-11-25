import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { AdapterConfig } from "../config.js";
import { ReviewerOutput, reviewerOutputJsonSchema } from "../spec/reviewer-output.js";
import { describeFailure, runProcess } from "./run.js";
import { envWithoutGit } from "../env.js";

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
  /** Git rounds: the reviewers' copy of the project and the patch (absolute paths). Needed by codex-review. */
  git?: { tree: string; patch: string };
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
    ...codexIsolation(),
    "--color",
    "never",
    "--cd",
    job.cwd,
    "--output-schema",
    schemaFile,
    "--output-last-message",
    outFile,
    ...codexModelArgs(job),
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
  return {
    json: parseJson(readFileSync(outFile, "utf8"), "codex exec"),
    ...codexReported(`${r.stderr}\n${r.stdout}`),
  };
}

/** Model and effort flags for codex exec and codex exec review. */
function codexModelArgs(job: ReviewJob): string[] {
  return [
    ...(job.model ? ["-m", job.model] : []),
    // Codex has no effort flag; this is the config key ~/.codex/config.toml uses.
    ...(job.effort ? ["-c", `model_reasoning_effort="${job.effort}"`] : []),
  ];
}

/** Codex prints its session header ("model: ...", "reasoning effort: ...") in its log output. */
function codexReported(log: string): { reportedModel: string | null; reportedEffort: string | null } {
  return {
    reportedModel: log.match(/^model:\s*(\S+)/m)?.[1] ?? null,
    reportedEffort: log.match(/^reasoning effort:\s*(\S+)/m)?.[1] ?? null,
  };
}

/** Flags that keep a Codex reviewer read-only, read-restricted and isolated from the user's setup. */
function codexIsolation(): string[] {
  return [
    // Read-only AND read-restricted: a permission profile instead of --sandbox read-only (the two do
    // not combine). Codex's shell may read the round folder (its --cd, the workspace root) and the
    // platform paths common tools need; everything else is denied, including the rest of the home
    // folder, other reviews, Codex's own auth.json and the temp folders. Nothing is writable.
    // Checked on codex-cli 0.172.0 with canary files (permission profiles are beta in Codex).
    "-c",
    CODEX_READ_PROFILE,
    "-c",
    'default_permissions="review-bus"',
    "--skip-git-repo-check",
    "--ephemeral",
    // Isolation (checked on codex-cli 0.172.0): without these a reviewer inherits the user's
    // MCP servers (some can run code or control the computer), ChatGPT apps, plugins, hooks,
    // browser and computer use, and web access, none of which the read-only sandbox covers.
    // Login still works: auth lives in CODEX_HOME, not in config.toml.
    "--ignore-user-config",
    ...["apps", "plugins", "remote_plugin", "computer_use", "browser_use", "browser_use_external", "hooks", "image_generation"].flatMap((f) => ["--disable", f]),
    "-c",
    'web_search="disabled"',
  ];
}

/** Git with the user's and system config ignored, for the scratch repo codex-review works in. */
function scratchGit(cwd: string, args: string[], input?: Buffer): void {
  const r = spawnSync(
    "git",
    [
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false",
      "-c", "user.name=review-bus", "-c", "user.email=review-bus@localhost", "-c", "init.defaultBranch=main",
      ...args,
    ],
    { cwd, input, env: { ...envWithoutGit(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`git ${args[0]} in the codex-review copy failed: ${r.stderr.toString().trim().split("\n")[0]}`);
}

/**
 * Submodule pointers as they are after the change: the "+Subproject commit" side of each gitlink
 * in the patch. The paths come from the "+++ b/..." lines (simple quoting handled).
 */
export function gitlinksAfter(patch: Buffer): { path: string; sha: string }[] {
  const out: { path: string; sha: string }[] = [];
  let target: string | null = null;
  for (const line of patch.toString("latin1").split("\n")) {
    if (line.startsWith("diff --git ")) target = null;
    else if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      const unq = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
      target = unq.startsWith("b/") ? Buffer.from(unq.slice(2), "latin1").toString("utf8") : null;
    } else if (target && /^\+Subproject commit [0-9a-f]{40,64}$/.test(line)) {
      out.push({ path: target, sha: line.split(" ").at(-1)! });
    }
  }
  return out;
}

/** Codex's native review priorities, mapped onto the impact scale. */
const CONVERT_PROMPT = `You convert a code review into structured findings. Below is the text of a review that Codex's built-in code reviewer wrote about a change.

Rules:
- One finding per review comment. Do not add findings, drop findings or change their meaning.
- claim: the comment's title, as a plain sentence.
- failure_scenario: the concrete situation in which the problem shows, taken from the comment. If the comment gives none, write null.
- evidence: the comment's explanation.
- location.path: the file path relative to the project folder (drop everything up to and including the folder named "native"). line_start and line_end from the comment, else null. section null. quote null unless the comment quotes code exactly.
- impact: [P0] critical, [P1] high, [P2] medium, [P3] low; without a priority, medium.
- likelihood: likely, unless the comment says the problem always happens (certain) or only in rare cases (possible).
- suggested_fix: the fix the comment suggests, else null.
- assumption_challenge: false. confidence: 0.7.
- verdict: changes_requested when there are findings, else approve. summary: the review's overall summary sentence.

<review>
`;

/**
 * Codex's native code review (\`codex exec review --uncommitted\`), off by default (SPEC 8). It needs
 * a git repo, so the adapter builds one inside the round folder: a copy of the reviewers' tree with
 * the base committed and the change left uncommitted. Nothing touches the author's repo. Its answer
 * is text (it ignores --output-schema and takes no prompt together with --uncommitted, checked on
 * codex-cli 0.172.0), so a second, ordinary codex exec pass converts it into findings.
 */
async function runCodexReview(cfg: AdapterConfig, job: ReviewJob): Promise<RawResult> {
  if (!job.git) throw new Error("codex-review reviews git changes only; use the codex reviewer for documents and pages.");
  const native = path.join(job.outDir, `${job.reviewerName}.native`);
  rmSync(native, { recursive: true, force: true });
  // verbatimSymlinks: a relative link must stay relative, or the reverse patch no longer matches it.
  cpSync(job.git.tree, native, { recursive: true, verbatimSymlinks: true });
  const patch = readFileSync(job.git.patch);
  scratchGit(native, ["init", "-q"]);
  // The project's .gitattributes came along with the copy. info/attributes wins over it: no filters
  // (their commands would come from the user's config when Codex runs git), no line-ending or
  // encoding conversion, so the scratch repo's diff is exactly the patch. (--attr-source, used for
  // the author's repo, crashes git 2.54 in a repo without commits.)
  writeFileSync(path.join(native, ".git", "info", "attributes"), "* -filter -text -ident -working-tree-encoding\n");
  // The index starts as the changed project: every file of the copy (-f: tracked in the project even
  // where its .gitignore matches), plus the changed submodule pointers, which the copy holds only as
  // empty folders. Reversing the patch through the index then gives the base, gitlinks included.
  scratchGit(native, ["add", "-A", "-f"]);
  for (const g of gitlinksAfter(patch)) scratchGit(native, ["update-index", "--add", "--cacheinfo", `160000,${g.sha},${g.path}`]);
  if (patch.length) scratchGit(native, ["apply", "-R", "--index", "--whitespace=nowarn", "-"], patch);
  scratchGit(native, ["commit", "-q", "--allow-empty", "-m", "base"]);
  // --index: the change is staged too, so new files that .gitignore matches are still part of it.
  if (patch.length) scratchGit(native, ["apply", "--index", "--whitespace=nowarn", "-"], patch);

  const outFile = path.join(job.outDir, `${job.reviewerName}.native.md`);
  const args = ["exec", "review", "--uncommitted", ...codexIsolation(), "--output-last-message", outFile, ...codexModelArgs(job), ...cfg.args];
  const r = await runProcess(cfg.command, args, { cwd: native, stdin: "", timeoutMs: cfg.timeout_seconds * 1000, signal: job.signal });
  writeFileSync(path.join(job.outDir, `${job.reviewerName}.log.txt`), `${r.stdout}\n--- stderr ---\n${r.stderr}`);
  if (r.code !== 0 || r.timedOut) throw new Error(describeFailure("codex exec review", r));
  const text = readFileSync(outFile, "utf8").trim();
  if (!text) throw new Error("codex exec review returned no review text");
  const converted = await runCodex(cfg, { ...job, reviewerName: `${job.reviewerName}.convert`, prompt: `${CONVERT_PROMPT}${text}\n</review>\n`, images: [], git: undefined });
  // The review itself is what ran; the conversion is bookkeeping.
  return { json: converted.json, ...codexReported(`${r.stderr}\n${r.stdout}`) };
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
    case "codex-review":
      return runCodexReview(cfg, job);
    case "pull":
      throw new Error("pull reviewers are not run by the server; they claim their work (review_claim)");
    case "claude":
      return runClaude(cfg, job);
  }
}

/** Runs a reviewer and validates its answer against the reviewer output schema. */
/** The Codex permission profile for reviewers: read the round folder only, write nothing. */
export const CODEX_READ_PROFILE =
  'permissions.review-bus.filesystem={":root"="deny", ":minimal"="read", ":slash_tmp"="deny", ":tmpdir"="deny", ":workspace_roots"={"."="read"}}';

export async function runAdapter(cfg: AdapterConfig, job: ReviewJob): Promise<AdapterResult> {
  const r = await runRaw(cfg, job);
  return { output: validateOutput(r.json, cfg.type === "command" ? cfg.command : `${cfg.type} adapter`), reportedModel: r.reportedModel, reportedEffort: r.reportedEffort };
}

/** Runs an adapter for a task with its own JSON Schema (for example merging findings). The caller validates. */
export function runStructured(cfg: AdapterConfig, job: ReviewJob & { schema: Record<string, unknown> }): Promise<RawResult> {
  return runRaw(cfg, job);
}
