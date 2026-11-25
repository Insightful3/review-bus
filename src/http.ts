// rb serve: the MCP server over Streamable HTTP (/mcp) and a small web inbox for people (/inbox).
// One process, one Engine, one MCP session per client. Every request needs the token from
// http.token_file: as "Authorization: Bearer <token>" for /mcp, as a cookie set by the inbox login.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Engine } from "./engine.js";
import { createServer } from "./server.js";
import { answerFromForm, INBOX_JS, renderClaimPage, renderError, renderInbox, renderLogin, renderReviewPage } from "./inbox.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The token from token_file, created (random, mode 600) on first start. */
export function loadToken(file: string): string {
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  }
  chmodSync(file, 0o600);
  const token = readFileSync(file, "utf8").trim();
  if (token.length < 32) throw new Error(`The token in ${file} is shorter than 32 characters. Delete the file to get a new one.`);
  return token;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin", // no-referrer would make browsers send "Origin: null" on form posts
  "cache-control": "no-store",
};

export async function startHttp(engine: Engine, opts: { port: number; host: string }): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
  const cfg = engine.config.http;
  if (!LOOPBACK.has(opts.host) && !cfg.allow_remote) {
    throw new Error(`rb serve listens on this machine only (127.0.0.1). To listen on ${opts.host}, set http.allow_remote: true and put TLS in front: the token travels with every request.`);
  }
  const token = loadToken(cfg.token_file);
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; close: () => Promise<void> }>();
  let port = opts.port;

  /** Blocks DNS rebinding: a page on another site that resolves its name to 127.0.0.1. */
  const hostOk = (req: http.IncomingMessage) => {
    const host = (req.headers.host ?? "").toLowerCase();
    const names = [...LOOPBACK, ...cfg.allowed_hosts].map((h) => h.toLowerCase());
    return names.some((n) => host === `${n}:${port}` || host === `[${n}]:${port}` || host === n);
  };
  const originOk = (req: http.IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const u = new URL(origin);
      return hostOk({ headers: { host: u.host } } as http.IncomingMessage);
    } catch {
      return false;
    }
  };
  const cookieToken = (req: http.IncomingMessage) =>
    (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .find(([k]) => k === "rb_token")?.[1] ?? "";

  const send = (res: http.ServerResponse, status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": type, ...SECURITY_HEADERS, ...extra });
    res.end(body);
  };

  const handleMcp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !same(auth.slice(7).trim(), token)) {
      send(res, 401, JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: send Authorization: Bearer <token from http.token_file>" }, id: null }), "application/json", {
        "www-authenticate": "Bearer",
      });
      return;
    }
    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    let body: unknown;
    if (req.method === "POST") {
      const text = await readBody(req);
      try {
        body = JSON.parse(text);
      } catch {
        send(res, 400, JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }), "application/json");
        return;
      }
    }
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (sessionId || req.method !== "POST" || !isInitializeRequest(body)) {
      send(res, sessionId ? 404 : 400, JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: sessionId ? "Unknown session" : "Start with an initialize request" }, id: null }), "application/json");
      return;
    }
    const { server, trackTaskRequests, taskStore } = createServer(engine);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, {
          transport,
          close: async () => {
            await transport.close().catch(() => {});
          },
        });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      taskStore.cleanup();
    };
    await server.connect(transport);
    trackTaskRequests(transport);
    await transport.handleRequest(req, res, body);
  };

  const handleInbox = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    if (url.pathname === "/inbox/app.js") {
      send(res, 200, INBOX_JS, "text/javascript; charset=utf-8");
      return;
    }
    if (url.pathname === "/inbox/login") {
      if (req.method === "POST") {
        const form = new URLSearchParams(await readBody(req, 64 * 1024));
        if (same((form.get("token") ?? "").trim(), token)) {
          res.writeHead(303, { location: "/inbox", "set-cookie": `rb_token=${token}; HttpOnly; SameSite=Strict; Path=/`, ...SECURITY_HEADERS });
          res.end();
          return;
        }
        send(res, 401, renderLogin("That token does not match."));
        return;
      }
      send(res, 200, renderLogin(null));
      return;
    }
    if (!same(cookieToken(req), token)) {
      res.writeHead(303, { location: "/inbox/login", ...SECURITY_HEADERS });
      res.end();
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "inbox"
    try {
      if (req.method === "GET" && parts.length === 0) {
        send(res, 200, renderInbox(engine));
        return;
      }
      if (parts[0] === "review" && parts[1]) {
        const id = parts[1];
        if (req.method === "GET" && parts.length === 2) {
          send(res, 200, renderReviewPage(engine, id, url.searchParams.get("msg")));
          return;
        }
        if (req.method === "POST" && parts[2] === "signoff") {
          const form = new URLSearchParams(await readBody(req, 64 * 1024));
          engine.signoff(id, form.get("by") ?? "", form.get("note") ?? "");
          res.writeHead(303, { location: `/inbox/review/${encodeURIComponent(id)}?msg=${encodeURIComponent("Signed off.")}`, ...SECURITY_HEADERS });
          res.end();
          return;
        }
        if (req.method === "POST" && parts[2] === "release" && parts[3]) {
          const form = new URLSearchParams(await readBody(req, 64 * 1024));
          engine.release(id, parts[3], `${form.get("by") || "someone"} (web inbox)`);
          res.writeHead(303, { location: `/inbox/review/${encodeURIComponent(id)}?msg=${encodeURIComponent("Claim released.")}`, ...SECURITY_HEADERS });
          res.end();
          return;
        }
        if (req.method === "GET" && parts[2] === "file") {
          // Screenshots and Markdown of a round, nothing else (review.json holds claim tokens).
          const rel = parts.slice(3).map(decodeURIComponent).join("/");
          if (!/^r\d+\/[A-Za-z0-9._\/-]+\.(png|md)$/.test(rel) || rel.split("/").includes("..")) {
            send(res, 404, "Not found", "text/plain");
            return;
          }
          const file = path.join(engine.store.dir(id), rel);
          // A reviewed repo can track a symlink (it lands in r<n>/tree): never follow one out of the review.
          const inside = (() => {
            try {
              return realpathSync(file).startsWith(realpathSync(engine.store.dir(id)) + path.sep);
            } catch {
              return false;
            }
          })();
          if (!inside || !existsSync(file)) {
            send(res, 404, "Not found", "text/plain");
            return;
          }
          send(res, 200, readFileSync(file) as unknown as string, rel.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8");
          return;
        }
      }
      if (parts[0] === "claim" && parts[1] && parts[2]) {
        const [, id, reviewer] = parts;
        if (req.method === "POST" && parts[3] === "start") {
          const form = new URLSearchParams(await readBody(req, 64 * 1024));
          const work = engine.claim(id, reviewer, { by: form.get("by") ?? "", client: "web-inbox" });
          send(res, 200, renderClaimPage(engine, work, form.get("by") ?? ""));
          return;
        }
        if (req.method === "POST" && parts[3] === "post") {
          const form = new URLSearchParams(await readBody(req));
          const claimToken = form.get("claim_token") ?? "";
          const decline = (form.get("decline") ?? "").trim();
          if (decline) await engine.post(id, reviewer, claimToken, { decline });
          else await engine.post(id, reviewer, claimToken, { output: answerFromForm(form), model: null });
          res.writeHead(303, { location: `/inbox/review/${encodeURIComponent(id)}?msg=${encodeURIComponent(decline ? "Declined." : "Review sent.")}`, ...SECURITY_HEADERS });
          res.end();
          return;
        }
      }
      send(res, 404, "Not found", "text/plain");
    } catch (err) {
      send(res, 400, renderError((err as Error).message));
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!hostOk(req) || !originOk(req)) {
      send(res, 403, "Forbidden: unexpected Host or Origin", "text/plain");
      return;
    }
    const route = url.pathname === "/mcp" ? handleMcp(req, res) : url.pathname === "/inbox" || url.pathname.startsWith("/inbox/") ? handleInbox(req, res, url) : null;
    if (!route) {
      if (url.pathname === "/") {
        res.writeHead(303, { location: "/inbox", ...SECURITY_HEADERS });
        res.end();
      } else send(res, 404, "Not found", "text/plain");
      return;
    }
    route.catch((err) => {
      console.error(`review-bus http: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, "Internal error", "text/plain");
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const shownHost = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return {
    server,
    url: `http://${shownHost}:${port}/`,
    close: async () => {
      for (const s of sessions.values()) await s.close();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections(); // open SSE streams would keep close() waiting
      await closed;
    },
  };
}
