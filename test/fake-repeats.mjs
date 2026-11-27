#!/usr/bin/env node
// Fake repeat-check model for tests (v0.4): matches a new finding to an earlier decision with the
// same claim, like the real prompt asks. --fake-mode=fail exits with an error; --fake-mode=junk
// answers with unknown ids only.
const mode = process.argv.find((a) => a.startsWith("--fake-mode="))?.split("=")[1];
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  if (mode === "fail") process.exit(3);
  if (mode === "junk") {
    process.stdout.write(JSON.stringify({ matches: [{ candidate: "c99", decision: "r1.f1" }, { candidate: "c1", decision: "r9.f9" }] }));
    return;
  }
  const part = (from, to) => input.slice(input.indexOf(from), to ? input.indexOf(to) : undefined);
  const candidates = [...part("New findings:", "Earlier decisions:").matchAll(/^- (c\d+) \[[^\]]*\] (.*?) Quote:/gm)].map((m) => ({ id: m[1], claim: m[2] }));
  const decisions = [...part("Earlier decisions:").matchAll(/^- (\S+) \[[^\]]*\] (.*) \((?:rejected|deferred|accepted|signed_off)/gm)].map((m) => ({ ref: m[1], claim: m[2] }));
  const matches = candidates.flatMap((c) => {
    const d = decisions.find((x) => x.claim === c.claim);
    return d ? [{ candidate: c.id, decision: d.ref }] : [];
  });
  process.stdout.write(JSON.stringify({ matches }));
});
