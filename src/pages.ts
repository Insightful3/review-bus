// Rendered page snapshots for webpage review: screenshots at desktop and mobile width, plus facts a
// screenshot cannot show (meta tags, alt text, broken internal links, console errors).
// The review-bus server drives the browser; reviewers only read the resulting files.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import net from "node:net";
import path from "node:path";

export interface BrowserConfig {
  /** Playwright channel, e.g. "chrome" uses the installed Google Chrome (no browser download). */
  channel: string | null;
  executable_path: string | null;
  timeout_seconds: number;
  /** Longer pages are cut off here (and say so). */
  max_height: number;
  /** Screenshots are split into tiles of this height so text stays readable for the model. */
  tile_height: number;
  /** Extra Chrome command-line flags (advanced; tests use --host-resolver-rules). */
  args: string[];
}

export const DEFAULT_BROWSER: BrowserConfig = { channel: "chrome", executable_path: null, timeout_seconds: 30, max_height: 16000, tile_height: 1800, args: [] };

/** Loopback, private, link-local, carrier-grade NAT and unspecified addresses (IPv4 and IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

const privateHostCache = new Map<string, Promise<boolean>>();

/** Whether a URL's host is (or resolves to) a private address. Names that do not resolve count as public. */
export function urlIsPrivate(url: string): Promise<boolean> {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") return Promise.resolve(false);
    host = u.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return Promise.resolve(false);
  }
  if (net.isIP(host)) return Promise.resolve(isPrivateAddress(host));
  if (host === "localhost" || host.endsWith(".localhost")) return Promise.resolve(true);
  let cached = privateHostCache.get(host);
  if (!cached) {
    cached = lookup(host, { all: true }).then(
      (addrs) => addrs.some((a) => isPrivateAddress(a.address)),
      () => false,
    );
    privateHostCache.set(host, cached);
  }
  return cached;
}

const VIEWPORTS = [
  { name: "desktop", width: 1366, height: 900, isMobile: false },
  { name: "mobile", width: 390, height: 844, isMobile: true },
] as const;

export interface PageInfo {
  url: string;
  final_url: string;
  status: number | null;
  title: string;
  description: string | null;
  lang: string | null;
  canonical: string | null;
  og: Record<string, string>;
  headings: string[];
  images_missing_alt: string[];
  broken_links: { href: string; status: number | string }[];
  links_checked: number;
  console_errors: string[];
  /** Requests a public page made to private addresses, which were blocked. */
  blocked_requests: string[];
  screenshots: { viewport: string; file: string; width: number; y: number; height: number; page_height: number; truncated: boolean }[];
  text_file: string;
}

const slug = (url: string, i: number) => {
  const u = new URL(url);
  const s = (u.pathname.replace(/\/$/, "") || "home").replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
  return `${String(i + 1).padStart(2, "0")}-${s || "home"}`;
};

/** Turns a browser navigation error into one line that says what to do. */
export function pageLoadError(url: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(msg)) {
    return `Nothing is answering at ${url}. Start the site first (for example your dev server with npm run dev), then submit again.`;
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(msg)) return `The host in ${url} could not be found. Check the address.`;
  if (/Timeout|timed out/i.test(msg)) return `${url} did not finish loading in time. Check that the site responds, or raise browser.timeout_seconds.`;
  return `Could not load ${url}: ${msg.split("\n")[0]}`;
}

