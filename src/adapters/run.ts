import { spawn } from "node:child_process";

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Watchdog for one reviewer process group: checks every second whether the runner still exists. When
 * the runner is gone (killed, crashed: the watchdog is re-parented), it sends the group SIGTERM, then
 * SIGKILL after 5 s. It exits as soon as the group is gone. It ignores SIGINT and SIGHUP, which a
 * terminal sends to the runner's group on Ctrl-C or when it closes, so it outlives the runner.
 */
const WATCHDOG = `
const [runner, group] = process.argv.slice(1).map(Number);
process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const tick = setInterval(() => {
  if (!alive(-group)) process.exit(0);
  if (process.ppid !== runner || !alive(runner)) {
    clearInterval(tick);
    try { process.kill(-group, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-group, "SIGKILL"); } catch {} process.exit(0); }, 5000);
  }
}, 1000);
`;

/**
 * Runs a command with the prompt on stdin. Never uses a shell.
 * The reviewer runs in its own process group, so a cancel or timeout stops everything it started
 * (a CLI's own helper processes too): SIGTERM to the group, then SIGKILL after 5 s if anything is
 * still running. The promise settles only once the process has exited.
 */
export function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; stdin: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("canceled"));
      return;
    }
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group, see killTree
    });
    // A reviewer in its own process group would outlive a runner that is killed outright (SIGKILL,
    // a crash): nothing would stop it. A small watchdog in the runner's group stops it then.
    if (child.pid) {
      spawn(process.execPath, ["-e", WATCHDOG, String(process.pid), String(child.pid)], { stdio: "ignore" })
        .on("error", () => {})
        .unref();
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let canceled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    const stop = () => {
      killTree("SIGTERM");
      killTimer ??= setTimeout(() => killTree("SIGKILL"), 5000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    const onAbort = () => {
      canceled = true;
      stop();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("close", (code) => {
      done();
      // The reviewer is gone; anything it started that is still in its group goes too.
      if (canceled || timedOut) killTree("SIGKILL");
      if (canceled) reject(new Error("canceled"));
      else resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {}); // reviewer may exit before reading all input
    child.stdin.end(opts.stdin);
  });
}

export function describeFailure(cmd: string, r: ProcResult): string {
  if (r.timedOut) return `${cmd} timed out`;
  const tail = (r.stderr || r.stdout).trim().split("\n").slice(-5).join(" | ");
  return `${cmd} exited with code ${r.code}${tail ? `: ${tail}` : ""}`;
}
