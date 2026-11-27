import { readFileSync, writeFileSync } from "node:fs";
import { cp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
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
  /** The prompt's previous round and Decided earlier sections on their own (v0.4): codex-review's converter needs them for repeats. */
  earlier?: string;
  /** Git rounds: the reviewers' copy of the project and the patch (absolute paths). Needed by codex-review. */
  git?: { tree: string; patch: string; gitlinks?: { path: string; sha: string }[] };
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
/**
 * Git in the codex-review scratch repo, with the user's and system config ignored. Asynchronous, so
 * preparing a large copy never blocks the server, and bounded by the reviewer's deadline.
 */
function scratchGit(cwd: string, args: string[], deadline: number, input?: Buffer, signal?: AbortSignal): Promise<void> {
  return bounded(
    "git",
    [
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false",
      "-c", "user.name=review-bus", "-c", "user.email=review-bus@localhost", "-c", "init.defaultBranch=main",
      ...args,
    ],
    cwd,
    deadline,
    `git ${args[0]}`,
    input,
    signal,
  );
}

/**
 * Runs a command for the codex-review preparation: killed when the reviewer's deadline passes or the
 * review is canceled, so preparing a large copy never outlives the reviewer.
 */
function bounded(command: string, args: string[], cwd: string, deadline: number, label: string, input?: Buffer, signal?: AbortSignal): Promise<void> {
  const left = deadline - Date.now();
  if (signal?.aborted) return Promise.reject(new Error("canceled"));
  if (left <= 0) return Promise.reject(new Error("codex-review ran out of time preparing its scratch repo (timeout_seconds)."));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...envWithoutGit(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let expired = false;
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      expired = true;
      stop();
    }, left);
    signal?.addEventListener("abort", stop, { once: true });
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (expired) reject(new Error("codex-review ran out of time preparing its scratch repo (timeout_seconds)."));
      else if (signal?.aborted) reject(new Error("canceled"));
      else if (code !== 0) reject(new Error(`${label} in the codex-review copy failed: ${stderr.trim().split("\n")[0]}`));
      else resolve();
    });
    child.stdin!.on("error", () => {}); // the command may exit before reading all input
    child.stdin!.end(input ?? "");
  });
}

/** Undoes git's C-style path quoting: \\ \" \t \n and the like, and \ooo octal bytes. */
function cUnquote(s: string): Buffer {
  const out: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      out.push(s.charCodeAt(i) & 0xff);
      continue;
    }
    const n = s[i + 1];
    if (/[0-7]/.test(n ?? "") && /^[0-7]{3}$/.test(s.slice(i + 1, i + 4))) {
      out.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (n !== undefined && n in simple) {
      out.push(simple[n]);
      i += 1;
    } else {
      out.push(92);
    }
  }
  return Buffer.from(out);
}

/**
 * Submodule pointers as they are after the change: the "+Subproject commit" side of each gitlink
 * in the patch. The paths come from the "+++ b/..." lines (simple quoting handled).
 */
export function gitlinksAfter(patch: Buffer): { path: string; sha: string }[] {
  const out: { path: string; sha: string }[] = [];
  let target: string | null = null;
  // Only a file git itself marks as a submodule (mode 160000 in the header, before the first hunk)
  // counts; a "Subproject commit" line in an ordinary file's content is just text.
  let gitlink = false;
  let inHeader = false;
  for (const line of patch.toString("latin1").split("\n")) {
    if (line.startsWith("diff --git ")) {
      target = null;
      gitlink = false;
      inHeader = true;
    } else if (inHeader && line.startsWith("@@")) {
      inHeader = false;
    } else if (inHeader && (/^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/.test(line) || /^(new file|new) mode 160000$/.test(line))) {
      gitlink = true;
    } else if (inHeader && line.startsWith("+++ ")) {
      // Git C-quotes paths with special or non-ASCII characters ("b/caf\303\251"): decode to bytes.
      const raw = Buffer.from(line.slice(4), "latin1").toString("latin1").trim();
      const unq = raw.startsWith('"') && raw.endsWith('"') ? cUnquote(raw.slice(1, -1)) : Buffer.from(raw, "latin1");
      const text = unq.toString("utf8");
      target = text.startsWith("b/") ? text.slice(2) : null;
    } else if (!inHeader && gitlink && target && /^\+Subproject commit [0-9a-f]{40,64}$/.test(line)) {
      out.push({ path: target, sha: line.split(" ").at(-1)! });
    }
  }
  return out;
}

