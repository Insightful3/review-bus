import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_BROWSER } from "./pages.js";
import { readPack, type RubricPack } from "./rubrics.js";
import { checkEffort, DEFAULT_VENDOR, Effort, Vendor } from "./settings.js";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const AdapterConfigIn = z.object({
  type: z.enum(["command", "codex", "codex-review", "claude", "agy", "pull"]),
  // Not used by pull reviewers, which have no command: they fetch the work themselves.
  command: z.string().default(""),
  // Pull reviewers: MCP client names (clientInfo.name) allowed to claim their work; empty: any client.
  claim_clients: z.array(z.string()).default([]),
  // For `command` these are the full args ({model} and {effort} are substituted).
  // For codex/claude they are appended to the adapter's own args.
  args: z.array(z.string()).default([]),
  // Default 600 s; pull reviewers (people, other agents) default to 3 days.
  timeout_seconds: z.number().positive().optional(),
  model: z.string().nullable().default(null),
  effort: Effort.nullable().default(null),
  // Defaults from type: claude=anthropic, codex=openai, command=other.
  vendor: Vendor.optional(),
});
export type AdapterConfig = Omit<z.infer<typeof AdapterConfigIn>, "vendor" | "timeout_seconds"> & { vendor: Vendor; timeout_seconds: number };

// MCP clientInfo.name -> vendor. Names checked against Claude Code 2.1.316 and Codex 0.172.0. A
// key ending in * matches names starting with the rest: the Claude desktop app (chat and Cowork)
// connects as "local-agent-mode-<server name>".
const DEFAULT_AUTHOR_VENDORS: Record<string, Vendor> = { "claude-code": "anthropic", "codex-mcp-client": "openai", "local-agent-mode-*": "anthropic" };

/** Whether an MCP client name is in a list of names and prefixes ending in *. */
export function clientListed(list: string[], client: string | null): boolean {
  if (!client) return false;
  return list.some((k) => (k.endsWith("*") ? client.startsWith(k.slice(0, -1)) : k === client));
}

/** The vendor author_vendors gives an MCP client name: an exact key first, then the longest matching prefix*. */
export function vendorOfClient(map: Record<string, Vendor>, client: string): Vendor | null {
  if (Object.hasOwn(map, client)) return map[client];
  const prefixes = Object.keys(map)
    .filter((k) => k.endsWith("*") && client.startsWith(k.slice(0, -1)))
    .sort((a, b) => b.length - a.length);
  return prefixes.length ? map[prefixes[0]] : null;
}

