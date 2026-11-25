import type { ImpactT, LikelihoodT } from "./spec/reviewer-output.js";

export type Stage = "draft" | "pre-merge" | "release";

type Matrix = Record<ImpactT, Record<LikelihoodT, boolean>>;

const row = (certain: boolean, likely: boolean, possible: boolean, remote: boolean) => ({
  certain,
  likely,
  possible,
  remote,
});

export const DEFAULT_MATRIX: Matrix = {
  critical: row(true, true, true, true),
  high: row(true, true, true, false),
  medium: row(true, true, false, false),
  low: row(false, false, false, false),
};

export const DRAFT_MATRIX: Matrix = {
  critical: row(true, true, true, true),
  high: row(false, false, false, false),
  medium: row(false, false, false, false),
  low: row(false, false, false, false),
};

const IMPACT_RANK: Record<ImpactT, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const LIKELIHOOD_RANK: Record<LikelihoodT, number> = { certain: 4, likely: 3, possible: 2, remote: 1 };

export interface PolicyInput {
  impact: ImpactT;
  likelihood: LikelihoodT;
  failure_scenario: string | null;
  assumption_challenge: boolean;
  confidence: number;
}

export interface PolicyOptions {
  stage: Stage;
  max_blocking: number;
  /** Rubric override: high and critical block at any likelihood. */
  high_blocks_always?: boolean;
}

export function riskScore(f: PolicyInput): number {
  return IMPACT_RANK[f.impact] * 10 + LIKELIHOOD_RANK[f.likelihood] + f.confidence / 10;
}

export function severityOf(f: PolicyInput): "blocker" | "major" | "minor" | "info" {
  if (f.impact === "critical") return "blocker";
  if (f.impact === "high") return "major";
  if (f.impact === "medium") return "minor";
  return "info";
}

/** Whether a finding would block on its own under the policy, before the per-round cap. */
export function wouldBlock(f: PolicyInput, opts: PolicyOptions): boolean {
  return blocksByMatrix(f, opts);
}

function blocksByMatrix(f: PolicyInput, opts: PolicyOptions): boolean {
  if (!f.failure_scenario || !f.failure_scenario.trim()) return false;
  // Challenges to the author's assumptions block only when high or critical (then the matrix
  // decides as for any finding); medium and low ones stay advisory.
  if (f.assumption_challenge && f.impact !== "high" && f.impact !== "critical") return false;
  if (opts.high_blocks_always && opts.stage !== "draft" && (f.impact === "high" || f.impact === "critical")) {
    return true;
  }
  const matrix = opts.stage === "draft" ? DRAFT_MATRIX : DEFAULT_MATRIX;
  return matrix[f.impact][f.likelihood];
}

/** Returns a blocking flag per finding, in input order. Caps blocking at max_blocking, highest risk first. */
export function computeBlocking(findings: PolicyInput[], opts: PolicyOptions): boolean[] {
  const candidates = findings
    .map((f, i) => ({ i, score: riskScore(f), blocks: blocksByMatrix(f, opts) }))
    .filter((c) => c.blocks)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.max_blocking);
  const keep = new Set(candidates.map((c) => c.i));
  return findings.map((_, i) => keep.has(i));
}