/** The earlier findings for the converter, passed on their own: never cut out of the prompt (an answer may contain any heading). */
export function earlierFindings(earlier: string | undefined): string {
  return earlier?.trim() ? `\nEarlier findings (for repeats only; do not review them):\n${earlier}\n` : "";
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
- repeats: when a comment raises the same point as one of the earlier findings listed after the review (if any), that finding's id; else null.
- verdict: changes_requested when there are findings, else approve. summary: the review's overall summary sentence.

<review>
`;

/**
 * The scratch repo for codex-review: a copy of the reviewers' tree (by cp, a subprocess bounded by
 * the deadline; -P keeps symlinks as they are, so a relative link still matches the patch), the base
 * committed and the change staged.
 */
async function prepareScratch(job: ReviewJob, native: string, deadline: number): Promise<void> {
  await bounded("cp", ["-R", "-P", job.git!.tree, native], path.dirname(native), deadline, "copying the project", undefined, job.signal);
  const patch = await readFile(job.git!.patch);
  const git = (args: string[], input?: Buffer) => scratchGit(native, args, deadline, input, job.signal);
  await git(["init", "-q"]);
  // The project's .gitattributes came along with the copy. info/attributes wins over it: no filters
  // (their commands would come from the user's config when Codex runs git), no line-ending or
  // encoding conversion, so the scratch repo's diff is exactly the patch. (--attr-source, used for
  // the author's repo, crashes git 2.54 in a repo without commits.)
  writeFileSync(path.join(native, ".git", "info", "attributes"), "* -filter -text -ident -working-tree-encoding\n");
  // The index starts as the changed project: every file of the copy (-f: tracked in the project even
  // where its .gitignore matches), plus the changed submodule pointers, which the copy holds only as
  // empty folders. Reversing the patch through the index then gives the base, gitlinks included.
  await git(["add", "-A", "-f"]);
  // Every submodule pointer the snapshot recorded (unchanged ones too), then the patch's, which win.
  const links = new Map((job.git!.gitlinks ?? []).map((g) => [g.path, g.sha]));
  for (const g of gitlinksAfter(patch)) links.set(g.path, g.sha);
  for (const [p, sha] of links) await git(["update-index", "--add", "--cacheinfo", `160000,${sha},${p}`]);
  if (patch.length) await git(["apply", "-R", "--index", "--whitespace=nowarn", "-"], patch);
  await git(["commit", "-q", "--allow-empty", "-m", "base"]);
  // --index: the change is staged too, so new files that .gitignore matches are still part of it.
  if (patch.length) await git(["apply", "--index", "--whitespace=nowarn", "-"], patch);
  if (deadline - Date.now() < 5000) throw new Error("codex-review ran out of time preparing its scratch repo (timeout_seconds); Codex was not started.");
}

/**
 * Codex's native code review (\`codex exec review --uncommitted\`), off by default (SPEC 8). It needs
 * a git repo, so the adapter builds one inside the round folder: a copy of the reviewers' tree with
 * the base committed and the change left uncommitted. Nothing touches the author's repo. Its answer
 * is text (it ignores --output-schema and takes no prompt together with --uncommitted, checked on
 * codex-cli 0.172.0), so a second, ordinary codex exec pass converts it into findings.
 */
async function runCodexReview(cfg: AdapterConfig, job: ReviewJob): Promise<RawResult> {
  if (!job.git) throw new Error("codex-review reviews git changes only; use the codex reviewer for documents and pages.");
  // One deadline for everything (scratch repo, review, conversion): the reviewer's timeout_seconds,
  // so the round never runs longer than other processes allow for it.
  const deadline = Date.now() + cfg.timeout_seconds * 1000;
  const native = path.join(job.outDir, `${job.reviewerName}.native`);
  await rm(native, { recursive: true, force: true });
  try {
    await prepareScratch(job, native, deadline);
  } catch (err) {
    // Stopped (deadline, cancel, failure): leave no half-made copy behind.
    await rm(native, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  const outFile = path.join(job.outDir, `${job.reviewerName}.native.md`);

  const args = ["exec", "review", "--uncommitted", ...codexIsolation(), "--output-last-message", outFile, ...codexModelArgs(job), ...cfg.args];
  const r = await runProcess(cfg.command, args, { cwd: native, stdin: "", timeoutMs: Math.max(1000, deadline - Date.now()), signal: job.signal });
  writeFileSync(path.join(job.outDir, `${job.reviewerName}.log.txt`), `${r.stdout}\n--- stderr ---\n${r.stderr}`);
  if (r.code !== 0 || r.timedOut) throw new Error(describeFailure("codex exec review", r));
  const text = readFileSync(outFile, "utf8").trim();
  if (!text) throw new Error("codex exec review returned no review text");
  const left = Math.floor((deadline - Date.now()) / 1000);
  if (left < 5) throw new Error(`codex exec review used the reviewer's time (timeout_seconds ${cfg.timeout_seconds}); no time was left to convert its answer.`);
  const converted = await runCodex(
    { ...cfg, timeout_seconds: left },
    { ...job, reviewerName: `${job.reviewerName}.convert`, prompt: `${CONVERT_PROMPT}${text}\n</review>\n${earlierFindings(job.earlier)}`, images: [], git: undefined },
  );
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

/**
 * Antigravity CLI reviewers are held read-only by deny rules, which win over any allow rule in the
 * user's own agy settings: no file writes, no shell commands, no MCP tools. Headless, a tool that
 * needs approval is refused anyway, but agy writes files in its default mode without asking (seen
 * with agy 1.5.18), and its plan mode returned no answer. Reading files in the round folder stays
 * allowed (the prompt, screenshots, the project copy).
 */
export const AGY_READ_ONLY = { permissions: { deny: ["write_file(/)", "command(regex:.*)", "mcp(*)"] } };
/**
 * What agy gets as -p. The prompt itself (the document under review) is written to agy-prompt.md in the
 * round folder, which only the owner can read: command-line arguments can be seen by other users of
 * the machine, and are limited in size.
 */
export const AGY_INSTRUCTION =
  "Your full instructions and the work to review are in the file agy-prompt.md in the current folder. Open it with your file viewing tool (do not run shell commands), follow it, and return only JSON matching the output schema.";

/** The reviewer answer in agy's response: the last line that is a JSON object (agy can print an earlier attempt first). */
export function agyAnswer(response: string): unknown {
  const text = response.trim();
  try {
    return JSON.parse(text);
  } catch {
    // Several attempts, one per line: the last one that parses.
  }
  for (const line of text.split("\n").reverse()) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") return v;
    } catch {
      // not JSON
    }
  }
  return undefined;
}

