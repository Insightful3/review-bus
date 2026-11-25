import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_BROWSER } from "./pages.js";
import { checkEffort, DEFAULT_VENDOR, Effort, Vendor } from "./settings.js";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const AdapterConfigIn = z.object({
  type: z.enum(["command", "codex", "claude"]),
  command: z.string(),
  // For `command` these are the full args ({model} and {effort} are substituted).
  // For codex/claude they are appended to the adapter's own args.
  args: z.array(z.string()).default([]),
  timeout_seconds: z.number().positive().default(600),
  model: z.string().nullable().default(null),
  effort: Effort.nullable().default(null),
  // Defaults from type: claude=anthropic, codex=openai, command=other.
  vendor: Vendor.optional(),
});
export type AdapterConfig = Omit<z.infer<typeof AdapterConfigIn>, "vendor"> & { vendor: Vendor };

// MCP clientInfo.name -> vendor. Names checked against Claude Code 2.1.316 and Codex 0.172.0.
const DEFAULT_AUTHOR_VENDORS: Record<string, Vendor> = { "claude-code": "anthropic", "codex-mcp-client": "openai" };

const Config = z.object({
  rubric_paths: z.array(z.string()).default(["./rubrics"]),
  storage: z
    .object({
      documents: z.string().default("~/.review-bus/reviews"),
    })
    .default({ documents: "~/.review-bus/reviews" }),
  adapters: z.record(z.string(), AdapterConfigIn).default({}),
  default_reviewers: z.array(z.string()).default([]),
  author_vendors: z.record(z.string(), Vendor).default({}),
  // Rubric name -> reviewers approved for it (SPEC 9). Required for rubrics marked confidential.
  allowed_reviewers: z.record(z.string(), z.array(z.string())).default({}),
  // Headless browser for page screenshots. channel "chrome" uses the installed Google Chrome.
  browser: z
    .object({
      channel: z.string().nullable().default(DEFAULT_BROWSER.channel),
      executable_path: z.string().nullable().default(DEFAULT_BROWSER.executable_path),
      timeout_seconds: z.number().positive().default(DEFAULT_BROWSER.timeout_seconds),
      max_height: z.number().int().positive().default(DEFAULT_BROWSER.max_height),
      tile_height: z.number().int().positive().default(DEFAULT_BROWSER.tile_height),
    })
    .default(DEFAULT_BROWSER),
  // Optional: a cheap model groups duplicate findings across reviewers. Without it, conservative
  // word-based rules merge only near-identical findings.
  merge_with: z
    .object({ adapter: z.string(), model: z.string().nullable().default(null), effort: Effort.nullable().default(null) })
    .nullable()
    .default(null),
  // Longest a tool call waits before returning. MCP clients usually give up after about 60 s.
  max_wait_seconds: z.number().int().min(1).max(600).default(50),
  policy: z
    .object({
      max_blocking: z.number().int().positive().default(5),
      max_rounds: z.number().int().positive().default(3),
    })
    .default({ max_blocking: 5, max_rounds: 3 }),
});
export type Config = Omit<z.infer<typeof Config>, "adapters"> & {
  adapters: Record<string, AdapterConfig>;
  config_dir: string;
  config_file: string | null;
};

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function findConfigFile(): string | null {
  // An explicitly named config must exist: falling back silently would use a different config.
  const explicit = process.env.REVIEW_BUS_CONFIG;
  if (explicit && !existsSync(explicit)) throw new Error(`REVIEW_BUS_CONFIG points to ${explicit}, which does not exist.`);
  const candidates = [
    process.env.REVIEW_BUS_CONFIG,
    path.join(os.homedir(), ".review-bus", "config.json"),
    path.join(process.cwd(), "review-bus.config.json"),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function loadConfig(): Config {
  const file = findConfigFile();
  const raw = file ? JSON.parse(readFileSync(file, "utf8")) : {};
  const parsed = Config.parse(raw);
  const config_dir = file ? path.dirname(file) : process.cwd();
  const resolve = (p: string) => path.resolve(config_dir, expandHome(p));
  // Reviewers run with the round folder as cwd, so relative paths in a command adapter
  // ("./test/fake-reviewer.mjs") are resolved against the config file's folder.
  const isRel = (p: string) => p.startsWith("./") || p.startsWith("../") || p.startsWith("~/");
  const adapters: Record<string, AdapterConfig> = {};
  for (const [name, a] of Object.entries(parsed.adapters)) {
    checkEffort(a.type, a.effort, name);
    if (a.type === "command") {
      if (isRel(a.command)) a.command = resolve(a.command);
      a.args = a.args.map((x) => (isRel(x) ? resolve(x) : x));
    }
    adapters[name] = { ...a, vendor: a.vendor ?? DEFAULT_VENDOR[a.type] };
  }
  if (parsed.merge_with && !adapters[parsed.merge_with.adapter]) {
    throw new Error(`merge_with.adapter "${parsed.merge_with.adapter}" is not in adapters.`);
  }
  return {
    ...parsed,
    adapters,
    author_vendors: { ...DEFAULT_AUTHOR_VENDORS, ...parsed.author_vendors },
    // The repo's own generic rubrics always come first; configured paths override by name.
    rubric_paths: [path.join(PACKAGE_ROOT, "rubrics"), ...parsed.rubric_paths.map(resolve)],
    storage: { documents: resolve(parsed.storage.documents) },
    config_dir,
    config_file: file,
  };
}
