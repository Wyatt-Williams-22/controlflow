import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postEvent } from "../app/api/events/route";
import { POST as postApprove } from "../app/api/jobs/[id]/approve/route";
import { GET as getJob } from "../app/api/jobs/[id]/route";
import { POST as postRetry } from "../app/api/jobs/[id]/retry/route";
import replayAssessment from "../fixtures/replay/retention-verified.json";
import { TransitionError, assertTransition, countTickets, createJob, getDatabase, resetDatabaseForTests, transitionJob } from "../src/storage/db";
import { LOCAL_DRAFT_LABEL, LOCAL_DRAFT_NOTICE, REPLAY_NOTICE, type JobView } from "../src/types/job-view";
import { pollOnce, recoverInterrupted } from "../src/worker";
import { ANALYSIS_MAX_TOKENS, DEFAULT_DEEP_GROK_MODEL, DEFAULT_GROK_MODEL } from "../src/integrations/grok";
import { analysisModel, analysisTimeoutMs } from "../src/workflows/analyze-control-event";
import { loadEvent, repoRoot } from "./helpers";

const KEY = "test-key-do-not-log";

let directory = "";
let logs: string[] = [];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "controlflow-db-"));
  process.env.CONTROLFLOW_DB = path.join(directory, "test.db");
  resetDatabaseForTests();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
  vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDatabaseForTests();
  delete process.env.CONTROLFLOW_DB;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("job pipeline", () => {
  it("rejects an invalid event and a forbidden transition", async () => {
    const event = loadEvent();
    const response = await postEvent(jsonRequest({ event: { ...event, title: "x".repeat(201) }, mode: "live" }));
    expect(response.status).toBe(400);
    expect(() => assertTransition("queued", "draft_created")).toThrow(TransitionError);
    expect(() => assertTransition("draft_created", "failed")).toThrow(TransitionError);
    expect(() => assertTransition("analyzing", "failed")).not.toThrow();
  });

  it("rejects approval without consent or from the wrong state", async () => {
    const id = await enqueue("replay");
    const tooSoon = await approve(id, { approve: true, assessmentVersion: 1 });
    expect(tooSoon.status).toBe(409);
    expect(countTickets(getDatabase(), id)).toBe(0);

    await pollOnce(getDatabase(), { repoRoot, grok: grokOptions(async () => {
        throw new Error("replay must not call the model");
      }), });
    const refused = await approve(id, { approve: false, assessmentVersion: 1 });
    expect(refused.status).toBe(400);
    const view = await readJob(id);
    expect(view.state).toBe("awaiting_review");
    expect(view.ticket).toBeNull();
    expect(countTickets(getDatabase(), id)).toBe(0);
  });

  it("returns the same local draft on a duplicate approval", async () => {
    const id = await enqueue("replay");
    await pollOnce(getDatabase(), { repoRoot });
    const first = await approve(id, { approve: true, assessmentVersion: 1 });
    const second = await approve(id, { approve: true, assessmentVersion: 1 });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { ticket: { id: string; title: string; label: string; notice: string } };
    const secondBody = (await second.json()) as { ticket: { id: string } };
    expect(firstBody.ticket.id).toBe(secondBody.ticket.id);
    expect(firstBody.ticket.label).toBe(LOCAL_DRAFT_LABEL);
    expect(firstBody.ticket.notice).toBe(LOCAL_DRAFT_NOTICE);
    expect(firstBody.ticket.title).toBe("[LOCAL DRAFT] Retention control 2026.10-retention: 3 remediation tasks");
    expect(countTickets(getDatabase(), id)).toBe(1);
    const view = await readJob(id);
    expect(view.state).toBe("draft_created");
    expect(view.draftTitle).toBe("[LOCAL DRAFT] Retention control 2026.10-retention: 3 remediation tasks");
    expect(view.ticket?.title).toBe(view.draftTitle);
    expect(view.audit.filter((entry) => entry.action === "draft_created")).toHaveLength(1);
  });

  it("shows a failed live job and no assessment when the provider returns 500", async () => {
    const id = await enqueue("live");
    let calls = 0;
    await pollOnce(getDatabase(), {
      repoRoot,
      grok: grokOptions(async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { type: "api_error" } }), { status: 500 });
      }),
    });
    const view = await readJob(id);
    expect(calls).toBe(3);
    expect(view.state).toBe("failed");
    expect(view.errorCategory).toBe("server_error");
    expect(view.assessment).toBeNull();
    expect(view.ticket).toBeNull();
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("uses the analysis token budget and does not retry a client timeout", async () => {
    delete process.env.GROK_TIMEOUT_MS;
    delete process.env.GROK_MODEL;
    delete process.env.GROK_DEEP_MODEL;
    expect(analysisTimeoutMs({})).toBe(180_000);
    expect(analysisTimeoutMs({}, "deep")).toBe(360_000);
    expect(analysisTimeoutMs({ env: { GROK_TIMEOUT_MS: "90000" } }, "deep")).toBe(90_000);
    expect(analysisModel({ env: {} })).toBe(DEFAULT_GROK_MODEL);
    expect(analysisModel({ env: {} }, "deep")).toBe(DEFAULT_DEEP_GROK_MODEL);
    expect(analysisModel({ env: { GROK_DEEP_MODEL: "grok-4.5" } }, "deep")).toBe("grok-4.5");
    expect(analysisModel({ model: "pinned" }, "deep")).toBe("pinned");
    process.env.GROK_TIMEOUT_MS = "1000";
    process.env.GROK_MODEL = "from-env";
    expect(analysisTimeoutMs({})).toBe(1_000);
    expect(analysisModel({})).toBe("from-env");
    expect(analysisTimeoutMs({ env: {} })).toBe(180_000);
    expect(analysisModel({ env: {} })).toBe(DEFAULT_GROK_MODEL);
    expect(analysisTimeoutMs({ env: { GROK_TIMEOUT_MS: "120000" } })).toBe(120_000);
    expect(analysisTimeoutMs({ timeoutMs: 10, env: { GROK_TIMEOUT_MS: "120000" } })).toBe(10);
    delete process.env.GROK_TIMEOUT_MS;
    delete process.env.GROK_MODEL;
    delete process.env.GROK_DEEP_MODEL;

    const id = await enqueue("live");
    let calls = 0;
    let requestBody: Record<string, unknown> | undefined;
    await pollOnce(getDatabase(), {
      repoRoot,
      grok: grokOptions(async (_url, init) => {
        calls += 1;
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const error = new Error(`aborted while sending Bearer ${KEY}`);
        error.name = "AbortError";
        throw error;
      }),
    });
    const view = await readJob(id);
    expect(calls).toBe(1);
    expect(view.state).toBe("failed");
    expect(view.errorCategory).toBe("timeout");
    expect(view.errorMessage).toBe("The model call timed out.");
    expect(view.assessment).toBeNull();
    expect(requestBody?.max_tokens).toBe(ANALYSIS_MAX_TOKENS);
    expect(requestBody?.temperature).toBe(0);
    const messages = requestBody?.messages as Array<{ role: string; content: string }>;
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const user = messages.find((message) => message.role === "user")?.content ?? "";
    expect(system).toContain("untrusted data");
    expect(system).toContain("Never infer a retention period");
    expect(system).toContain("insufficient_evidence");
    expect(system).toContain("at most one finding");
    expect(system).toContain("supported_control");
    expect(system).toContain("2 to 4 concrete testable statements");
    expect(user).toContain("document-ingestion-worker dataClasses=derived-underwriting-artifact");
    expect(requestBody?.model).toBe(DEFAULT_GROK_MODEL);
    expect(view.analysisDepth).toBe("standard");
    expect(view.model).toBe(DEFAULT_GROK_MODEL);
    expect(user).toContain("EV-underwriting-api-1");
    expect(user).toContain("2555");
    expect(user).toContain("2190");
    expect(user).toContain("1|");
    expect(user).not.toContain("2026-10-14T15:00:00.000Z");
    const source = fs.readFileSync(path.join(repoRoot, "fixtures/repos/underwriting-api/src/persist-cashflow.ts"));
    const hash = crypto.createHash("sha256").update(source).digest("hex");
    expect(user).not.toContain(hash);
    expect(user.length).toBeLessThan(8_000);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("shows a failed live job when the provider connection fails", async () => {
    const id = await enqueue("live");
    await pollOnce(getDatabase(), {
      repoRoot,
      grok: grokOptions(async () => {
        throw new Error(`socket hang up while sending Bearer ${KEY}`);
      }),
    });
    const view = await readJob(id);
    expect(view.state).toBe("failed");
    expect(view.errorCategory).toBe("network");
    expect(view.assessment).toBeNull();
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(JSON.stringify(view)).not.toContain("socket hang up");
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("stores the deep model on the job and repairs a duplicate finding once", async () => {
    const id = await enqueue("live", "deep");
    const queued = await readJob(id);
    expect(queued.analysisDepth).toBe("deep");
    expect(queued.model).toBeNull();

    const good = replayAssessment;
    const last = good.findings[good.findings.length - 1];
    const duplicate = {
      ...good,
      findings: [...good.findings, { ...last, id: "F-audit-again", status: "supported_control" }],
    };
    let calls = 0;
    let repairText = "";
    let requestedModel = "";
    await pollOnce(getDatabase(), {
      repoRoot,
      grok: grokOptions(async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as { model?: string; messages?: Array<{ content: string }> };
        requestedModel = body.model ?? "";
        if (calls === 2) repairText = (body.messages ?? []).map((message) => message.content).join("\n");
        const assessment = calls === 1 ? duplicate : good;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(assessment) } }] }), { status: 200 });
      }),
    });
    const view = await readJob(id);
    expect(calls).toBe(2);
    expect(requestedModel).toBe(DEFAULT_DEEP_GROK_MODEL);
    expect(repairText).toContain("duplicate_finding");
    expect(repairText).toContain("REQ-AUDIT-EVENT");
    expect(view.state).toBe("awaiting_review");
    expect(view.analysisDepth).toBe("deep");
    expect(view.model).toBe(DEFAULT_DEEP_GROK_MODEL);
    expect(
      view.assessment?.findings.filter(
        (finding) => finding.serviceId === "data-retention-job" && finding.requirementId === "REQ-AUDIT-EVENT",
      ),
    ).toHaveLength(1);
    expect(view.audit.some((entry) => entry.detail.includes(`model=${DEFAULT_DEEP_GROK_MODEL}`))).toBe(true);
  });

  it("labels a replay job and checks the saved assessment without calling the model", async () => {
    const id = await enqueue("replay");
    let calls = 0;
    await pollOnce(getDatabase(), {
      repoRoot,
      grok: grokOptions(async () => {
        calls += 1;
        return new Response("nope", { status: 500 });
      }),
    });
    const view = await readJob(id);
    expect(calls).toBe(0);
    expect(view.mode).toBe("replay");
    expect(view.analysisDepth).toBe("standard");
    expect(view.model).toBeNull();
    expect(view.replayNotice).toBe(REPLAY_NOTICE);
    expect(view.state).toBe("awaiting_review");
    expect(view.assessment?.version).toBe(1);
    expect(view.draftTitle).toBe("[LOCAL DRAFT] Retention control 2026.10-retention: 3 remediation tasks");
    expect(view.assessment?.findings.some((finding) => finding.serviceId === "document-ingestion-worker")).toBe(true);
    const owner = view.assessment?.findings.find((finding) => finding.id === "F-owner-underwriting");
    const sourceLine = fs.readFileSync(path.join(repoRoot, "fixtures/repos/underwriting-api/src/persist-cashflow.ts"), "utf8").split("\n")[2];
    expect(owner?.evidence[0]?.excerpt).toBe(sourceLine);
    expect(JSON.stringify(view)).not.toContain("CANARY-NOT-IN-PACKET");
    expect(view.assessment?.findings.some((finding) => finding.serviceId === "marketing-email-service")).toBe(false);
  });

  it("sends verifier errors back once, then accepts the repaired assessment", async () => {
    const id = await enqueue("live");
    const broken = structuredClone(replayAssessment) as typeof replayAssessment;
    broken.findings[0].evidence[0].evidenceId = "EV-nope";
    const bodies: string[] = [];
    await pollOnce(getDatabase(), {
      repoRoot,
      grok: grokOptions(async (_url, init) => {
        bodies.push(String(init?.body ?? ""));
        const content = bodies.length === 1 ? broken : replayAssessment;
        return new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }] }),
          { status: 200 },
        );
      }),
    });
    const view = await readJob(id);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("EV-nope");
    expect(bodies[1]).not.toContain(KEY);
    expect(view.state).toBe("awaiting_review");
    expect(view.assessment?.findings[0]?.evidence[0]?.evidenceId).toBe("EV-underwriting-api-1");
  });

  it("accepts no findings when the repair is still invalid", async () => {
    const id = await enqueue("live");
    const broken = structuredClone(replayAssessment) as typeof replayAssessment;
    broken.findings[0].evidence[0].evidenceId = "EV-nope";
    let calls = 0;
    await pollOnce(getDatabase(), {
      repoRoot,
      grok: grokOptions(async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(broken) } }] }),
          { status: 200 },
        );
      }),
    });
    const view = await readJob(id);
    expect(calls).toBe(2);
    expect(view.state).toBe("failed");
    expect(view.errorCategory).toBe("validation_error");
    expect(view.assessment).toBeNull();
  });

  it("marks an in-flight job interrupted and retries it as a new attempt", async () => {
    const db = getDatabase();
    const created = createJob(db, { id: "job-interrupt", event: loadEvent(), mode: "live" });
    transitionJob(db, created.id, "selecting_evidence");
    transitionJob(db, created.id, "analyzing");
    expect(recoverInterrupted(db)).toEqual([created.id]);
    expect((await readJob(created.id)).errorCategory).toBe("interrupted");

    const failed = await enqueue("live");
    await pollOnce(db, {
      repoRoot,
      grok: grokOptions(async () => new Response("no", { status: 500 })),
    });
    const response = await postRetry(new Request("http://localhost/api/jobs/x/retry", { method: "POST" }), {
      params: Promise.resolve({ id: failed }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { attempt: number; state: string };
    expect(body).toEqual({ id: failed, attempt: 2, state: "queued" });
    expect((await readJob(failed)).assessment).toBeNull();
  });
});

function grokOptions(fetchImpl: typeof fetch) {
  return {
    apiKey: KEY,
    env: {},
    sleep: async () => {},
    fetchImpl,
  };
}

async function enqueue(mode: "live" | "replay", analysisDepth: "standard" | "deep" = "standard"): Promise<string> {
  const response = await postEvent(jsonRequest({ event: loadEvent(), mode, analysisDepth }));
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  return body.id;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function approve(id: string, body: unknown): Promise<Response> {
  return postApprove(
    new Request("http://localhost/api/jobs/x/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function readJob(id: string): Promise<JobView> {
  const response = await getJob(new Request(`http://localhost/api/jobs/${id}`), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  return (await response.json()) as JobView;
}
