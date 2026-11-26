import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InlineDoc } from "./types.js";

/** The most text one inline document may carry (characters). */
export const INLINE_MAX_CHARS = 1_000_000;
const TEXT_EXT = [".md", ".markdown", ".txt"];

/**
 * Checks an inline document and returns its file name: a plain name (no folders), .md when it has
 * no extension. Only text formats: a .docx or .pdf needs a path on this machine.
 */
export function inlineName(doc: InlineDoc): string {
  const raw = doc.name.trim();
  if (!raw || raw !== path.basename(raw) || raw.startsWith(".") || !/^[\p{L}\p{N} ._()-]{1,100}$/u.test(raw)) {
    throw new Error(`Inline document name "${doc.name}" must be a plain file name like post.md (letters, digits, spaces, . _ - ( ), no folders).`);
  }
  const ext = path.extname(raw).toLowerCase();
  const name = ext ? raw : `${raw}.md`;
  if (!TEXT_EXT.includes(path.extname(name).toLowerCase())) {
    throw new Error(`Inline document "${raw}": only ${TEXT_EXT.join(", ")} can be sent as text. Give a path for .docx or .pdf.`);
  }
  if (!doc.content.trim()) throw new Error(`Inline document "${raw}" is empty.`);
  if (doc.content.length > INLINE_MAX_CHARS) throw new Error(`Inline document "${raw}" is longer than ${INLINE_MAX_CHARS} characters. Give a path instead.`);
  return name;
}

/**
 * Writes inline documents into base (a folder the caller has just created for this attempt alone),
 * one numbered subfolder each, owner-only, and returns their paths in order. Every document is
 * checked before anything is written; nothing existing is ever overwritten.
 */
export function writeInline(base: string, docs: InlineDoc[]): string[] {
  const files = inlinePaths(base, docs);
  docs.forEach((doc, i) => {
    mkdirSync(path.dirname(files[i]), { mode: 0o700 });
    writeFileSync(files[i], doc.content, { mode: 0o600, flag: "wx" });
  });
  return files;
}

/** Where writeInline puts each document under base (checks every document, writes nothing). */
export function inlinePaths(base: string, docs: InlineDoc[]): string[] {
  return docs.map(inlineName).map((name, i) => path.join(base, String(i + 1).padStart(2, "0"), name));
}

/**
 * A log-safe copy of review_submit's or review_respond's artifact: a path or a git change as given,
 * a document as text by its name and length only. Anything else (a malformed value the schema will
 * refuse) is replaced whole: the log is written before the call is validated.
 */
export function logSafeArtifact(value: unknown, allowGit = true): unknown {
  if (value === undefined || typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (allowGit && Object.keys(v).length === 1 && "git" in v) {
      // Only the known git fields, as short text: anything nested is dropped.
      const g = typeof v.git === "object" && v.git !== null ? (v.git as Record<string, unknown>) : {};
      const git: Record<string, string> = {};
      for (const k of ["repo", "mode", "base", "commit"]) if (typeof g[k] === "string") git[k] = (g[k] as string).slice(0, 300);
      return { git };
    }
    if ("content" in v || "name" in v) {
      return { name: typeof v.name === "string" ? v.name.slice(0, 100) : "[redacted]", content: typeof v.content === "string" ? `[${v.content.length} characters]` : "[redacted]" };
    }
  }
  return "[redacted]";
}

/** The same for related: a list of paths and texts; anything else is replaced whole. */
export function logSafeRelated(value: unknown): unknown {
  if (value === undefined) return value;
  return Array.isArray(value) ? value.map((x) => logSafeArtifact(x, false)) : "[redacted]";
}

export function isInline(x: unknown): x is InlineDoc {
  return typeof x === "object" && x !== null && typeof (x as InlineDoc).content === "string" && typeof (x as InlineDoc).name === "string";
}