export function checkPageUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Only http and https pages can be reviewed: ${url}`);
}

/** Captures every page into r<n>/pages. Returns the facts and a hash of all screenshots and text. */
export async function capturePages(urls: string[], reviewDir: string, round: number, cfg: BrowserConfig): Promise<{ pages: PageInfo[]; sha256: string }> {
  urls.forEach(checkPageUrl);
  let pw: typeof import("playwright-core");
  try {
    pw = await import("playwright-core");
  } catch {
    throw new Error("Page review needs the playwright-core package (npm install playwright-core).");
  }
  let browser: import("playwright-core").Browser;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      // Playwright turns Chrome's own sandbox off by default; pages can be untrusted.
      chromiumSandbox: true,
      args: cfg.args,
      ...(cfg.executable_path ? { executablePath: cfg.executable_path } : cfg.channel ? { channel: cfg.channel } : {}),
    });
  } catch (err) {
    throw new Error(
      `Could not start the browser (${cfg.executable_path ?? cfg.channel ?? "bundled chromium"}). ` +
        `Install Google Chrome or set "browser" in config. ${(err as Error).message.split("\n")[0]}`,
    );
  }
  const dirRel = `r${round}/pages`;
  const dirAbs = path.join(reviewDir, dirRel);
  mkdirSync(dirAbs, { recursive: true });
  const hash = createHash("sha256");
  const pages: PageInfo[] = [];
  try {
    for (const [i, url] of urls.entries()) {
      const name = slug(url, i);
      let info: PageInfo | null = null;
      for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          isMobile: vp.isMobile,
          hasTouch: vp.isMobile,
          deviceScaleFactor: 1,
          // Screenshots should not depend on the reviewer's machine.
          locale: "en-US",
          colorScheme: "light",
          reducedMotion: "reduce",
        });
        // A public page must not reach private addresses (your machine, your network) and get their
        // content captured and sent to reviewers. Direct requests are blocked. Redirect hops are not
        // visible to request routing, so a redirect into a private address refuses the capture.
        // A submitted page that is itself private (a local dev server) is not restricted.
        const blocked: string[] = [];
        const redirectChecks: Promise<string | null>[] = [];
        if (!(await urlIsPrivate(url))) {
          await ctx.route("**/*", async (route) => {
            const target = route.request().url();
            if (await urlIsPrivate(target)) {
              if (!blocked.includes(target)) blocked.push(target);
              return route.abort("blockedbyclient");
            }
            return route.continue();
          });
          ctx.on("request", (req) => {
            const from = req.redirectedFrom();
            if (from) redirectChecks.push(urlIsPrivate(req.url()).then((p) => (p ? `${from.url()} -> ${req.url()}` : null)));
          });
        }
        const page = await ctx.newPage();
        const consoleErrors: string[] = [];
        page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
        page.on("pageerror", (e) => consoleErrors.push(String(e.message).slice(0, 300)));
        const timeout = cfg.timeout_seconds * 1000;
        let response;
        try {
          response = await page.goto(url, { waitUntil: "networkidle", timeout });
        } catch {
          try {
            response = await page.goto(url, { waitUntil: "load", timeout });
          } catch (err) {
            throw new Error(pageLoadError(url, err));
          }
        }
        // Lazy images: scroll down and back so they load before the screenshot. Bounded by the
        // screenshot height, 200 steps and 15 s, so an infinite-scroll page cannot hang the capture.
        // Every in-page step has a deadline: a page's scripts can leave an evaluation pending forever.
        // On expiry the error propagates and the browser is closed below.
        const within = async <T,>(work: Promise<T>, what: string): Promise<T> => {
          let timer: NodeJS.Timeout | undefined;
          try {
            return await Promise.race([
              work,
              new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${url}: ${what} did not finish within ${cfg.timeout_seconds} s.`)), cfg.timeout_seconds * 1000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        await within(page.evaluate(async (maxHeight: number) => {
          const until = Date.now() + 15_000;
          for (let y = 0, i = 0; y < Math.min(document.body.scrollHeight, maxHeight) && i < 200 && Date.now() < until; y += window.innerHeight, i++) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 50));
          }
          window.scrollTo(0, 0);
        }, cfg.max_height), "scrolling to load images");
        await page.waitForTimeout(300);
        const intoPrivate = (await Promise.all(redirectChecks)).filter((x): x is string => x !== null);
        if (intoPrivate.length) {
          throw new Error(
            `${url} redirected into a private address (${intoPrivate[0]}). Page capture stopped, so nothing from that address is sent to reviewers.`,
          );
        }
        const fullHeight = await within(page.evaluate(() => document.documentElement.scrollHeight), "measuring the page");
        const height = Math.min(fullHeight, cfg.max_height);
        const shots: PageInfo["screenshots"] = [];
        for (let y = 0, t = 1; y < height; y += cfg.tile_height, t++) {
          const h = Math.min(cfg.tile_height, height - y);
          const file = `${dirRel}/${name}-${vp.name}-${t}.png`;
          const png = await within(page.screenshot({ fullPage: true, clip: { x: 0, y, width: vp.width, height: h }, animations: "disabled" }), "taking a screenshot");
          writeFileSync(path.join(reviewDir, file), png);
          hash.update(png);
          shots.push({ viewport: vp.name, file, width: vp.width, y, height: h, page_height: fullHeight, truncated: fullHeight > cfg.max_height });
        }

        if (!info) {
          const facts = await within(page.evaluate(() => {
            const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content") ?? null;
            const og: Record<string, string> = {};
            document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]').forEach((m) => {
              const k = m.getAttribute("property") ?? m.getAttribute("name");
              if (k) og[k] = m.getAttribute("content") ?? "";
            });
            return {
              title: document.title,
              description: meta('meta[name="description"]'),
              lang: document.documentElement.getAttribute("lang"),
              canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
              og,
              headings: [...document.querySelectorAll("h1, h2, h3")].slice(0, 40).map((h) => `${h.tagName.toLowerCase()}: ${(h as HTMLElement).innerText.trim().slice(0, 120)}`),
              images_missing_alt: [...document.querySelectorAll("img")].filter((img) => !img.hasAttribute("alt")).map((img) => img.getAttribute("src") ?? "(no src)").slice(0, 30),
              links: [...new Set([...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href))],
              text: document.body.innerText,
            };
          }), "reading the page facts");
          // Check same-origin links (max 40) without leaving the site.
          const origin = new URL(page.url()).origin;
          // Same origin by parsed URL (a prefix match would let localhost:4321.example.com through).
          const sameOrigin = (h: string) => {
            try {
              return new URL(h).origin === origin;
            } catch {
              return false;
            }
          };
          const internal = facts.links.filter(sameOrigin).map((h) => h.split("#")[0]);
          const toCheck = [...new Set(internal)].slice(0, 40);
          const broken: PageInfo["broken_links"] = [];
          for (const href of toCheck) {
            try {
              // No redirects: a same-origin link that redirects elsewhere is not followed off-site.
              const r = await ctx.request.get(href, { timeout: 10000, maxRedirects: 0 });
              if (r.status() >= 400) broken.push({ href, status: r.status() });
            } catch (e) {
              broken.push({ href, status: (e as Error).message.split("\n")[0].slice(0, 80) });
            }
          }
          const textFile = `${dirRel}/${name}.txt`;
          writeFileSync(path.join(reviewDir, textFile), facts.text.slice(0, 60000));
          hash.update(facts.text);
          info = {
            url,
            final_url: page.url(),
            status: response?.status() ?? null,
            title: facts.title,
            description: facts.description,
            lang: facts.lang,
            canonical: facts.canonical,
            og: facts.og,
            headings: facts.headings,
            images_missing_alt: facts.images_missing_alt,
            broken_links: broken,
            blocked_requests: [],
            links_checked: toCheck.length,
            console_errors: [],
            screenshots: [],
            text_file: textFile,
          };
        }
        info.screenshots.push(...shots);
        for (const b of blocked) if (!info.blocked_requests.includes(b)) info.blocked_requests.push(b);
        for (const e of consoleErrors) if (!info.console_errors.includes(e)) info.console_errors.push(e);
        await ctx.close();
      }
      pages.push(info!);
    }
  } finally {
    await browser.close();
  }
  return { pages, sha256: hash.digest("hex") };
}
