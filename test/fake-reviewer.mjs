#!/usr/bin/env node
// Fake reviewer for tests: reads the review prompt on stdin, prints reviewer output JSON on stdout.
// FAKE_REVIEWER_MODE: issues (default) | clean | bad-json | fail
// A finding goes away once its quoted text is no longer in the document (the author fixed it).
function withFixes(doc, out) {
  const findings = out.findings.filter((f) => doc.includes(f.location.quote));
  const serious = findings.some((f) => f.impact === "critical" || f.impact === "high");
  return { ...out, findings, verdict: serious ? "changes_requested" : findings.length ? "comment" : "approve" };
}

// --ignore-term: a reviewer that ignores SIGTERM (it must still be stopped) and records its pid.
if (process.argv.includes("--ignore-term")) {
  process.on("SIGTERM", () => {});
  const fs = await import("node:fs");
  fs.writeFileSync(`${process.env.REVIEW_BUS_ROUND_DIR}/reviewer.pid`, String(process.pid));
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  // --sleep=ms delays every round; --sleep-r2=ms delays only round 2 (round from the cwd, e.g. .../r2).
  const round = (process.env.REVIEW_BUS_ROUND_DIR ?? "").match(/r(\d+)$/)?.[1];
  const sleep = process.argv.find((a) => a.startsWith("--sleep=")) ?? process.argv.find((a) => a.startsWith(`--sleep-r${round}=`));
  if (sleep) await new Promise((r) => setTimeout(r, Number(sleep.split("=")[1])));
  const mode = process.env.FAKE_REVIEWER_MODE ?? "issues";
  if (!input.includes("<document>") && !input.includes("<diff>") && !input.includes("## Rendered pages")) {
    console.error("fake reviewer: prompt has no document, diff or pages");
    process.exit(2);
  }
  if (mode === "fail") {
    console.error("fake reviewer: asked to fail");
    process.exit(1);
  }
  if (mode === "bad-json") {
    process.stdout.write("not json");
    return;
  }
  if (mode === "clean") {
    process.stdout.write(JSON.stringify({ verdict: "approve", summary: "Looks fine.", findings: [] }));
    return;
  }
  // Only look at the work itself, not at the previous-round section of the prompt.
  const between = (open, close) => (input.includes(open) ? input.slice(input.lastIndexOf(open), input.lastIndexOf(close)) : "");
  const pages = input.includes("## Rendered pages") ? input.slice(input.lastIndexOf("## Rendered pages")) : "";
  const doc = between("<document>", "</document>") + between("<diff>", "</diff>") + pages;
  const images = (process.env.REVIEW_BUS_IMAGES ?? "").split("\n").filter(Boolean);
  const loc = (section, quote) => ({ path: "artifact.md", line_start: null, line_end: null, section, quote });
  process.stdout.write(
    JSON.stringify(
      withFixes(doc, {
      verdict: "changes_requested",
      summary: `Price is inconsistent and one promise cannot be kept. [model=${process.env.REVIEW_BUS_MODEL} effort=${process.env.REVIEW_BUS_EFFORT} argv=${process.argv.slice(2).join(",")} images=${images.length}]`,
      findings: [
        {
          claim: "The total price in the summary (EUR 24,000) does not match the price table (EUR 22,500).",
          failure_scenario: "The client signs expecting EUR 22,500 and disputes the first invoice, which is based on EUR 24,000.",
          evidence: "Summary says EUR 24,000; table total is EUR 22,500 and the line items add up to 22,500.",
          location: loc("Summary", "Total price: EUR 24,000 excluding VAT."),
          likelihood: "certain",
          impact: "critical",
          suggested_fix: "Use one total everywhere and check the line items add up.",
          assumption_challenge: false,
          confidence: 0.95,
        },
        {
          claim: "The 70% resolution rate is promised as a result, which Northwind does not control.",
          failure_scenario: "The rate is 40% in month one and the client withholds the go-live payment.",
          evidence: "Results section states the rate as a commitment, not a target.",
          location: loc("Results", "The assistant will resolve 70% of incoming support questions"),
          likelihood: "likely",
          impact: "high",
          suggested_fix: "State it as a target with the conditions it depends on.",
          assumption_challenge: false,
          confidence: 0.8,
        },
        {
          claim: "The go-live date does not say it depends on Bluefin delivering the help center export and API access.",
          failure_scenario: "Bluefin delivers access late and still expects go-live on 15 March.",
          evidence: "The Bluefin task in the timeline has no date.",
          location: loc("Timeline", "Bluefin provides help center export and ticketing API access"),
          likelihood: "possible",
          impact: "medium",
          suggested_fix: "Give the client task a date and say go-live moves if it slips.",
          assumption_challenge: false,
          confidence: 0.7,
        },
        {
          claim: "The ask could also name who to reply to.",
          failure_scenario: null,
          evidence: "Next step says only to reply to this email.",
          location: loc("Next step", "Reply to this email to accept."),
          likelihood: "remote",
          impact: "low",
          suggested_fix: null,
          assumption_challenge: false,
          confidence: 0.4,
        },
        {
          claim: "Placeholder text TODO is visible to visitors.",
          failure_scenario: "A visitor sees TODO on the page and doubts the site is maintained.",
          evidence: "The change adds TODO to the page.",
          location: loc("index.html", "TODO"),
          likelihood: "likely",
          impact: "high",
          suggested_fix: "Replace the placeholder with the real text.",
          assumption_challenge: false,
          confidence: 0.9,
        },
        {
          claim: "An image has no alt text.",
          failure_scenario: "A screen reader user cannot tell what the image shows.",
          evidence: "The page facts list an image without alt text.",
          location: loc("desktop, hero", "Images without alt text: 1"),
          likelihood: "possible",
          impact: "medium",
          suggested_fix: "Add alt text.",
          assumption_challenge: false,
          confidence: 0.7,
        },
        ...(process.argv.includes("--challenge")
          ? [
              {
                claim: "The governing law is assumed but not stated.",
                failure_scenario: "A dispute arises and the parties disagree on which law applies.",
                evidence: "The author assumes Slovenian law; the document does not say.",
                location: loc("Price and payment", "Invoices are due in 15 days."),
                likelihood: "possible",
                impact: "medium",
                suggested_fix: "State the governing law.",
                assumption_challenge: true,
                confidence: 0.8,
              },
            ]
          : []),
      ],
    })),
  );
});
