import { spawn } from "node:child_process";

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a command with the prompt on stdin. Never uses a shell. */
export function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; stdin: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal, // review_cancel kills the reviewer
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
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
