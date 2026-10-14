import "server-only";

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { AssessmentSchema, type Assessment } from "../schemas/assessment";
import { draftTitle } from "../services/draft-title";
import { ControlEventSchema, type ControlEvent, type EvidenceArtifact } from "../schemas/event";
import {
  LOCAL_DRAFT_LABEL,
  LOCAL_DRAFT_NOTICE,
  REPLAY_NOTICE,
  type DraftTaskView,
  type JobAssessmentView,
  type JobAuditView,
  type JobFindingView,
  type AnalysisDepth,
  type JobMode,
  type JobStageView,
  type JobTicketView,
  type JobView,
} from "../types/job-view";

/**
 * SQLite job store. The pipeline may only move a job along NEXT.
 * Retry is not one of those moves: it starts a new attempt on the same job id.
 * In-flight states are the ones a crashed worker may have left half-done.
 * queued is still waiting, and awaiting_review belongs to a person.
 */

export const JOB_STATES = [
  "queued",
  "selecting_evidence",
  "analyzing",
  "validating",
  "awaiting_review",
  "draft_created",
  "failed",
] as const;

export type JobState = (typeof JOB_STATES)[number];

const NEXT: Record<JobState, readonly JobState[]> = {
  queued: ["selecting_evidence", "failed"],
  selecting_evidence: ["analyzing", "failed"],
  analyzing: ["validating", "failed"],
  validating: ["awaiting_review", "failed"],
  awaiting_review: ["draft_created", "failed"],
  draft_created: [],
  failed: [],
};

const IN_FLIGHT: readonly JobState[] = ["selecting_evidence", "analyzing", "validating"];

export class TransitionError extends Error {
  constructor(
    readonly from: JobState,
    readonly to: JobState,
  ) {
    super(`cannot move a job from ${from} to ${to}`);
    this.name = "TransitionError";
  }
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!NEXT[from].includes(to)) throw new TransitionError(from, to);
}

export type JobRecord = {
  id: string;
  state: JobState;
  attempt: number;
  errorCategory: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  mode: JobMode;
  analysisDepth: AnalysisDepth;
  model: string | null;
};

export type AppDatabase = Database.Database;

type JobRow = {
  id: string;
  state: string;
  attempt: number;
  error_category: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  mode: string;
  analysis_depth: string;
  model: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'selecting_evidence', 'analyzing', 'validating',
    'awaiting_review', 'draft_created', 'failed'
  )),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  error_category TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'replay')),
  analysis_depth TEXT NOT NULL DEFAULT 'standard' CHECK (analysis_depth IN ('standard', 'deep')),
  model TEXT
);

CREATE TABLE IF NOT EXISTS stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS analysis_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, attempt)
);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL,
  version INTEGER NOT NULL,
  assessment_json TEXT NOT NULL,
  verified_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, version)
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  assessment_version INTEGER NOT NULL,
  label TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, assessment_version)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_state_created ON jobs(state, created_at);
`;

let current: AppDatabase | null = null;
let currentPath: string | null = null;

export function openDatabase(filename: string): AppDatabase {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrateJobs(db);
  return db;
}

/** Older local databases were created before analysis depth and model were stored. */
function migrateJobs(db: AppDatabase): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("analysis_depth")) {
    db.exec(
      `ALTER TABLE jobs ADD COLUMN analysis_depth TEXT NOT NULL DEFAULT 'standard' CHECK (analysis_depth IN ('standard', 'deep'))`,
    );
  }
  if (!columns.has("model")) {
    db.exec(`ALTER TABLE jobs ADD COLUMN model TEXT`);
  }
}

export function getDatabase(): AppDatabase {
  const filename = process.env.CONTROLFLOW_DB ?? path.join(process.cwd(), "data", "controlflow.db");
  if (current && currentPath === filename) return current;
  current?.close();
  current = openDatabase(filename);
  currentPath = filename;
  return current;
}

export function resetDatabaseForTests(): void {
  current?.close();
  current = null;
  currentPath = null;
}

export function createJob(
  db: AppDatabase,
  input: { id: string; event: ControlEvent; mode: JobMode; analysisDepth?: AnalysisDepth },
): JobRecord {
  const now = timestamp();
  const analysisDepth = input.analysisDepth ?? "standard";
  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO jobs (
        id, state, attempt, error_category, error_message, created_at, updated_at, version, mode, analysis_depth
      ) VALUES (?, 'queued', 1, NULL, NULL, ?, ?, 1, ?, ?)`,
    ).run(input.id, now, now, input.mode, analysisDepth);
    db.prepare(
      `INSERT INTO analysis_inputs (job_id, attempt, event_json, evidence_json, created_at) VALUES (?, 1, ?, '[]', ?)`,
    ).run(input.id, JSON.stringify(input.event), now);
    db.prepare(`INSERT INTO stage_events (job_id, attempt, state, started_at) VALUES (?, 1, 'queued', ?)`).run(input.id, now);
    recordAudit(db, input.id, "job_created", `mode=${input.mode} depth=${analysisDepth}`);
    return getJob(db, input.id);
  });
  const job = insert.immediate();
  if (!job) throw new Error("job insert did not return a row");
  return job;
}

