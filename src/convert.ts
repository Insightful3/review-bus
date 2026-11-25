// Document to Markdown for reviewers (SPEC 3). DOCX via mammoth, PDF via pdftotext if present, else unpdf.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export type DocumentKind = "markdown" | "text" | "docx" | "pdf";

export function kindOf(ext: string): DocumentKind | null {
  switch (ext) {
    case ".md":
    case ".markdown":
      return "markdown";
    case ".txt":
      return "text";
    case ".docx":
      return "docx";
    case ".pdf":
      return "pdf";
    default:
      return null;
  }
}

export interface Converted {
  markdown: string;
  converter: string;
  warnings: string[];
}

export async function toMarkdown(file: string, kind: DocumentKind): Promise<Converted> {
  switch (kind) {
    case "markdown":
    case "text":
      return { markdown: readFileSync(file, "utf8"), converter: "none", warnings: [] };
    case "docx": {
      const res = await mammoth.convertToHtml(
        { path: file },
        { styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"] },
      );
      return {
        markdown: htmlToMarkdown(res.value),
        converter: "mammoth",
        warnings: res.messages.map((m) => m.message),
      };
    }
    case "pdf":
      return pdfToMarkdown(file);
  }
}

async function pdfToMarkdown(file: string): Promise<Converted> {
  // pdftotext keeps layout better; use it when installed. Pages are split by form feed.
  const pt = spawnSync("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (!pt.error && pt.status === 0) {
    return { markdown: pagesToMarkdown(pt.stdout.split("\f")), converter: "pdftotext", warnings: [] };
  }
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(file)));
  const { text } = await extractText(pdf, { mergePages: false });
  const warnings = text.join("").trim() ? [] : ["No text found in the PDF. It may be scanned; OCR is not supported."];
  return { markdown: pagesToMarkdown(text), converter: "unpdf", warnings };
}

/** "## Page N" headings let reviewers name the page in location.section. */
function pagesToMarkdown(pages: string[]): string {
  return pages
    .map((p, i) => ({ p: p.replace(/[ \t]+$/gm, "").trim(), n: i + 1 }))
    .filter(({ p }) => p)
    .map(({ p, n }) => `## Page ${n}\n\n${p}`)
    .join("\n\n");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|nbsp|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

interface El {
  tag: string;
  attrs: string;
  children: Node[];
}
type Node = El | string;

const VOID = new Set(["br", "img", "hr"]);

/** Parses the small, well-formed HTML mammoth produces into a tree. Unknown tags keep their children. */
function parse(html: string): El {
  const root: El = { tag: "root", attrs: "", children: [] };
  const stack: El[] = [root];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g)) {
    const top = stack.at(-1)!;
    if (m[4] !== undefined) {
      top.children.push(decode(m[4]));
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      // Close the nearest open element with this tag (and anything left open inside it).
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const el: El = { tag, attrs: m[3], children: [] };
    top.children.push(el);
    if (!VOID.has(tag) && !m[3].trim().endsWith("/")) stack.push(el);
  }
  return root;
}

const isEl = (n: Node): n is El => typeof n !== "string";
const BLOCK = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "table"]);

/** Inline content (strong, em, a, br, img) to Markdown. */
function inline(nodes: Node[]): string {
  return nodes
    .map((n) => {
      if (!isEl(n)) return n;
      const inner = inline(n.children);
      switch (n.tag) {
        case "strong":
        case "b":
          return inner.trim() ? `**${inner}**` : inner;
        case "em":
        case "i":
          return inner.trim() ? `_${inner}_` : inner;
        case "a": {
          const href = n.attrs.match(/href="([^"]*)"/)?.[1];
          return href ? `[${inner}](${decode(href)})` : inner;
        }
        case "br":
          return "  \n";
        case "img":
          return "[image]";
        default:
          return inner;
      }
    })
    .join("");
}

/** A list, nested lists included: each item's own text, then its sub-lists indented below it. */
function list(el: El, depth: number): string[] {
  const lines: string[] = [];
  let k = 0;
  for (const li of el.children) {
    if (!isEl(li) || li.tag !== "li") continue;
    k++;
    const own = li.children.filter((c) => !isEl(c) || (c.tag !== "ul" && c.tag !== "ol"));
    // A paragraph inside an item is just its text.
    const text = own.map((c) => (isEl(c) && c.tag === "p" ? inline(c.children) + " " : inline([c]))).join("").replace(/\s+/g, " ").trim();
    lines.push(`${"  ".repeat(depth)}${el.tag === "ol" ? `${k}.` : "-"} ${text}`);
    for (const sub of li.children) if (isEl(sub) && (sub.tag === "ul" || sub.tag === "ol")) lines.push(...list(sub, depth + 1));
  }
  return lines;
}

/**
 * A table on a real grid: a merged cell (rowspan/colspan) fills every position it covers, so each
 * row keeps its label and every value stays under its own column heading.
 */
function table(el: El): string | null {
  const rows: El[] = [];
  const walk = (n: El) => {
    for (const c of n.children) {
      if (!isEl(c)) continue;
      if (c.tag === "tr") rows.push(c);
      else walk(c); // thead, tbody
    }
  };
  walk(el);
  if (!rows.length) return null;
  const span = (cell: El, name: string) => Math.max(1, Math.min(50, Number(cell.attrs.match(new RegExp(`${name}="?(\\d+)`))?.[1] ?? 1)));
  const grid: string[][] = [];
  rows.forEach((tr, r) => {
    grid[r] ??= [];
    let col = 0;
    for (const cell of tr.children.filter(isEl).filter((x) => x.tag === "td" || x.tag === "th")) {
      while (grid[r][col] !== undefined) col++; // skip positions taken by a cell merged from above
      const text = blocksText(cell).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
      const rs = span(cell, "rowspan");
      const cs = span(cell, "colspan");
      for (let dr = 0; dr < rs && r + dr < rows.length; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < cs; dc++) grid[r + dr][col + dc] = text;
      }
      col += cs;
    }
  });
  const width = Math.max(...grid.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(grid[0]), line(Array(width).fill("---")), ...grid.slice(1).map(line)].join("\n");
}

/** Text of a cell or other container that may hold paragraphs and lists. */
function blocksText(el: El): string {
  return blocks(el.children).join(" ");
}

function blocks(nodes: Node[]): string[] {
  const out: string[] = [];
  let loose: Node[] = [];
  const flush = () => {
    const t = inline(loose).trim();
    if (t) out.push(t);
    loose = [];
  };
  for (const n of nodes) {
    if (!isEl(n) || !BLOCK.has(n.tag)) {
      if (isEl(n) && !["strong", "b", "em", "i", "a", "br", "img"].includes(n.tag) && n.children.some((c) => isEl(c) && BLOCK.has(c.tag))) {
        flush();
        out.push(...blocks(n.children)); // a wrapper (div, li outside a list) around blocks
      } else loose.push(n);
      continue;
    }
    flush();
    if (n.tag[0] === "h" && n.tag.length === 2) out.push(`${"#".repeat(Number(n.tag[1]))} ${inline(n.children).trim()}`);
    else if (n.tag === "p") {
      const t = inline(n.children).trim();
      if (t) out.push(t);
    } else if (n.tag === "ul" || n.tag === "ol") out.push(list(n, 0).join("\n"));
    else {
      const t = table(n);
      if (t) out.push(t);
    }
  }
  flush();
  return out;
}

/** Converts mammoth's HTML (headings, paragraphs, nested lists, tables) to Markdown. */
export function htmlToMarkdown(html: string): string {
  return blocks(parse(html).children).join("\n\n") + "\n";
}
