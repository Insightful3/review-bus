import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { kindOf, toMarkdown } from "./convert.js";
import { snapshotGit } from "./git.js";
import { capturePages, type BrowserConfig } from "./pages.js";
import type { ArtifactRef, ReviewRequest, Snapshot } from "./types.js";

/** Largest diff put into the prompt; reviewers read the rest from the tree copy. */
const MAX_DIFF_CHARS = 120_000;

/**
 * Copies a document into the round folder, records its SHA-256 and writes the Markdown reviewers
 * read (r<n>/artifact.md). The original file is never modified.
 */
export async function snapshotDocument(sourcePath: string, reviewDir: string, round: number): Promise<Snapshot> {
  const abs = path.resolve(sourcePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`Artifact not found: ${abs}`);
  const ext = path.extname(abs).toLowerCase();
  const kind = kindOf(ext);
  if (!kind) throw new Error(`Unsupported document type "${ext}". Supported: .md, .markdown, .txt, .docx, .pdf.`);
  const data = readFileSync(abs);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const rdir = path.join(reviewDir, `r${round}`);
  mkdirSync(rdir, { recursive: true });
  const file = `r${round}/original${ext}`;
  copyFileSync(abs, path.join(reviewDir, file));
  const converted = await toMarkdown(path.join(reviewDir, file), kind);
  if (!converted.markdown.trim()) throw new Error(`No text could be read from ${abs}.`);
  const markdown_file = `r${round}/artifact.md`;
  writeFileSync(path.join(reviewDir, markdown_file), converted.markdown);
  return { source_path: abs, file, markdown_file, sha256, kind, converter: converted.converter, warnings: converted.warnings };
}

/** Snapshot for one round: a document or a git change, plus rendered pages if any. */
export async function snapshotRound(
  artifact: ArtifactRef | null,
  pages: string[],
  reviewDir: string,
  round: number,
  browser: BrowserConfig,
  related: string[] = [],
): Promise<Snapshot> {
  if (!artifact?.path && !artifact?.git && !pages.length) throw new Error("Nothing to review: give a document path, a git change or pages.");
  if (artifact?.path && artifact.git) throw new Error("Give either a document path or a git change, not both.");
  mkdirSync(path.join(reviewDir, `r${round}`), { recursive: true });

  let snap: Snapshot;
  if (artifact?.path) {
    snap = await snapshotDocument(artifact.path, reviewDir, round);
  } else if (artifact?.git) {
    const { info, patch, sha256 } = snapshotGit(artifact.git, reviewDir, round);
    const markdown_file = `r${round}/change.md`;
    writeFileSync(path.join(reviewDir, markdown_file), changeMarkdown(info, patch));
    snap = { kind: "git", sha256, markdown_file, warnings: [], git: info };
  } else {
    snap = { kind: "pages", sha256: "", markdown_file: null, warnings: [] };
  }

  if (related.length) {
    const dirRel = `r${round}/related`;
    mkdirSync(path.join(reviewDir, dirRel), { recursive: true });
    const hash = createHash("sha256").update(snap.sha256);
    snap.related = [];
    for (const [i, src] of related.entries()) {
      const abs = path.resolve(src);
      if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`Related document not found: ${abs}`);
      const kind = kindOf(path.extname(abs).toLowerCase());
      if (!kind) throw new Error(`Unsupported related document type: ${abs}. Supported: .md, .markdown, .txt, .docx, .pdf.`);
      const data = readFileSync(abs);
      const converted = await toMarkdown(abs, kind);
      const markdown_file = `${dirRel}/${String(i + 1).padStart(2, "0")}-${path.basename(abs, path.extname(abs)).replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.md`;
      writeFileSync(path.join(reviewDir, markdown_file), converted.markdown);
      const sha256 = createHash("sha256").update(data).digest("hex");
      hash.update(sha256);
      snap.related.push({ source_path: abs, markdown_file, sha256 });
      for (const w of converted.warnings) snap.warnings.push(`${path.basename(abs)}: ${w}`);
    }
    snap.sha256 = hash.digest("hex");
  }

  if (pages.length) {
    const captured = await capturePages(pages, reviewDir, round, browser);
    snap.pages = captured.pages;
    snap.sha256 = createHash("sha256").update(snap.sha256).update(captured.sha256).digest("hex");
    for (const p of captured.pages) {
      if (p.status !== null && p.status >= 400) snap.warnings.push(`${p.url} returned HTTP ${p.status}.`);
      if (p.screenshots.some((s) => s.truncated)) snap.warnings.push(`${p.url} is taller than the screenshot limit; the bottom is cut off.`);
    }
  }
  return snap;
}

function changeMarkdown(info: NonNullable<Snapshot["git"]>, patch: string): string {
  const files = info.files.map((f) => `- ${f.status} ${f.path}`).join("\n");
  const diff = patch.length > MAX_DIFF_CHARS ? patch.slice(0, MAX_DIFF_CHARS) + "\n[diff truncated: read the changed files under tree/]\n" : patch;
  return `Repository: ${path.basename(info.repo_root)}${info.branch ? `, branch ${info.branch}` : ""}
Mode: ${info.mode}${info.base_ref ? `, base ${info.base_ref} (${info.base_sha.slice(0, 12)})` : ""}
Changed files (${info.files.length}, +${info.insertions} -${info.deletions}):
${files}
${info.notes.map((n) => `Note: ${n}`).join("\n")}

${diff}`;
}

export function describeArtifact(req: ReviewRequest): string {
  const parts: string[] = [];
  if (req.artifact?.path) parts.push(req.artifact.path);
  if (req.artifact?.git) {
    const g = req.artifact.git;
    parts.push(`git ${g.repo} (${g.mode}${g.mode === "base" && g.base ? ` vs ${g.base}` : ""}${g.mode === "commit" && g.commit ? ` ${g.commit}` : ""})`);
  }
  if (req.pages.length) parts.push(`${req.pages.length} page(s): ${req.pages.join(", ")}`);
  if (req.related?.length) parts.push(`compared with ${req.related.map((r) => path.basename(r)).join(", ")}`);
  return parts.join(" + ");
}
