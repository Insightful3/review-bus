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
 * Writes inline documents into the review folder (source/<sub>/), owner-only, and returns their
 * paths in order. They are then snapshotted like any document. Two documents with the same name get
 * numbered folders so neither overwrites the other.
 */
export function writeInline(reviewDir: string, sub: string, docs: InlineDoc[]): string[] {
  const names = docs.map(inlineName); // every one is checked before anything is written
  return docs.map((doc, i) => {
    const dir = path.join(reviewDir, "source", sub, String(i + 1).padStart(2, "0"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, names[i]);
    writeFileSync(file, doc.content, { mode: 0o600 });
    return file;
  });
}

export function isInline(x: unknown): x is InlineDoc {
  return typeof x === "object" && x !== null && typeof (x as InlineDoc).content === "string" && typeof (x as InlineDoc).name === "string";
}
