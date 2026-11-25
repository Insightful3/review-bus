#!/usr/bin/env node
// Fake merge model for tests: groups findings whose claims mention the same percentage or are
// identical, one per reviewer per group, like the real merge prompt asks. --fake-mode=bad answers
// with an id in two groups; --fake-mode=fail exits with an error.
const mode = process.argv.find((a) => a.startsWith("--fake-mode="))?.split("=")[1];
const sleep = Number(process.argv.find((a) => a.startsWith("--sleep="))?.split("=")[1] ?? 0);
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", async () => {
  if (sleep) await new Promise((r) => setTimeout(r, sleep));
  if (mode === "fail") process.exit(3);
  const items = [...input.matchAll(/^- (f\d+) \(reviewer ([^)]+)\) \[[^\]]*\] (.*?) Quote:/gm)].map((m) => ({ id: m[1], reviewer: m[2], claim: m[3] }));
  if (mode === "bad") {
    process.stdout.write(JSON.stringify({ groups: [[items[0].id], [items[0].id]] }));
    return;
  }
  const key = (c) => c.match(/\d+%/)?.[0] ?? c;
  const groups = [];
  for (const it of items) {
    const g = groups.find((g) => key(g[0].claim) === key(it.claim) && g.every((x) => x.reviewer !== it.reviewer));
    if (g) g.push(it);
    else groups.push([it]);
  }
  process.stdout.write(JSON.stringify({ groups: groups.map((g) => g.map((x) => x.id)) }));
});