async function runAgy(cfg: AdapterConfig, job: ReviewJob): Promise<RawResult> {
  const schemaFile = path.join(job.outDir, `${job.reviewerName}.schema.json`);
  writeFileSync(schemaFile, JSON.stringify(job.schema ?? reviewerOutputJsonSchema()));
  writeFileSync(path.join(job.cwd, "agy-prompt.md"), job.prompt, { mode: 0o600 });
  const args = [
    "-p",
    AGY_INSTRUCTION,
    "--output-format",
    "json",
    "--json-schema",
    schemaFile,
    "--sandbox",
    "--disable-slash-commands",
    "--settings",
    JSON.stringify(AGY_READ_ONLY),
    ...(job.model ? ["--model", job.model] : []),
    ...(job.effort ? ["--effort", job.effort] : []),
    ...cfg.args,
  ];
  const r = await runProcess(cfg.command, args, { cwd: job.cwd, stdin: "", timeoutMs: cfg.timeout_seconds * 1000, signal: job.signal });
  writeFileSync(path.join(job.outDir, `${job.reviewerName}.out.json`), r.stdout);
  if (r.stderr.trim()) writeFileSync(path.join(job.outDir, `${job.reviewerName}.log.txt`), r.stderr);
  if (r.code !== 0 || r.timedOut) throw new Error(describeFailure("agy -p", r));
  let envelope: { status?: string; response?: string; error?: unknown; denied_actions?: { display_name?: string; action?: string }[] };
  try {
    envelope = JSON.parse(r.stdout);
  } catch {
    throw new Error("agy -p did not return valid JSON");
  }
  if (envelope.status !== "SUCCESS") throw new Error(`agy -p reported ${envelope.status ?? "no status"}: ${JSON.stringify(envelope.error ?? "").slice(0, 300)}`);
  const json = agyAnswer(envelope.response ?? "");
  if (json === undefined) {
    const denied = (envelope.denied_actions ?? []).map((d) => d.display_name ?? d.action).filter(Boolean);
    throw new Error(`agy -p returned no answer${denied.length ? ` (it tried a tool reviewers may not use: ${denied.join(", ")})` : ""}`);
  }
  // agy does not report the model it used: the requested one is recorded as requested.
  return { json, reportedModel: null, reportedEffort: null };
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
    case "agy":
      return runAgy(cfg, job);
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
