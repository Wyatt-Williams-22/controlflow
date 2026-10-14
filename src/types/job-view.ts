/** API shape returned by GET /api/jobs/[id]. No server imports, so the page can use it. */

export const REPLAY_NOTICE = "REPLAY: not a live model call";
export const LOCAL_DRAFT_LABEL = "LOCAL DRAFT";
export const LOCAL_DRAFT_NOTICE = "This is a local draft, not a compliance certification.";

export type JobMode = "live" | "replay";

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
  acceptanceCriteria: string;
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
  replayNotice: typeof REPLAY_NOTICE | null;
  errorCategory: string | null;
  errorMessage: string | null;
  stages: JobStageView[];
  assessment: JobAssessmentView | null;
  ticket: JobTicketView | null;
  audit: JobAuditView[];
};
