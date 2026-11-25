// Git snapshots (SPEC 3). Never writes to the author's repo: patches come from `git diff`, and the
// reviewers' copy is `git archive <base>` plus the patch, inside the review folder.
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { expandHome } from "./config.js";
import { envWithoutGit } from "./env.js";

export const GitSpec = z.object({
  repo: z.string().describe("Path to the git repository"),
  mode: z
    .enum(["uncommitted", "base", "commit", "all"])
    .describe("uncommitted: working tree vs HEAD; base: branch vs base; commit: one commit; all: the whole project at HEAD"),
  base: z.string().optional().describe("For mode base: the base branch (default origin/HEAD, then main, then master)"),
  commit: z.string().optional().describe("For mode commit: the commit to review (default HEAD)"),
});
export type GitSpec = z.infer<typeof GitSpec>;

/** The git change is empty (for example everything is already pushed). */
export class NoChangesError extends Error {}

export interface ChangedFile {
  path: string;
  status: string; // A, M, D, R..., from --name-status; untracked files are A
}

export interface GitInfo {
  repo_root: string;
  mode: GitSpec["mode"];
  base_ref: string | null;
  base_sha: string;
  head_sha: string;
  branch: string | null;
  patch_file: string; // relative to review dir
  tree_dir: string; // relative to review dir
  files: ChangedFile[];
  insertions: number;
  deletions: number;
  notes: string[];
}


const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE = EMPTY_TREE_ID;

/**
 * Every git call runs hardened against the reviewed repo's own configuration, which can name
 * commands to run: attributes come from the empty tree (so no clean/smudge filters, diff drivers
 * or export rules apply) and fsmonitor is off. Checked on git 2.54: with these, a repo whose config
 * names a clean filter, a smudge filter and an fsmonitor command runs none of them during
 * diff, status, read-tree and checkout-index.
 */
