// Git snapshots (SPEC 3). Never writes to the author's repo: patches come from `git diff`, and the
// reviewers' copy is `git archive <base>` plus the patch, inside the review folder.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { expandHome } from "./config.js";

export const GitSpec = z.object({
  repo: z.string().describe("Path to the git repository"),
  mode: z
    .enum(["uncommitted", "base", "commit", "all"])
    .describe("uncommitted: working tree vs HEAD; base: branch vs base; commit: one commit; all: the whole project at HEAD"),
  base: z.string().optional().describe("For mode base: the base branch (default origin/HEAD, then main, then master)"),
  commit: z.string().optional().describe("For mode commit: the commit to review (default HEAD)"),
});
export type GitSpec = z.infer<typeof GitSpec>;

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

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Runs git and returns raw bytes: patches must not be decoded (a non-UTF-8 file would change). */
function gitBuf(cwd: string, args: string[], opts: { okCodes?: number[]; env?: NodeJS.ProcessEnv } = {}): Buffer {
  const r = spawnSync("git", ["-C", cwd, ...args], { maxBuffer: 512 * 1024 * 1024, env: opts.env ? { ...process.env, ...opts.env } : undefined });
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
  const r = spawnSync("git", ["-C", root, "rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  return r.status === 0 ? r.stdout.toString().trim() : null;
};

function defaultBase(root: string): string {
  const head = spawnSync("git", ["-C", root, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
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
export function snapshotGit(spec: GitSpec, reviewDir: string, round: number): { info: GitInfo; patch: string; sha256: string } {
  const repo = path.resolve(expandHome(spec.repo));
  const root = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  const headSha = git(root, ["rev-parse", "HEAD"]).trim();
  const branchOut = spawnSync("git", ["-C", root, "symbolic-ref", "-q", "--short", "HEAD"]);
  const branch = branchOut.status === 0 ? branchOut.stdout.toString().trim() : null;
  const notes: string[] = [];
  let baseRef: string | null = null;
  let baseSha: string;
  let patch: Buffer;
  let files: ChangedFile[];

  if (spec.mode === "uncommitted") {
    baseSha = headSha;
    baseRef = "HEAD";
    patch = gitBuf(root, ["diff", "--binary", "--no-color", "--no-ext-diff", "HEAD"]);
    files = parseNameStatus(git(root, ["diff", "--name-status", "--no-color", "HEAD"]));
    // Untracked files, as "new file" patches, without touching the index.
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    for (const f of untracked) {
      patch = Buffer.concat([patch, gitBuf(root, ["diff", "--binary", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", f], { okCodes: [0, 1] })]);
      files.push({ path: f, status: "A" });
    }
  } else if (spec.mode === "base") {
    baseRef = spec.base ?? defaultBase(root);
    const baseTip = tryRev(root, baseRef);
    if (!baseTip) throw new Error(`Base "${baseRef}" not found in ${root}.`);
    baseSha = git(root, ["merge-base", baseTip, headSha]).trim();
    patch = gitBuf(root, ["diff", "--binary", "--no-color", "--no-ext-diff", baseSha, headSha]);
    files = parseNameStatus(git(root, ["diff", "--name-status", "--no-color", baseSha, headSha]));
    const commits = git(root, ["rev-list", "--count", `${baseSha}..${headSha}`]).trim();
    notes.push(`${commits} commit(s) on ${branch ?? "HEAD"} since ${baseRef}.`);
    if (git(root, ["status", "--porcelain"]).trim()) notes.push("The working tree has uncommitted changes; they are not part of this review (mode base reviews commits).");
  } else if (spec.mode === "all") {
    // The whole project at HEAD, as if every file were new (committed files only).
    baseSha = EMPTY_TREE;
    baseRef = null;
    patch = gitBuf(root, ["diff", "--binary", "--no-color", "--no-ext-diff", EMPTY_TREE, headSha]);
    files = parseNameStatus(git(root, ["diff", "--name-status", "--no-color", EMPTY_TREE, headSha]));
    if (git(root, ["status", "--porcelain"]).trim()) notes.push("The working tree has uncommitted changes; they are not part of this review (mode all reviews HEAD).");
  } else {
    const commitSha = tryRev(root, spec.commit ?? "HEAD");
    if (!commitSha) throw new Error(`Commit "${spec.commit}" not found in ${root}.`);
    baseSha = tryRev(root, `${commitSha}^`) ?? EMPTY_TREE;
    baseRef = `${commitSha.slice(0, 12)}^`;
    patch = gitBuf(root, ["diff", "--binary", "--no-color", "--no-ext-diff", baseSha, commitSha]);
    files = parseNameStatus(git(root, ["diff", "--name-status", "--no-color", baseSha, commitSha]));
  }
  if (!patch.toString("latin1").trim()) throw new Error(`No changes to review in ${root} (mode ${spec.mode}).`);

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
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(treeAbs) },
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
