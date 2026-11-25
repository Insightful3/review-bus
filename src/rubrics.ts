import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Effort } from "./settings.js";

export interface Rubric {
  /** As named in review_submit: "contract-b2b", or "pack/contract-b2b" for a rubric pack. */
  name: string;
  file: string;
  body: string;
  // Front matter, flat `key: value` pairs. Values parsed as JSON when possible.
  meta: Record<string, unknown>;
}

/** A folder of rubrics shared as one unit (for example one client's rubrics), addressed as pack/rubric. */
export interface RubricPack {
  name: string;
  dir: string;
  description: string | null;
  version: string | null;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

function parseFrontMatter(raw: string): { meta: Record<string, unknown>; body: string } {
  // Some editors start UTF-8 files with a byte order mark; the header must still be recognised.
  const text = raw.replace(/^\uFEFF/, "");
  // Delimiters may carry trailing spaces or tabs; the closing one must be a line of its own.
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  // An unclosed header would be read as body text, and a confidential: true in it silently ignored.
  if (!m && /^---[ \t]*\r?\n/.test(text)) throw new Error("the front matter has no closing --- line");
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  for (const [i, line] of m[1].split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    // Flat key: value lines only. An indented or malformed line is an error, not skipped: skipping
    // "  confidential: true" would silently drop the flag.
    if (!kv) throw new Error(`front matter line ${i + 2} is not a flat "key: value" line: ${line.trim().slice(0, 60)}`);
    const v = kv[2].trim();
    try {
      meta[kv[1]] = JSON.parse(v);
    } catch {
      meta[kv[1]] = v;
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * Reads a rubric pack folder: its name comes from pack.json ({"name", "description", "version"}),
 * else from the folder name.
 */
export function readPack(dir: string): RubricPack {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Rubric pack folder not found: ${dir}`);
  let info: { name?: unknown; description?: unknown; version?: unknown } = {};
  const file = path.join(dir, "pack.json");
  if (existsSync(file)) {
    try {
      info = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
    }
  }
  const name = typeof info.name === "string" ? info.name : path.basename(dir);
  if (!NAME.test(name)) throw new Error(`Rubric pack name "${name}" (${dir}) must be lowercase letters, digits and dashes.`);
  return {
    name,
    dir,
    description: typeof info.description === "string" ? info.description : null,
    version: typeof info.version === "string" ? info.version : null,
  };
}

/**
 * A plain name looks through rubricPaths, where later folders override earlier ones. "pack/name"
 * takes the rubric from that pack only.
 */
export function loadRubric(name: string, rubricPaths: string[], packs: RubricPack[] = []): Rubric {
  const [first, second, ...rest] = name.split("/");
  if (rest.length || !NAME.test(first) || (second !== undefined && !NAME.test(second))) throw new Error(`Invalid rubric name: ${name}`);
  let file: string | null = null;
  if (second !== undefined) {
    const pack = packs.find((p) => p.name === first);
    if (!pack) throw new Error(`Rubric pack "${first}" is not in rubric_packs. Packs: ${packs.map((p) => p.name).join(", ") || "(none)"}`);
    const candidate = path.join(pack.dir, `${second}.md`);
    if (!existsSync(candidate)) throw new Error(`Rubric "${second}" not found in pack ${first} (${pack.dir}).`);
    file = candidate;
  } else {
    for (const dir of rubricPaths) {
      const candidate = path.join(dir, `${name}.md`);
      if (existsSync(candidate)) file = candidate;
    }
    if (!file) throw new Error(`Rubric "${name}" not found in: ${rubricPaths.join(", ")}`);
  }
  let parsed;
  try {
    parsed = parseFrontMatter(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Rubric "${name}" (${file}): ${(err as Error).message}`);
  }
  const problems = metaProblems(parsed.meta);
  if (problems.length) throw new Error(`Rubric "${name}" (${file}) cannot be used: ${problems.join("; ")}. Run rb rubric-check on it.`);
  return { name, file, body: parsed.body.trim(), meta: parsed.meta };
}

/** The part of a rubric name approvals fall back to: "pack/contract-b2b" -> "contract-b2b". */
export function baseName(rubric: string): string {
  return rubric.split("/").at(-1)!;
}

export interface RubricInfo {
  name: string;
  file: string;
  purpose: string;
  pack: string | null;
  confidential: boolean;
  require_signoff: boolean;
}

function purposeOf(body: string): string {
  const m = body.match(/## Purpose\s*\n+([^\n]+)/);
  return (m?.[1] ?? "").trim();
}

/** Every rubric an author can name: plain names (after overrides), then pack/name. */
export function listRubrics(rubricPaths: string[], packs: RubricPack[] = []): RubricInfo[] {
  const names = new Set<string>();
  for (const dir of rubricPaths) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".md") && NAME.test(f.slice(0, -3))) names.add(f.slice(0, -3));
  }
  const all = [...names].sort();
  for (const p of packs) {
    for (const f of readdirSync(p.dir).sort()) if (f.endsWith(".md") && NAME.test(f.slice(0, -3))) all.push(`${p.name}/${f.slice(0, -3)}`);
  }
  return all.map((name) => {
    const r = loadRubric(name, rubricPaths, packs);
    return {
      name,
      file: r.file,
      purpose: purposeOf(r.body),
      pack: name.includes("/") ? name.split("/")[0] : null,
      confidential: r.meta.confidential === true,
      require_signoff: r.meta.require_signoff === true,
    };
  });
}