const Config = z.object({
  rubric_paths: z.array(z.string()).default(["./rubrics"]),
  // Rubric packs: folders shared as a unit (for example one client's rubrics), named pack/rubric.
  rubric_packs: z.array(z.string()).default([]),
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
      args: z.array(z.string()).default(DEFAULT_BROWSER.args),
    })
    .default(DEFAULT_BROWSER),
  // Optional: a cheap model groups duplicate findings across reviewers. Without it, conservative
  // word-based rules merge only near-identical findings.
  merge_with: z
    .object({ adapter: z.string(), model: z.string().nullable().default(null), effort: Effort.nullable().default(null) })
    .nullable()
    .default(null),
  // rb serve: MCP over HTTP (/mcp) and the web inbox for people (/inbox), on this machine by default.
  // Every request needs the token in token_file (created on first start, readable only by you).
  http: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(7777),
      token_file: z.string().default("~/.review-bus/http-token"),
      // Listening on another address than loopback sends the token over the network: only with TLS in front.
      allow_remote: z.boolean().default(false),
      // Extra Host header values to accept (a name you reach this machine by); loopback names are always accepted.
      allowed_hosts: z.array(z.string()).default([]),
      // Behind a TLS proxy: the address people open, for example "https://reviews.example.com".
      // Browser posts must come from this origin (or from the server's own address).
      public_origin: z.string().url().nullable().default(null),
    })
    .default({ host: "127.0.0.1", port: 7777, token_file: "~/.review-bus/http-token", allow_remote: false, allowed_hosts: [], public_origin: null }),
  // A review with pages is saved first and its pages rendered in the background. review_submit waits
  // this long for the snapshot, so a page that does not load is still an error on submit; a slower
  // capture returns the review id (state submitted) and the snapshot goes on in the background.
  snapshot_wait_seconds: z.number().min(0).max(600).default(10),
  // Longest a tool call waits before returning. MCP clients usually give up after about 60 s.
  max_wait_seconds: z.number().int().min(1).max(600).default(50),
  // Longest a call waits when the client sent a progressToken: progress notifications every 10 s
  // keep it alive, so it can wait for the whole round instead of polling.
  max_wait_with_progress_seconds: z.number().int().min(1).max(3600).default(900),
  // MCP clients (names, or prefixes ending in *) that may wait up to max_wait_with_progress_seconds
  // without sending a progressToken. Only for clients known not to time out a long tool call: no
  // progress is sent to keep them alive. Empty by default.
  long_wait_clients: z.array(z.string()).default([]),
  policy: z
    .object({
      max_blocking: z.number().int().positive().default(5),
      max_rounds: z.number().int().positive().default(3),
      // "stricter": from round 2 only critical findings, and high ones that are certain or likely,
      // block (a rubric's high_blocks_always applies to round 1). "same": every round as round 1.
      later_rounds: z.enum(["stricter", "same"]).default("stricter"),
    })
    .default({ max_blocking: 5, max_rounds: 3, later_rounds: "stricter" }),
});
export type Config = Omit<z.infer<typeof Config>, "adapters" | "rubric_packs"> & {
  rubric_packs: RubricPack[];
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
  // No lookup in the current folder: a config names commands to run, and a folder (a cloned repo,
  // a download) is not a trusted source of commands. Use REVIEW_BUS_CONFIG to point at one.
  const candidates = [process.env.REVIEW_BUS_CONFIG, path.join(os.homedir(), ".review-bus", "config.json")].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Settings when there is no config file: those of the example config shipped with the package
 * (Codex and Claude as reviewers, reviews in ~/.review-bus/reviews), so review-bus works right after
 * install. Copy the example to ~/.review-bus/config.json to change them.
 */
export function builtInDefaults(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "review-bus.config.example.json"), "utf8"));
}

/** Loads the config from REVIEW_BUS_CONFIG or ~/.review-bus/config.json, or from `file` to reload the same one; without one, the built-in defaults. */
export function loadConfig(file: string | null = findConfigFile()): Config {
  const raw = file ? JSON.parse(readFileSync(file, "utf8")) : builtInDefaults();
  const parsed = Config.parse(raw);
  const config_dir = file ? path.dirname(file) : path.join(os.homedir(), ".review-bus");
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
    if (a.type !== "pull" && !a.command) throw new Error(`Adapter "${name}" needs a command.`);
    adapters[name] = { ...a, vendor: a.vendor ?? DEFAULT_VENDOR[a.type], timeout_seconds: a.timeout_seconds ?? (a.type === "pull" ? 3 * 86400 : 600) };
  }
  const rubric_packs = parsed.rubric_packs.map((p) => readPack(resolve(p)));
  const dup = rubric_packs.map((p) => p.name).find((n, i, all) => all.indexOf(n) !== i);
  if (dup) throw new Error(`Two rubric packs are named "${dup}". Give one a different name in its pack.json.`);
  if (parsed.merge_with && !adapters[parsed.merge_with.adapter]) {
    throw new Error(`merge_with.adapter "${parsed.merge_with.adapter}" is not in adapters.`);
  }
  return {
    ...parsed,
    adapters,
    author_vendors: { ...DEFAULT_AUTHOR_VENDORS, ...parsed.author_vendors },
    // The repo's own generic rubrics always come first; configured paths override by name.
    rubric_paths: [path.join(PACKAGE_ROOT, "rubrics"), ...parsed.rubric_paths.map(resolve)],
    rubric_packs,
    storage: { documents: resolve(parsed.storage.documents) },
    http: { ...parsed.http, token_file: resolve(parsed.http.token_file) },
    config_dir,
    config_file: file,
  };
}