export function getJob(db: AppDatabase, id: string): JobRecord | null {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

export function claimNextQueued(db: AppDatabase): JobRecord | null {
  const claim = db.transaction(() => {
    const row = db.prepare(`SELECT id FROM jobs WHERE state = 'queued' ORDER BY created_at, id LIMIT 1`).get() as
      | { id: string }
      | undefined;
    if (!row) return null;
    applyTransition(db, row.id, "selecting_evidence");
    return getJob(db, row.id);
  });
  return claim.immediate();
}

/** Marks selecting/analyzing/validating jobs failed. Queued and awaiting_review stay. */
export function failInterruptedJobs(db: AppDatabase): string[] {
  const rows = db
    .prepare(`SELECT id FROM jobs WHERE state IN (${IN_FLIGHT.map(() => "?").join(", ")})`)
    .all(...IN_FLIGHT) as Array<{ id: string }>;
  const ids: string[] = [];
  for (const row of rows) {
    failJob(db, row.id, "interrupted", "worker restarted while this attempt was in flight");
    ids.push(row.id);
  }
  return ids;
}

export function failJob(db: AppDatabase, id: string, category: string, message: string): JobRecord {
  const run = db.transaction(() => {
    applyTransition(db, id, "failed", { category, message });
    recordAudit(db, id, "failed", `category=${publicMessage(category)}`);
    const job = getJob(db, id);
    if (!job) throw new Error("job disappeared during failure");
    return job;
  });
  return run.immediate();
}

export function retryJob(
  db: AppDatabase,
  id: string,
): { ok: true; job: JobRecord } | { ok: false; status: 404 | 409; error: string } {
  const run = db.transaction(() => {
    const job = getJob(db, id);
    if (!job) return { ok: false as const, status: 404 as const, error: "Job not found." };
    if (job.state !== "failed") {
      return { ok: false as const, status: 409 as const, error: `Job is ${job.state}, not failed.` };
    }
    const now = timestamp();
    closeOpenStage(db, id, now);
    const nextAttempt = job.attempt + 1;
    const eventRow = db
      .prepare(`SELECT event_json FROM analysis_inputs WHERE job_id = ? ORDER BY attempt DESC LIMIT 1`)
      .get(id) as { event_json: string } | undefined;
    if (!eventRow) throw new Error("job has no stored event");
    db.prepare(
      `UPDATE jobs
       SET state = 'queued', attempt = ?, error_category = NULL, error_message = NULL, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(nextAttempt, now, id);
    db.prepare(
      `INSERT INTO analysis_inputs (job_id, attempt, event_json, evidence_json, created_at) VALUES (?, ?, ?, '[]', ?)`,
    ).run(id, nextAttempt, eventRow.event_json, now);
    db.prepare(`INSERT INTO stage_events (job_id, attempt, state, started_at) VALUES (?, ?, 'queued', ?)`).run(
      id,
      nextAttempt,
      now,
    );
    recordAudit(db, id, "retry", `attempt=${nextAttempt}`);
    const updated = getJob(db, id);
    if (!updated) throw new Error("job disappeared during retry");
    return { ok: true as const, job: updated };
  });
  return run.immediate();
}

export function recordJobModel(db: AppDatabase, id: string, model: string): void {
  db.prepare(`UPDATE jobs SET model = ?, updated_at = ? WHERE id = ?`).run(model.slice(0, 120), timestamp(), id);
}

export function readAttemptInput(
  db: AppDatabase,
  jobId: string,
  attempt: number,
): { event: ControlEvent; evidence: EvidenceArtifact[] } {
  const row = db
    .prepare(`SELECT event_json, evidence_json FROM analysis_inputs WHERE job_id = ? AND attempt = ?`)
    .get(jobId, attempt) as { event_json: string; evidence_json: string } | undefined;
  if (!row) throw new Error("analysis input is missing");
  return {
    event: ControlEventSchema.parse(JSON.parse(row.event_json)),
    evidence: JSON.parse(row.evidence_json) as EvidenceArtifact[],
  };
}

export function saveEvidencePacket(db: AppDatabase, jobId: string, attempt: number, evidence: EvidenceArtifact[]): void {
  db.prepare(`UPDATE analysis_inputs SET evidence_json = ? WHERE job_id = ? AND attempt = ?`).run(
    JSON.stringify(evidence),
    jobId,
    attempt,
  );
}

export function saveVerifiedAssessment(
  db: AppDatabase,
  input: { jobId: string; attempt: number; assessment: Assessment; findings: JobFindingView[] },
): number {
  const now = timestamp();
  const versionRow = db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM assessments WHERE job_id = ?`).get(
    input.jobId,
  ) as { version: number };
  db.prepare(
    `INSERT INTO assessments (job_id, attempt, version, assessment_json, verified_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.jobId,
    input.attempt,
    versionRow.version,
    JSON.stringify(input.assessment),
    JSON.stringify(input.findings),
    now,
  );
  return versionRow.version;
}

export function readAssessment(
  db: AppDatabase,
  jobId: string,
  version: number,
): { assessment: Assessment; findings: JobFindingView[] } | null {
  const row = db
    .prepare(`SELECT assessment_json, verified_json FROM assessments WHERE job_id = ? AND version = ?`)
    .get(jobId, version) as { assessment_json: string; verified_json: string } | undefined;
  if (!row) return null;
  return {
    assessment: AssessmentSchema.parse(JSON.parse(row.assessment_json)),
    findings: JSON.parse(row.verified_json) as JobFindingView[],
  };
}

export function readLatestAssessmentVersion(db: AppDatabase, jobId: string): number | null {
  const row = db.prepare(`SELECT MAX(version) AS version FROM assessments WHERE job_id = ?`).get(jobId) as {
    version: number | null;
  };
  return row.version;
}

export function insertTicket(
  db: AppDatabase,
  input: { id: string; jobId: string; assessmentVersion: number; title: string; tasks: DraftTaskView[] },
): JobTicketView {
  const now = timestamp();
  const ticket = toTicket(input.id, input.assessmentVersion, input.title, input.tasks);
  db.prepare(
    `INSERT INTO tickets (id, job_id, assessment_version, label, draft_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.id, input.jobId, input.assessmentVersion, LOCAL_DRAFT_LABEL, JSON.stringify(ticket), now);
  return ticket;
}

export function readTicket(db: AppDatabase, jobId: string, assessmentVersion: number): JobTicketView | null {
  const row = db
    .prepare(`SELECT draft_json FROM tickets WHERE job_id = ? AND assessment_version = ?`)
    .get(jobId, assessmentVersion) as { draft_json: string } | undefined;
  return row ? (JSON.parse(row.draft_json) as JobTicketView) : null;
}

export function countTickets(db: AppDatabase, jobId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM tickets WHERE job_id = ?`).get(jobId) as { count: number };
  return row.count;
}

export function recordAudit(db: AppDatabase, jobId: string, action: string, detail: string): void {
  db.prepare(`INSERT INTO audit_events (job_id, action, detail, created_at) VALUES (?, ?, ?, ?)`).run(
    jobId,
    action,
    publicMessage(detail),
    timestamp(),
  );
}

export function readJobView(db: AppDatabase, id: string): JobView | null {
  const job = getJob(db, id);
  if (!job) return null;
  const stages = (
    db.prepare(
      `SELECT attempt, state, started_at, finished_at, duration_ms FROM stage_events WHERE job_id = ? ORDER BY id`,
    ).all(id) as Array<{
      attempt: number;
      state: string;
      started_at: string;
      finished_at: string | null;
      duration_ms: number | null;
    }>
  ).map(
    (row): JobStageView => ({
      attempt: row.attempt,
      state: row.state,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
    }),
  );
  const assessmentRow = db
    .prepare(
      `SELECT version, assessment_json, verified_json FROM assessments WHERE job_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(id) as { version: number; assessment_json: string; verified_json: string } | undefined;
  let assessment: JobAssessmentView | null = null;
  if (assessmentRow) {
    const parsed = AssessmentSchema.parse(JSON.parse(assessmentRow.assessment_json));
    assessment = {
      version: assessmentRow.version,
      summary: parsed.summary,
      reviewRequired: true,
      unresolvedQuestions: parsed.unresolvedQuestions,
      findings: JSON.parse(assessmentRow.verified_json) as JobFindingView[],
    };
  }
  const ticketRow = assessment
    ? (db.prepare(`SELECT draft_json FROM tickets WHERE job_id = ? AND assessment_version = ?`).get(id, assessment.version) as
        | { draft_json: string }
        | undefined)
    : undefined;
  const ticket = ticketRow ? (JSON.parse(ticketRow.draft_json) as JobTicketView) : null;
  const taskCount = assessment?.findings.reduce((count, finding) => count + finding.proposedTasks.length, 0) ?? 0;
  const storedEvent = assessment ? readAttemptInput(db, id, job.attempt).event : null;
  const audit = (
    db.prepare(`SELECT id, action, detail, created_at FROM audit_events WHERE job_id = ? ORDER BY id`).all(id) as Array<{
      id: number;
      action: string;
      detail: string;
      created_at: string;
    }>
  ).map(
    (row): JobAuditView => ({
      id: row.id,
      action: row.action,
      detail: row.detail,
      createdAt: row.created_at,
    }),
  );
  return {
    id: job.id,
    state: job.state,
    attempt: job.attempt,
    version: job.version,
    mode: job.mode,
    analysisDepth: job.analysisDepth,
    model: job.model,
    replayNotice: job.mode === "replay" ? REPLAY_NOTICE : null,
    errorCategory: job.errorCategory,
    errorMessage: job.errorMessage,
    stages,
    assessment,
    draftTitle: ticket?.title ?? (storedEvent ? draftTitle(storedEvent.policyVersion, taskCount) : null),
    ticket,
    audit,
  };
}

export function transitionJob(db: AppDatabase, id: string, to: JobState, error?: { category: string; message: string }): JobRecord {
  if (db.inTransaction) return applyTransition(db, id, to, error);
  return db.transaction(() => applyTransition(db, id, to, error)).immediate();
}

function applyTransition(db: AppDatabase, id: string, to: JobState, error?: { category: string; message: string }): JobRecord {
  const job = getJob(db, id);
  if (!job) throw new Error("job not found");
  assertTransition(job.state, to);
  const now = timestamp();
  closeOpenStage(db, id, now);
  if (to === "failed") {
    db.prepare(
      `UPDATE jobs
       SET state = 'failed', error_category = ?, error_message = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(publicMessage(error?.category ?? "failed"), publicMessage(error?.message ?? "failed"), now, id);
  } else {
    db.prepare(`UPDATE jobs SET state = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(to, now, id);
  }
  const finished = to === "failed" || to === "draft_created";
  db.prepare(
    `INSERT INTO stage_events (job_id, attempt, state, started_at, finished_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, job.attempt, to, now, finished ? now : null, finished ? 0 : null);
  const updated = getJob(db, id);
  if (!updated) throw new Error("job disappeared during transition");
  return updated;
}

function closeOpenStage(db: AppDatabase, jobId: string, now: string): void {
  const open = db
    .prepare(`SELECT id, state, started_at FROM stage_events WHERE job_id = ? AND finished_at IS NULL ORDER BY id DESC LIMIT 1`)
    .get(jobId) as { id: number; state: string; started_at: string } | undefined;
  if (!open) return;
  const durationMs = Math.max(0, Date.parse(now) - Date.parse(open.started_at));
  db.prepare(`UPDATE stage_events SET finished_at = ?, duration_ms = ? WHERE id = ?`).run(now, durationMs, open.id);
  console.log(`job=${jobId} stage=${open.state} duration_ms=${durationMs}`);
}

function mapJob(row: JobRow): JobRecord {
  if (!isJobState(row.state)) throw new Error("job row has an unknown state");
  if (row.mode !== "live" && row.mode !== "replay") throw new Error("job row has an unknown mode");
  if (row.analysis_depth !== "standard" && row.analysis_depth !== "deep") {
    throw new Error("job row has an unknown analysis depth");
  }
  return {
    id: row.id,
    state: row.state,
    attempt: row.attempt,
    errorCategory: row.error_category,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    mode: row.mode,
    analysisDepth: row.analysis_depth,
    model: row.model,
  };
}

function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

function toTicket(id: string, assessmentVersion: number, title: string, tasks: DraftTaskView[]): JobTicketView {
  return {
    id,
    title,
    label: LOCAL_DRAFT_LABEL,
    notice: LOCAL_DRAFT_NOTICE,
    assessmentVersion,
    tasks,
  };
}

function publicMessage(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}

function timestamp(): string {
  return new Date().toISOString();
}
