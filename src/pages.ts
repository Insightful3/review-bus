// Rendered page snapshots for webpage review: screenshots at desktop and mobile width, plus facts a
// screenshot cannot show (meta tags, alt text, broken internal links, console errors).
// The review-bus server drives the browser; reviewers only read the resulting files.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
}

export const DEFAULT_BROWSER: BrowserConfig = { channel: "chrome", executable_path: null, timeout_seconds: 30, max_height: 16000, tile_height: 1800 };

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
        await page.evaluate(async (maxHeight: number) => {
          const until = Date.now() + 15_000;
          for (let y = 0, i = 0; y < Math.min(document.body.scrollHeight, maxHeight) && i < 200 && Date.now() < until; y += window.innerHeight, i++) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 50));
          }
          window.scrollTo(0, 0);
        }, cfg.max_height);
        await page.waitForTimeout(300);
        const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        const height = Math.min(fullHeight, cfg.max_height);
        const shots: PageInfo["screenshots"] = [];
        for (let y = 0, t = 1; y < height; y += cfg.tile_height, t++) {
          const h = Math.min(cfg.tile_height, height - y);
          const file = `${dirRel}/${name}-${vp.name}-${t}.png`;
          const png = await page.screenshot({ fullPage: true, clip: { x: 0, y, width: vp.width, height: h }, animations: "disabled" });
          writeFileSync(path.join(reviewDir, file), png);
          hash.update(png);
          shots.push({ viewport: vp.name, file, width: vp.width, y, height: h, page_height: fullHeight, truncated: fullHeight > cfg.max_height });
        }

        if (!info) {
          const facts = await page.evaluate(() => {
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
          });
          // Check same-origin links (max 40) without leaving the site.
          const origin = new URL(page.url()).origin;
          const internal = facts.links.filter((h) => h.startsWith(origin)).map((h) => h.split("#")[0]);
          const toCheck = [...new Set(internal)].slice(0, 40);
          const broken: PageInfo["broken_links"] = [];
          for (const href of toCheck) {
            try {
              const r = await ctx.request.get(href, { timeout: 10000, maxRedirects: 5 });
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
            links_checked: toCheck.length,
            console_errors: [],
            screenshots: [],
            text_file: textFile,
          };
        }
        info.screenshots.push(...shots);
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