const HARDEN = [
  "--no-optional-locks", // never refresh (rewrite) the author's index while inspecting it
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "protocol.allow=never",
];
const hardened = (cwd: string, args: string[]) => [...HARDEN, `--attr-source=${EMPTY_TREE_ID}`, "-C", cwd, ...args];
/** Diffs that get replayed with git apply: standard a/ b/ prefixes whatever the user's diff settings. */
const PATCH = ["diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * --attr-source replaces the repo's .gitattributes, but git still reads .git/info/attributes, and
 * a filter switched on there would run its command. Such repos are refused rather than half handled.
 */
function refuseInfoAttributes(root: string): void {
  const file = gitBuf(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"]).toString().trim();
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return; // none
  }
  if (/(^|\s)filter(=|\s|$)/m.test(text)) {
    throw new Error(`${file} switches on a git filter, which would run a command during the snapshot. Remove that line or review a clean clone.`);
  }
}
// No network and no writes into .git: a partial clone must not fetch missing objects (that contacts
// a remote and can run a configured transport command). A missing object is an error instead.
const NO_FETCH_ENV = { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
const runGit = (cwd: string, args: string[], extra: { maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync("git", hardened(cwd, args), { maxBuffer: extra.maxBuffer, env: { ...envWithoutGit(), ...NO_FETCH_ENV, ...extra.env } });

/** Runs git and returns raw bytes: patches must not be decoded (a non-UTF-8 file would change). */
function gitBuf(cwd: string, args: string[], opts: { okCodes?: number[]; env?: NodeJS.ProcessEnv } = {}): Buffer {
  const r = runGit(cwd, args, { maxBuffer: 512 * 1024 * 1024, env: opts.env });
  if (r.error) throw new Error(`git not available: ${r.error.message}`);
  if (!(opts.okCodes ?? [0]).includes(r.status ?? -1)) {
    throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim().split("\n").slice(-3).join(" | ")}`);
  }
  return r.stdout;
}

function git(cwd: string, args: string[], opts: { okCodes?: number[] } = {}): string {
  return gitBuf(cwd, args, opts).toString();
}

const tryRev = (root: string, ref: string) => {
  const r = runGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  return r.status === 0 ? r.stdout.toString().trim() : null;
};

function defaultBase(root: string): string {
  const head = runGit(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  const candidates = [head.status === 0 ? head.stdout.toString().trim() : null, "origin/main", "main", "origin/master", "master"];
  for (const c of candidates) if (c && tryRev(root, c)) return c;
  throw new Error("Could not find a base branch (tried origin/HEAD, origin/main, main, origin/master, master). Pass git.base.");
}

function parseNameStatus(out: string): ChangedFile[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return { status: parts[0], path: parts.at(-1)! };
    });
}

function countLines(patch: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { insertions, deletions };
}

/**
 * Records the change as base SHA + patch and builds the reviewers' copy at r<n>/tree.
 * Returns the info, the patch text and a hash that identifies this exact change.
 */
/** snapshotGit in a worker thread (git-worker.ts), so the event loop keeps serving meanwhile. */
export function snapshotGitAsync(spec: GitSpec, reviewDir: string, round: number): Promise<{ info: GitInfo; sha256: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./git-worker.js", import.meta.url), { workerData: { spec, reviewDir, round } });
    let settled = false;
    worker.once("message", (m: { ok: boolean; result?: { info: GitInfo; sha256: string }; noChanges?: boolean; message?: string }) => {
      settled = true;
      if (m.ok) resolve(m.result!);
      else reject(m.noChanges ? new NoChangesError(m.message) : new Error(m.message));
    });
    worker.once("error", (err) => {
      settled = true;
      reject(err);
    });
    worker.once("exit", (code) => {
      if (!settled) reject(new Error(`the git snapshot stopped unexpectedly (exit ${code})`));
    });
  });
}

export function snapshotGit(spec: GitSpec, reviewDir: string, round: number): { info: GitInfo; patch: string; sha256: string } {
  const repo = path.resolve(expandHome(spec.repo));
  const root = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  refuseInfoAttributes(root);
  const headSha = git(root, ["rev-parse", "HEAD"]).trim();
  const branchOut = runGit(root, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const branch = branchOut.status === 0 ? branchOut.stdout.toString().trim() : null;
  const notes: string[] = [];
  let baseRef: string | null = null;
  let baseSha: string;
  let patch: Buffer;
  let files: ChangedFile[];

  if (spec.mode === "uncommitted") {
    baseSha = headSha;
    baseRef = "HEAD";
    patch = gitBuf(root, [...PATCH, "HEAD"]);
    files = parseNameStatus(git(root, ["diff", "--name-status", "--no-color", "--no-relative", "HEAD"]));
    // Untracked files, as "new file" patches, without touching the index.
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    for (const f of untracked) {
      patch = Buffer.concat([patch, gitBuf(root, [...PATCH, "--no-index", "--", "/dev/null", f], { okCodes: [0, 1] })]);
      files.push({ path: f, status: "A" });
    }
  } else if (spec.mode === "base") {
    baseRef = spec.base ?? defaultBase(root);
    const baseTip = tryRev(root, baseRef);
    if (!baseTip) throw new Error(`Base "${baseRef}" not found in ${root}.`);
    baseSha = git(root, ["merge-base", baseTip, headSha]).trim();
    patch = gitBuf(root, [...PATCH, baseSha, headSha]);
    files = parseNameStatus(git(root, ["diff", "--name-status", "--no-color", "--no-relative", baseSha, headSha]));
    const commits = git(root, ["rev-list", "--count", `${baseSha}..${headSha}`]).trim();
    notes.push(`${commits} commit(s) on ${branch ?? "HEAD"} since ${baseRef}.`);
    if (git(root, ["status", "--porcelain"]).trim()) notes.push("The working tree has uncommitted changes; they are not part of this review (mode base reviews commits).");
  } else if (spec.mode === "all") {
    // The whole project at HEAD, as if every file were new (committed files only).
    baseSha = EMPTY_TREE;
    baseRef = null;
    patch = gitBuf(root, [...PATCH, EMPTY_TREE, headSha]);
    files = parseNameStatus(git(root, ["diff", "--name-status", "--no-color", "--no-relative", EMPTY_TREE, headSha]));
    if (git(root, ["status", "--porcelain"]).trim()) notes.push("The working tree has uncommitted changes; they are not part of this review (mode all reviews HEAD).");
  } else {
    const commitSha = tryRev(root, spec.commit ?? "HEAD");
    if (!commitSha) throw new Error(`Commit "${spec.commit}" not found in ${root}.`);
    baseSha = tryRev(root, `${commitSha}^`) ?? EMPTY_TREE;
    baseRef = `${commitSha.slice(0, 12)}^`;
    patch = gitBuf(root, [...PATCH, baseSha, commitSha]);
    files = parseNameStatus(git(root, ["diff", "--name-status", "--no-color", "--no-relative", baseSha, commitSha]));
  }
  if (!patch.toString("latin1").trim()) throw new NoChangesError(`No changes to review in ${root} (mode ${spec.mode}${baseRef ? ` vs ${baseRef}` : ""}).`);

  const rdir = path.join(reviewDir, `r${round}`);
  mkdirSync(rdir, { recursive: true });
  const patchFile = `r${round}/change.patch`;
  writeFileSync(path.join(reviewDir, patchFile), patch);

  // Reviewers' copy: every tracked file of the base, then the patch applied. Built with a temporary
  // index outside the repo (read-tree + checkout-index), not git archive, which drops files marked
  // export-ignore and rewrites export-subst. Nothing is written to the author's repo.
  const treeDir = `r${round}/tree`;
  const treeAbs = path.join(reviewDir, treeDir);
  mkdirSync(treeAbs, { recursive: true });
  if (baseSha !== EMPTY_TREE) {
    const env = { GIT_INDEX_FILE: path.join(rdir, ".base-index") };
    try {
      gitBuf(root, ["read-tree", baseSha], { env });
      gitBuf(root, ["checkout-index", "--all", "--force", `--prefix=${treeAbs}/`], { env });
    } finally {
      rmSync(env.GIT_INDEX_FILE, { force: true });
    }
  }
  // GIT_CEILING_DIRECTORIES stops git from treating a parent folder of the review dir as the repo.
  const apply = spawnSync("git", ["apply", "--binary", "--whitespace=nowarn", path.join(reviewDir, patchFile)], {
    cwd: treeAbs,
    env: { ...envWithoutGit(), GIT_CEILING_DIRECTORIES: path.dirname(treeAbs) },
  });
  if (apply.status !== 0) throw new Error(`Could not apply the change to the base copy: ${apply.stderr.toString().trim()}`);

  const sha256 = createHash("sha256").update(baseSha).update(patch).digest("hex");
  // Decoded only for the prompt and counts; the stored patch and the tree keep the exact bytes.
  const text = patch.toString("utf8");
  return {
    info: { repo_root: root, mode: spec.mode, base_ref: baseRef, base_sha: baseSha, head_sha: headSha, branch, patch_file: patchFile, tree_dir: treeDir, files, ...countLines(text), notes },
    patch: text,
    sha256,
  };
}