const FLAGS = ["require_signoff", "high_blocks_always", "confidential"];
const KNOWN = new Set([...FLAGS, "effort", "models", "report_notice", "max_blocking"]);

/**
 * Problems that would make a rubric work badly: missing sections or impact levels, front matter
 * values of the wrong type, em dashes. An empty list means the rubric is fine.
 */
export function checkRubric(text: string): string[] {
  const problems: string[] = [];
  let meta: Record<string, unknown>;
  let body: string;
  try {
    ({ meta, body } = parseFrontMatter(text));
  } catch (err) {
    return [(err as Error).message];
  }
  for (const h of ["## Purpose", "## What to check", "## Out of scope", "## Impact anchors"]) if (!body.includes(h)) problems.push(`missing section "${h}"`);
  const anchors = body.split("## Impact anchors")[1] ?? "";
  for (const level of ["critical:", "high:", "medium:", "low:"]) if (!anchors.includes(level)) problems.push(`Impact anchors lack "${level}"`);
  if (text.includes("—")) problems.push("contains an em dash");
  problems.push(...metaProblems(meta));
  return problems;
}

/**
 * Front matter values of the wrong type or with an unknown key. Checked by rb rubric-check and on
 * every load: a "confidential: \"true\"" (text) or a misspelt key must not quietly turn a
 * confidential rubric into an ordinary one.
 */
export function metaProblems(meta: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (meta.effort !== undefined && !Effort.safeParse(meta.effort).success) problems.push(`effort "${String(meta.effort)}" is not one of ${Effort.options.join(", ")}`);
  for (const k of FLAGS) if (meta[k] !== undefined && typeof meta[k] !== "boolean") problems.push(`${k} must be true or false`);
  if (meta.models !== undefined && (typeof meta.models !== "object" || meta.models === null || Object.values(meta.models).some((v) => typeof v !== "string"))) {
    problems.push(`models must be JSON, for example {"codex": "gpt-6.2-sol"}`);
  }
  if (meta.report_notice !== undefined && typeof meta.report_notice !== "string") problems.push("report_notice must be text");
  if (meta.max_blocking !== undefined && !(typeof meta.max_blocking === "number" && Number.isInteger(meta.max_blocking) && meta.max_blocking > 0)) {
    problems.push("max_blocking must be a whole number above 0");
  }
  for (const k of Object.keys(meta)) if (!KNOWN.has(k)) problems.push(`unknown front matter key "${k}"`);
  return problems;
}

/** Checks one rubric file, or every .md in a folder (a pack). Returns problems per file. */
export function checkRubricPath(target: string): { file: string; problems: string[] }[] {
  if (!existsSync(target)) throw new Error(`Not found: ${target}`);
  if (statSync(target).isDirectory()) {
    readPack(target); // the pack name must be valid
    const files = readdirSync(target).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
    if (!files.length) throw new Error(`No rubrics (.md files) in ${target}`);
    return files.map((f) => {
      const problems = checkRubric(readFileSync(path.join(target, f), "utf8"));
      if (!NAME.test(f.slice(0, -3))) problems.push("file name must be lowercase letters, digits and dashes");
      return { file: path.join(target, f), problems };
    });
  }
  return [{ file: target, problems: checkRubric(readFileSync(target, "utf8")) }];
}
