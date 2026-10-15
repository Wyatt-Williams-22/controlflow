"use client";

import { useEffect, useState, type FormEvent } from "react";

import retentionEvent from "../fixtures/control-events/retention-change.json";
import {
  DEFAULT_DEEP_MODEL,
  DEFAULT_STANDARD_MODEL,
  LOCAL_DRAFT_LABEL,
  LOCAL_DRAFT_NOTICE,
  REPLAY_NOTICE,
  type AnalysisDepth,
  type JobFindingView,
  type JobView,
} from "../src/types/job-view";

const SEEDED = [
  {
    id: retentionEvent.id,
    label: retentionEvent.title,
    description: retentionEvent.description,
    requirements: retentionEvent.requirements,
    event: retentionEvent,
  },
];

export default function HomePage() {
  const [seedId, setSeedId] = useState(SEEDED[0].id);
  const [description, setDescription] = useState(SEEDED[0].description);
  const [requirementsText, setRequirementsText] = useState(JSON.stringify(SEEDED[0].requirements, null, 2));
  const [mode, setMode] = useState<"live" | "replay">("live");
  const [analysisDepth, setAnalysisDepth] = useState<AnalysisDepth>("standard");
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const seed = SEEDED.find((item) => item.id === seedId) ?? SEEDED[0];
  const terminal = job?.state === "awaiting_review" || job?.state === "draft_created" || job?.state === "failed";

  useEffect(() => {
    if (!jobId || terminal) return;
    let cancelled = false;
    async function refresh() {
      const response = await fetch(`/api/jobs/${jobId}`);
      if (!response.ok || cancelled) return;
      const body = (await response.json()) as JobView;
      if (!cancelled) setJob(body);
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, terminal]);

  function selectSeed(nextId: string) {
    const next = SEEDED.find((item) => item.id === nextId) ?? SEEDED[0];
    setSeedId(next.id);
    setDescription(next.description);
    setRequirementsText(JSON.stringify(next.requirements, null, 2));
  }

  async function refreshJob(id: string) {
    const response = await fetch(`/api/jobs/${id}`);
    if (response.ok) setJob((await response.json()) as JobView);
  }

  async function onAnalyze(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    let requirements: unknown;
    try {
      requirements = JSON.parse(requirementsText);
    } catch {
      setFormError("Requirements must be JSON.");
      return;
    }
    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode,
        analysisDepth: mode === "replay" ? "standard" : analysisDepth,
        event: { ...seed.event, description, requirements },
      }),
    });
    const body = (await response.json()) as { id?: string; error?: string };
    if (!response.ok || !body.id) {
      setFormError(body.error ?? "The event was rejected.");
      return;
    }
    setJob(null);
    setJobId(body.id);
  }

  async function onRetry() {
    if (!jobId) return;
    const response = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      setFormError(body.error ?? "Retry was rejected.");
      return;
    }
    setFormError(null);
    await refreshJob(jobId);
  }

  async function onApprove() {
    if (!jobId || !job?.assessment) return;
    const response = await fetch(`/api/jobs/${jobId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve: true, assessmentVersion: job.assessment.version }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setFormError(body.error ?? "Approval was rejected.");
      return;
    }
    setFormError(null);
    await refreshJob(jobId);
  }

  return (
    <main>
      <header className="site-header">
        <p className="banner">SYNTHETIC DATA</p>
        <h1>ControlFlow</h1>
        <p className="subtitle">Compliance change impact intelligence · Grok API</p>
        <hr className="rule" />
        <p className="lede">Start the worker in a second terminal (`npm run worker`). This page polls the job.</p>
      </header>

      <form className="card" onSubmit={(event) => void onAnalyze(event)}>
        <label>
          Seeded event
          <select value={seedId} onChange={(event) => selectSeed(event.target.value)}>
            {SEEDED.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Description
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} />
        </label>
        <label>
          Requirements JSON
          <textarea value={requirementsText} onChange={(event) => setRequirementsText(event.target.value)} rows={12} />
        </label>
        <fieldset>
          <legend>Mode</legend>
          <label>
            <input type="radio" name="mode" value="live" checked={mode === "live"} onChange={() => setMode("live")} />
            Live
          </label>
          <label>
            <input type="radio" name="mode" value="replay" checked={mode === "replay"} onChange={() => setMode("replay")} />
            Replay
          </label>
        </fieldset>
        <fieldset>
          <legend>Analysis depth</legend>
          <label>
            <input
              type="radio"
              name="depth"
              value="standard"
              checked={analysisDepth === "standard"}
              disabled={mode === "replay"}
              onChange={() => setAnalysisDepth("standard")}
            />
            Standard
          </label>
          <label>
            <input
              type="radio"
              name="depth"
              value="deep"
              checked={analysisDepth === "deep"}
              disabled={mode === "replay"}
              onChange={() => setAnalysisDepth("deep")}
            />
            Deep
          </label>
        </fieldset>
        <p className="hint">
          Standard uses {DEFAULT_STANDARD_MODEL}. Deep uses {DEFAULT_DEEP_MODEL} and can take several minutes. Replay
          loads the saved retention assessment and does not call a model. Live and standard are the defaults.
        </p>
        <button type="submit">Analyze</button>
      </form>
      {formError ? <p className="form-error">{formError}</p> : null}

      {job ? (
        <>
          <section className="panel">
            <h2>Status</h2>
            {job.replayNotice ? <p className="replay">{job.replayNotice}</p> : null}
            <p className="status-line">
              <span className={job.state === "failed" ? "pill pill-failed" : "pill"}>{job.state}</span>
              <span className="mono">
                {job.state} · attempt {job.attempt} · {job.mode}
                {job.mode === "live" ? ` · ${job.analysisDepth}` : ""}
                {job.model ? ` · ${job.model}` : ""}
              </span>
            </p>
            {job.errorCategory ? (
              <p className="error-line">
                {job.errorCategory}: {job.errorMessage}
              </p>
            ) : null}
            <ol className="timeline">
              {statusTimeline(job).map((item) => (
                <li key={item.key}>
                  {item.state ? (
                    <>
                      <span>attempt {item.attempt}:</span>
                      <span className={item.state === "failed" ? "pill pill-failed" : "pill"}>{item.state}</span>
                      {item.durationMs !== null ? <span>({item.durationMs} ms)</span> : null}
                    </>
                  ) : (
                    item.text
                  )}
                </li>
              ))}
            </ol>
            {job.state === "failed" ? (
              <button type="button" onClick={() => void onRetry()}>
                Retry
              </button>
            ) : null}
          </section>

          {job.assessment ? (
            <section className="panel">
              <h2>Assessment</h2>
              <p>{job.assessment.summary}</p>
              {groupFindings(job.assessment.findings).map((group) => (
                <section key={group.serviceId}>
                  <h3 className="service-title">{group.serviceId}</h3>
                  {group.findings.map((finding) => (
                    <article key={finding.id} className="finding">
                      <p className="finding-line">
                        <span className="req-id">{finding.requirementId}</span>
                        <span className="sep">:</span>
                        <span className={`pill pill-${finding.status}`}>{finding.status}</span>
                        <span className="sep">,</span>
                        <span className={`pill pill-${finding.impactPriority}`}>{finding.impactPriority}</span>
                      </p>
                      <p>{finding.rationale}</p>
                      {finding.evidence.map((citation) => (
                        <details key={`${citation.evidenceId}-${citation.startLine}`}>
                          <summary>
                            <span className="ev-id">{citation.evidenceId}</span>
                            <span>
                              {citation.relativePath} lines {citation.startLine}-{citation.endLine}
                            </span>
                          </summary>
                          <pre>{citation.excerpt}</pre>
                        </details>
                      ))}
                      {finding.unknowns.length > 0 ? (
                        <div className="unknowns">
                          <p>Unknowns</p>
                          <ul>
                            {finding.unknowns.map((unknown) => (
                              <li key={unknown}>{unknown}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {finding.proposedTasks.flatMap((task) => task.requiredReviewers).length > 0 ? (
                        <p className="reviewers">
                          Reviewers: {finding.proposedTasks.flatMap((task) => task.requiredReviewers).join(", ")}
                        </p>
                      ) : null}
                    </article>
                  ))}
                </section>
              ))}
              {job.assessment.unresolvedQuestions.length > 0 ? (
                <div>
                  <h3>Unresolved questions</h3>
                  <ul className="questions">
                    {job.assessment.unresolvedQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}

          {job.assessment ? (
            <section className="panel">
              <h2>{job.ticket?.title ?? job.draftTitle ?? LOCAL_DRAFT_LABEL}</h2>
              <p className="notice">{LOCAL_DRAFT_NOTICE}</p>
              <ul className="task-list">
                {(job.ticket?.tasks ?? tasksFrom(job.assessment.findings)).map((task) => (
                  <li key={`${task.findingId}-${task.title}`} className="task">
                    <span className="mono">{task.serviceId}</span>: {task.title} ({task.ownerTeam}). Reviewers:{" "}
                    {task.requiredReviewers.join(", ") || "none"}.
                    <ul>
                      {task.acceptanceCriteria.map((criterion) => (
                        <li key={criterion}>{criterion}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              {job.state === "awaiting_review" ? (
                <button type="button" onClick={() => void onApprove()}>
                  Approve
                </button>
              ) : null}
              {job.ticket ? <p className="draft-id">Draft {job.ticket.id}</p> : null}
            </section>
          ) : null}

          <section className="panel">
            <h2>Audit</h2>
            <ol className="audit">
              {job.audit.map((entry) => (
                <li key={entry.id}>
                  <span className="muted">{entry.createdAt}</span> {entry.action}: {entry.detail}
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : null}
    </main>
  );
}

function statusTimeline(job: JobView): Array<{
  key: string;
  text: string;
  state: string | null;
  attempt: number | null;
  durationMs: number | null;
}> {
  const stages = job.stages.map((stage, index) => ({
    key: `stage-${stage.attempt}-${stage.state}-${index}`,
    at: stage.startedAt,
    text: `attempt ${stage.attempt}: ${stage.state}${stage.durationMs !== null ? ` (${stage.durationMs} ms)` : ""}`,
    state: stage.state,
    attempt: stage.attempt,
    durationMs: stage.durationMs,
  }));
  const repairs = job.audit
    .filter((entry) => entry.action === "repair_requested")
    .map((entry) => ({
      key: `repair-${entry.id}`,
      at: entry.createdAt,
      text: `repair_requested: ${entry.detail}`,
      state: null,
      attempt: null,
      durationMs: null,
    }));
  return [...stages, ...repairs]
    .sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0))
    .map(({ key, text, state, attempt, durationMs }) => ({ key, text, state, attempt, durationMs }));
}

function groupFindings(findings: JobFindingView[]): Array<{ serviceId: string; findings: JobFindingView[] }> {
  const groups: Array<{ serviceId: string; findings: JobFindingView[] }> = [];
  for (const finding of findings) {
    const existing = groups.find((group) => group.serviceId === finding.serviceId);
    if (existing) existing.findings.push(finding);
    else groups.push({ serviceId: finding.serviceId, findings: [finding] });
  }
  return groups;
}

function tasksFrom(findings: JobFindingView[]) {
  return findings.flatMap((finding) =>
    finding.proposedTasks.map((task) => ({
      ...task,
      serviceId: finding.serviceId,
      requirementId: finding.requirementId,
      findingId: finding.id,
    })),
  );
}
