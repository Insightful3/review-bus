import { z } from "zod";

// Single source of truth for what every reviewer adapter must return.
// Every object is strict and every field is required (nullable instead of optional),
// so the generated JSON Schema satisfies Codex `--output-schema` strict mode.

export const Likelihood = z.enum(["certain", "likely", "possible", "remote"]);
export const Impact = z.enum(["critical", "high", "medium", "low"]);
export const Verdict = z.enum(["approve", "changes_requested", "comment"]);

export const Location = z.strictObject({
  path: z.string().nullable(),
  line_start: z.int().nullable(),
  line_end: z.int().nullable(),
  section: z.string().nullable(),
  quote: z.string().nullable(),
});

export const ReviewerFinding = z.strictObject({
  claim: z.string(),
  failure_scenario: z.string().nullable(),
  evidence: z.string(),
  location: Location,
  likelihood: Likelihood,
  impact: Impact,
  suggested_fix: z.string().nullable(),
  assumption_challenge: z.boolean(),
  confidence: z.number().min(0).max(1),
  // v0.4: the id of an earlier finding this one repeats (from the prompt's previous round or
  // "Decided earlier"), else null. Defaults to null so older answers and pull reviewers still parse.
  repeats: z.string().nullable().default(null),
});

export const ReviewerOutput = z.strictObject({
  verdict: Verdict,
  summary: z.string(),
  findings: z.array(ReviewerFinding),
});

export type ReviewerOutput = z.infer<typeof ReviewerOutput>;
// The input type: repeats may be missing (older answers, fakes); parsing fills it with null.
export type ReviewerFinding = z.input<typeof ReviewerFinding>;
export type LikelihoodT = z.infer<typeof Likelihood>;
export type ImpactT = z.infer<typeof Impact>;

export function reviewerOutputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ReviewerOutput, { target: "draft-7" }) as Record<string, unknown>;
  delete schema.$schema;
  // Strict structured output (Codex --output-schema) wants every field required and no defaults:
  // repeats stays required in the schema, and its default is only for parsing.
  const strip = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node)) delete (node as Record<string, unknown>).default;
    Object.values(node).forEach(strip);
  };
  strip(schema);
  return schema;
}
