// The change summary reviewers read (r<n>/change.md): changed files, notes and the diff, with
// lockfile and binary diffs left out and the diff cut at MAX_DIFF_CHARS. Used inside the git worker.
import path from "node:path";
import type { GitInfo } from "./git.js";

/** Largest diff put into the prompt; reviewers read the rest from the tree copy. */
const MAX_DIFF_CHARS = 120_000;

const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/;

/**
 * The diff text for the prompt: lockfile and binary diffs are left out (reviewers can still read
 * those files in tree/), because they use up the prompt budget without telling a reviewer much.
 */
export function promptDiff(patch: string): { text: string; omitted: string[] } {
  const parts = patch.split(/(?=^diff --git )/m);
  const omitted: string[] = [];
  const kept = parts.filter((part) => {
    const file = part.match(/^diff --git a\/(.+?) b\//)?.[1];
    if (file && (LOCKFILE.test(file) || /^GIT binary patch$/m.test(part) || /^Binary files /m.test(part))) {
      omitted.push(file);
      return false;
    }
    return true;
  });
  return { text: kept.join(""), omitted };
}

export function changeMarkdown(info: GitInfo, patch: string): string {
  const files = info.files.map((f) => `- ${f.status} ${f.path}`).join("\n");
  const { text, omitted } = promptDiff(patch);
  const diff = text.length > MAX_DIFF_CHARS ? text.slice(0, MAX_DIFF_CHARS) + "\n[diff truncated: read the changed files under tree/]\n" : text;
  const omittedNote = omitted.length ? `Note: lockfile and binary diffs left out of this prompt (the files are in tree/): ${omitted.join(", ")}\n` : "";
  return `Repository: ${path.basename(info.repo_root)}${info.branch ? `, branch ${info.branch}` : ""}
Mode: ${info.mode === "all" ? "all (the whole project at HEAD, every file shown as new)" : info.mode}${info.base_ref ? `, base ${info.base_ref} (${info.base_sha.slice(0, 12)})` : ""}
Changed files (${info.files.length}, +${info.insertions} -${info.deletions}):
${files}
${info.notes.map((n) => `Note: ${n}`).join("\n")}
${omittedNote}
${diff}`;
}

