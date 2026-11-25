// Runs a git snapshot in a worker thread: diffing and copying a large project is synchronous work,
// and on the main thread it would hold up the MCP server, the inbox and the review id.
import { parentPort, workerData } from "node:worker_threads";
import { NoChangesError, snapshotGit, type GitSpec } from "./git.js";

const { spec, reviewDir, round } = workerData as { spec: GitSpec; reviewDir: string; round: number };
try {
  parentPort!.postMessage({ ok: true, result: snapshotGit(spec, reviewDir, round) });
} catch (err) {
  parentPort!.postMessage({ ok: false, noChanges: err instanceof NoChangesError, message: err instanceof Error ? err.message : String(err) });
}
