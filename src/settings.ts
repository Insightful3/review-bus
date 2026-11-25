// Model, effort and vendor resolution (SPEC 8a).
import { z } from "zod";
import type { Stage } from "./policy.js";

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export type Effort = z.infer<typeof Effort>;
export const Vendor = z.enum(["anthropic", "openai", "other"]);
export type Vendor = z.infer<typeof Vendor>;
export type AdapterType = "command" | "codex" | "claude";

export type SettingSource = "call" | "rubric" | "stage" | "config" | "cli_default";

/** A reviewer as named in a review_submit call. */
export const ReviewerSpec = z.object({
  name: z.string(),
  model: z.string().nullable().optional(),
  effort: Effort.nullable().optional(),
});
export type ReviewerSpec = z.infer<typeof ReviewerSpec>;

export const DEFAULT_VENDOR: Record<AdapterType, Vendor> = { claude: "anthropic", codex: "openai", command: "other" };

const STAGE_EFFORT: Partial<Record<Stage, Effort>> = { release: "high", draft: "medium" };

export interface Resolved {
  model: string | null;
  model_source: SettingSource;
  effort: Effort | null;
  effort_source: SettingSource;
}

/** Precedence: call, rubric front matter, stage default (effort only), adapter config, CLI default. */
export function resolveModelEffort(
  spec: ReviewerSpec,
  adapter: { model: string | null; effort: Effort | null },
  rubricMeta: Record<string, unknown>,
  stage: Stage,
): Resolved {
  const rubricModels = rubricMeta.models && typeof rubricMeta.models === "object" ? (rubricMeta.models as Record<string, unknown>) : {};
  const rubricModel = typeof rubricModels[spec.name] === "string" ? (rubricModels[spec.name] as string) : null;
  const rubricEffort = Effort.safeParse(rubricMeta.effort).success ? (rubricMeta.effort as Effort) : null;

  const pick = <T>(options: [T | null | undefined, SettingSource][]): [T | null, SettingSource] => {
    for (const [value, source] of options) if (value != null) return [value, source];
    return [null, "cli_default"];
  };
  const [model, model_source] = pick<string>([
    [spec.model, "call"],
    [rubricModel, "rubric"],
    [adapter.model, "config"],
  ]);
  const [effort, effort_source] = pick<Effort>([
    [spec.effort, "call"],
    [rubricEffort, "rubric"],
    [STAGE_EFFORT[stage], "stage"],
    [adapter.effort, "config"],
  ]);
  return { model, model_source, effort, effort_source };
}

/** Throws if the adapter's CLI does not accept this effort. `ultra` exists on Codex only. */
export function checkEffort(type: AdapterType, effort: Effort | null, reviewer: string): void {
  if (effort === "ultra" && type !== "codex") {
    throw new Error(`Reviewer "${reviewer}" (${type}) does not support effort "ultra". Use low, medium, high, xhigh or max.`);
  }
}

/** `name:model:effort`, with "default" where the CLI default was used and not reported. */
export function reviewerLabel(name: string, model: string | null, effort: string | null): string {
  return `${name}:${model ?? "default"}:${effort ?? "default"}`;
}
