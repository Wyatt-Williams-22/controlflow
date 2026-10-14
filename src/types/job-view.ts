/** API shape returned by GET /api/jobs/[id]. No server imports, so the page can use it. */

export const REPLAY_NOTICE = "REPLAY: not a live model call";
export const LOCAL_DRAFT_LABEL = "LOCAL DRAFT";
export const LOCAL_DRAFT_NOTICE = "This is a local draft, not a compliance certification.";

/**
 * Standard is the non-reasoning model. On the retention packet, grok-4.7 took
 * about 167 seconds and about 14k reasoning tokens, then failed verification.
 * grok-4.20-0309-non-reasoning finished in 8.5 seconds and passed on the first try.
 */
export const DEFAULT_STANDARD_MODEL = "grok-4.20-0309-non-reasoning";
export const DEFAULT_DEEP_MODEL = "grok-4.7";

export type JobMode = "live" | "replay";
export type AnalysisDepth = "standard" | "deep";

export type JobStageView = {
  attempt: number;
  state: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
};

export type JobEvidenceView = {
  evidenceId: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  rationale: string;
  excerpt: string;
};

export type JobTaskView = {
  title: string;
  ownerTeam: string;
  acceptanceCriteria: string[];
  requiredReviewers: string[];
};

export type JobFindingView = {
  id: string;
  serviceId: string;
  requirementId: string;
  status: "potential_gap" | "supported_control" | "insufficient_evidence";
  impactPriority: "low" | "medium" | "high";
  rationale: string;
  unknowns: string[];
  proposedTasks: JobTaskView[];
  evidence: JobEvidenceView[];
};

export type JobAssessmentView = {
  version: number;
  summary: string;
  reviewRequired: true;
  unresolvedQuestions: string[];
  findings: JobFindingView[];
};

export type DraftTaskView = JobTaskView & {
  serviceId: string;
  requirementId: string;
  findingId: string;
};

export type JobTicketView = {
  id: string;
  title: string;
  label: typeof LOCAL_DRAFT_LABEL;
  notice: typeof LOCAL_DRAFT_NOTICE;
  assessmentVersion: number;
  tasks: DraftTaskView[];
};

export type JobAuditView = {
  id: number;
  action: string;
  detail: string;
  createdAt: string;
};

export type JobView = {
  id: string;
  state: string;
  attempt: number;
  version: number;
  mode: JobMode;
  analysisDepth: AnalysisDepth;
  /** Model that was selected for this job. Null until a live attempt calls the model, and null for replay. */
  model: string | null;
  replayNotice: typeof REPLAY_NOTICE | null;
  errorCategory: string | null;
  errorMessage: string | null;
  stages: JobStageView[];
  assessment: JobAssessmentView | null;
  /** Server-derived draft heading. Null until an assessment exists. */
  draftTitle: string | null;
  ticket: JobTicketView | null;
  audit: JobAuditView[];
};
