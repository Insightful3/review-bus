import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Rubric {
  name: string;
  file: string;
  body: string;
  // Front matter, flat `key: value` pairs. Values parsed as JSON when possible.
  meta: Record<string, unknown>;
}

function parseFrontMatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    try {
      meta[kv[1]] = JSON.parse(v);
    } catch {
      meta[kv[1]] = v;
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Later folders override earlier ones by rubric name. */
export function loadRubric(name: string, rubricPaths: string[]): Rubric {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid rubric name: ${name}`);
  let file: string | null = null;
  for (const dir of rubricPaths) {
    const candidate = path.join(dir, `${name}.md`);
    if (existsSync(candidate)) file = candidate;
  }
  if (!file) throw new Error(`Rubric "${name}" not found in: ${rubricPaths.join(", ")}`);
  const { meta, body } = parseFrontMatter(readFileSync(file, "utf8"));
  return { name, file, body: body.trim(), meta };
}
