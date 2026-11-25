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
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]);

/** Inline HTML from mammoth (strong, em, a, br, img) to Markdown. */
function inline(html: string): string {
  return decode(
    html
      .replace(/<br\s*\/?>/g, "  \n")
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/g, "**$2**")
      .replace(/<(em|i)>([\s\S]*?)<\/\1>/g, "_$2_")
      .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)")
      .replace(/<img[^>]*>/g, "[image]")
      .replace(/<[^>]+>/g, ""),
  ).trim();
}

/**
 * Converts the small, regular HTML mammoth produces (h1-h6, p, ul/ol/li, table) to Markdown.
 * Not a general HTML converter.
 */
export function htmlToMarkdown(html: string): string {
  const out: string[] = [];
  const block = /<(h[1-6]|p|ul|ol|table)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  for (const m of html.matchAll(block)) {
    const [, tag, body] = m;
    if (tag.startsWith("h")) {
      out.push(`${"#".repeat(Number(tag[1]))} ${inline(body)}`);
    } else if (tag === "p") {
      const text = inline(body);
      if (text) out.push(text);
    } else if (tag === "ul" || tag === "ol") {
      const items = [...body.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((li, i) => `${tag === "ol" ? `${i + 1}.` : "-"} ${inline(li[1])}`);
      out.push(items.join("\n"));
    } else {
      const rows = [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((tr) =>
        [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => inline(c[1]).replace(/\|/g, "\\|").replace(/\n/g, " ")),
      );
      if (!rows.length) continue;
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
      out.push([line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n"));
    }
  }
  return out.join("\n\n") + "\n";
}
