import "server-only";

import crypto from "node:crypto";

import {
  getJob,
  insertTicket,
  readAssessment,
  readTicket,
  recordAudit,
  transitionJob,
  type AppDatabase,
} from "../storage/db";
import { LOCAL_DRAFT_LABEL, type DraftTaskView, type JobFindingView, type JobTicketView } from "../types/job-view";

export type ApproveInput = {
  approve: boolean;
  assessmentVersion: number;
};

export type ApproveResult =
  | { ok: true; ticket: JobTicketView }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Approval is one transaction. A second request for the same assessment
 * version returns the ticket already stored. The UNIQUE(job_id, assessment_version)
 * constraint is the backstop if two requests pass the read at the same time.
 */
export function approveAssessment(db: AppDatabase, jobId: string, input: ApproveInput): ApproveResult {
  const run = db.transaction(() => {
    if (input.approve !== true) {
      return { ok: false as const, status: 400 as const, error: "Approval requires approve: true." };
    }
    const job = getJob(db, jobId);
    if (!job) return { ok: false as const, status: 404 as const, error: "Job not found." };
    const existing = readTicket(db, jobId, input.assessmentVersion);
    if (existing) return { ok: true as const, ticket: existing };
    if (job.state !== "awaiting_review") {
      return { ok: false as const, status: 409 as const, error: `Job is ${job.state}, not awaiting_review.` };
    }
    const stored = readAssessment(db, jobId, input.assessmentVersion);
    if (!stored) {
      return { ok: false as const, status: 409 as const, error: "Assessment version was not found." };
    }
    const ticket = insertTicket(db, {
      id: crypto.randomUUID(),
      jobId,
      assessmentVersion: input.assessmentVersion,
      tasks: draftTasks(stored.findings),
    });
    transitionJob(db, jobId, "draft_created");
    recordAudit(db, jobId, "draft_created", `${LOCAL_DRAFT_LABEL} for assessment version ${input.assessmentVersion}`);
    return { ok: true as const, ticket };
  });

  try {
    return run.immediate();
  } catch (error) {
    if (!isConstraint(error)) throw error;
    const existing = readTicket(db, jobId, input.assessmentVersion);
    if (existing) return { ok: true, ticket: existing };
    throw error;
  }
}

function isConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && String((error as { code: unknown }).code).includes("SQLITE_CONSTRAINT");
}

export function draftTasks(findings: readonly JobFindingView[]): DraftTaskView[] {
  return findings.flatMap((finding) =>
    finding.proposedTasks.map((task) => ({
      serviceId: finding.serviceId,
      requirementId: finding.requirementId,
      findingId: finding.id,
      title: task.title,
      ownerTeam: task.ownerTeam,
      acceptanceCriteria: task.acceptanceCriteria,
      requiredReviewers: task.requiredReviewers,
    })),
  );
}
