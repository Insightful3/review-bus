import type { ReviewerFinding } from "./spec/reviewer-output.js";
import type { Stage } from "./policy.js";
import type { Effort, ReviewerSpec, SettingSource, Vendor } from "./settings.js";
import type { GitInfo, GitSpec } from "./git.js";
import type { PageInfo } from "./pages.js";

/** What is reviewed: a document path or a git change. Pages can come with either, or alone. */
export interface ArtifactRef {
  path?: string;
  git?: GitSpec;
  /** The document was sent as text (review_submit with {content, name}); path is its copy in the review folder. */
  inline?: boolean;
}

/** A document sent as text instead of a path, for clients that do not share this machine's disk. */
export interface InlineDoc {
  name: string;
  content: string;
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
  /** v0.4: the earlier review this one follows (review_submit follows). */
  follows?: string | null;
  /** Decisions copied from the followed review at submit, newest first, within the history budget. */
  inherited?: Decision[];
  /** How many of the followed review's decisions did not fit the budget. */
  inherited_left_out?: number;
  /** Every rubric the followed chain's decisions came from, also of those left out: their approvals still apply. */
  inherited_rubrics?: { rubric: string; confidential: boolean }[];
}

/**
 * A decision on an earlier finding, as reviewers see it: rejected or deferred by the author, accepted
 * (fixed then; check it did not come back), or settled by a person's sign-off while unanswered.
 */
export interface Decision {
  /** "r1.f3" within this review; "rv_.../r1.f3" when carried from an earlier review (always its original). */
  ref: string;
  claim: string;
  impact: string;
  likelihood: string;
  place: string | null;
  status: "rejected" | "deferred" | "accepted" | "signed_off";
  reason: string;
  /** The rubric of the review the decision was made in: its reviewer approvals still apply to it. */
  rubric?: string;
  /** That review's rubric was confidential when it was submitted (a later change to the rubric does not lift it). */
  confidential?: boolean;
  /** The earlier decision this one was marked as repeating: a newer acceptance supersedes it. */
  supersedes?: string;
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
  /** waiting: a pull reviewer nobody has claimed yet; running: started, or claimed by a pull reviewer. */
  status: "pending" | "waiting" | "running" | "done" | "failed";
  /** Pull reviewers: when the answer is due, and who claimed the work (the token authorizes the answer). */
  deadline?: string;
  /** Only a SHA-256 of the claim token is stored; the claimant holds the token. */
  claim?: { id: string; by: string; client: string | null; at: string; token_sha256: string } | null;
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
  /** The author answered "repeat": the earlier decision this finding repeats (stored as rejected, its reason copied). */
  repeat_of?: string;
  /** Another answer that names the earlier decision on the same point (repeat_of with accepted, rejected or deferred): this answer supersedes it. */
  supersedes?: string;
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
  /** Would block on its own, but the round already has max_blocking blocking findings. */
  over_limit?: boolean;
  /** v0.4: a repeat of an earlier decision (rejected, deferred or signed off), marked by the reviewers or found by the model check. */
  repeat?: { of: string; by: "reviewer" | "model"; status: Decision["status"]; reason: string } | null;
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
  /** The blocking policy the round was started with: whoever finishes the round applies this one. */
  policy?: { max_blocking: number; max_rounds: number; later_rounds?: "stricter" | "same" };
  /** The process merging the findings and deciding the state, once every reviewer has finished. */
  finalizing?: { pid: number; host: string; started_at: string } | null;
  /** How duplicates across reviewers were merged. */
  merge?: { method: "none" | "rules" | "model"; by: string | null; error: string | null };
  /** v0.4: the model check for repeats the reviewers did not mark. */
  repeat_check?: { by: string | null; found: number; error: string | null };
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
  /** Set while the first snapshot is taken in the background (pages can take a minute): the process taking it. */
  preparing?: { pid: number; host: string; started_at: string } | null;
  rounds: Round[];
  signoff?: { by: string; note: string; at: string; from_state: ReviewState };
  history: HistoryEntry[];
}
