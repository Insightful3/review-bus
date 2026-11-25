// Runs a git snapshot in a worker thread: diffing and copying a large project is synchronous work,
// and on the main thread it would hold up the MCP server, the inbox and the review id.
import { parentPort, workerData } from "node:worker_threads";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { changeMarkdown } from "./change.js";
import { NoChangesError, snapshotGit, type GitSpec } from "./git.js";

const { spec, reviewDir, round } = workerData as { spec: GitSpec; reviewDir: string; round: number };
try {
  const { info, patch, sha256 } = snapshotGit(spec, reviewDir, round);
  writeFileSync(path.join(reviewDir, `r${round}`, "change.md"), changeMarkdown(info, patch));
  parentPort!.postMessage({ ok: true, result: { info, sha256 } });
} catch (err) {
  parentPort!.postMessage({ ok: false, noChanges: err instanceof NoChangesError, message: err instanceof Error ? err.message : String(err) });
}
