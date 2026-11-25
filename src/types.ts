import type { ReviewerFinding } from "./spec/reviewer-output.js";
import type { Stage } from "./policy.js";
import type { Effort, ReviewerSpec, SettingSource, Vendor } from "./settings.js";
import type { GitInfo, GitSpec } from "./git.js";
import type { PageInfo } from "./pages.js";

/** What is reviewed: a document path or a git change. Pages can come with either, or alone. */
export interface ArtifactRef {
  path?: string;
  git?: GitSpec;
}

export type ReviewState =
  | "submitted"
  | "in_review"
  | "changes_requested"
  | "awaiting_signoff"
  | "approved"
  | "escalated"
  | "failed"
  | "canceled"
  | "needs_input";

export interface ReviewRequest {
  artifact: ArtifactRef | null;
  /** URLs to render and screenshot (webpage review). */
  pages: string[];
  /** Documents given for comparison, not under review (for example the accepted proposal for a contract). */
  related?: string[];
  rubric: string;
  intent: string;
  assumptions: string[];
  criteria: string[];
  reviewers: ReviewerSpec[];
  stage: Stage;
}

export interface AuthorInfo {
  client: string | null; // MCP clientInfo.name
  vendor: Vendor | null;
  vendor_source: "declared" | "client" | "unknown" | "person";
}

export interface Snapshot {
  kind: "markdown" | "text" | "docx" | "pdf" | "git" | "pages";
  /** Identifies this exact version (document bytes, or base + patch, plus page renders). */
  sha256: string;
  /** Text the prompt is built from: the document as Markdown, or the change summary + diff. Relative to review dir. */
  markdown_file: string | null;
  warnings: string[];
  // Documents
  source_path?: string;
  file?: string; // copy of the original, relative to review dir
  converter?: string;
  // Git
  git?: GitInfo;
  // Pages
  pages?: PageInfo[];
  // Related documents (for comparison)
  related?: { source_path: string; markdown_file: string; sha256: string }[];
}

export interface ReviewerRun {
  name: string; // config key, e.g. "codex" or "fake"
  adapter: string; // adapter type
  vendor: Vendor;
  /** What ran: the CLI's reported value if it reports one, else the requested value. */
  model: string | null;
  model_reported: boolean;
  model_source: SettingSource; // where the requested model came from
  model_requested: string | null;
  effort: string | null;
  effort_reported: boolean;
  effort_source: SettingSource;
  effort_requested: Effort | null;
  label: string; // name:model:effort
  status: "pending" | "running" | "done" | "failed";
  verdict: string | null;
  summary: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface FindingResponse {
  status: "accepted" | "rejected" | "deferred";
  note: string;
  at: string;
}

export interface Finding extends ReviewerFinding {
  finding_id: string;
  reviewer: string; // name:model:effort
  round: number;
  blocking: boolean;
  severity: "blocker" | "major" | "minor" | "info";
  /** How many reviewers raised it (SPEC 6). */
  agreement: number;
  /** The other reviewers' versions of a merged finding. */
  also_raised_by?: { reviewer: string; claim: string; impact: string; likelihood: string }[];
  response: FindingResponse | null;
}

export interface Round {
  n: number;
  /** The server process running this round; other processes leave it alone while it is alive. */
  runner?: { pid: number; host: string; started_at: string };
  started_at: string;
  finished_at: string | null;
  snapshot: Snapshot;
  reviewers: ReviewerRun[];
  findings: Finding[];
  /** How duplicates across reviewers were merged. */
  merge?: { method: "none" | "rules" | "model"; by: string | null; error: string | null };
}

export interface HistoryEntry {
  at: string;
  event: string;
  detail?: string;
}

export interface Review {
  id: string;
  kind: "document";
  created_at: string;
  updated_at: string;
  state: ReviewState;
  request: ReviewRequest;
  author: AuthorInfo;
  /** Shown in the result and report, e.g. same-vendor reviewer, unknown author vendor. */
  notes: string[];
  rubric_meta: Record<string, unknown>;
  rounds: Round[];
  signoff?: { by: string; note: string; at: string; from_state: ReviewState };
  history: HistoryEntry[];
}
