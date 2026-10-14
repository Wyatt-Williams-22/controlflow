# ControlFlow

ControlFlow is a small interview prototype for compliance change impact intelligence. A person submits a control event. A worker selects the services in scope, reads an allowlisted evidence packet, and asks Grok for an assessment. The person reviews that assessment before a local draft ticket is written.

The target runtime is Node 20. The model call is a direct `fetch`. Retention durations live only in `fixtures/policy-config.json`. The database is a local SQLite file opened with `better-sqlite3` (`node:sqlite` is not used, because Node 20 does not provide it).

## Run

Use two terminals:

```bash
npm install
npm test
npm run dev
```

```bash
npm run worker
```

`npm test` does not call xAI. `npm run smoke` makes one real Chat Completions call when `XAI_API_KEY` is set. Copy `.env.example` to `.env.local` and fill in the key. `.env.local` and `data/*.db` are gitignored. When the key is missing, smoke exits with an error and does not print a key.

`GROK_MODEL` defaults to `grok-4.7`. The dev server and the worker share `data/controlflow.db` (override with `CONTROLFLOW_DB`).

## Where the Grok call is

The only model call is `completeStructured` in `src/integrations/grok.ts`. It sends:

- `POST https://api.x.ai/v1/chat/completions`
- `Authorization: Bearer <XAI_API_KEY>`
- `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }`

That request shape matches the [xAI structured outputs guide](https://docs.x.ai/docs/guides/structured-outputs). The JSON text is read from `choices[0].message.content` and checked with Zod. The client aborts after 60 seconds, caps `max_tokens` at 4096, and retries at most twice (250ms, then 500ms) for HTTP 429, HTTP 5xx, and network or timeout errors. It does not retry HTTP 401, HTTP 403, or a schema failure. Its own log line is a category, a status, and an attempt number.

The workflow calls it from `src/workflows/analyze-control-event.ts` with the client log turned off. The worker then logs only `job=<id> stage=<state> duration_ms=<n>` when a stage finishes. Responses do not include the API key or the prompt.

## Trigger to output

1. The page posts the seeded event to `POST /api/events`. Zod checks the size bounds and the route inserts a `queued` job. Live is the default. Replay is an explicit choice on that request.
2. `npm run worker` claims the oldest queued job and moves it to `selecting_evidence`. On startup, a job left in `selecting_evidence`, `analyzing`, or `validating` is marked `failed` with category `interrupted`. `queued` stays queued. `awaiting_review` stays for the person. Retry is a new attempt on the same job id, not a transition out of `failed`.
3. The workflow selects services whose tags or data classes intersect the requirement data classes, then reads only allowlisted files into an evidence packet.
4. Live mode moves to `analyzing` and calls `completeStructured` with the assessment JSON Schema. The prompt says the source is untrusted data, citations must use the supplied ids and line ranges, retention periods must not be inferred, unknowns must be reported, and the model must not make legal conclusions. Replay mode does not call the model. It loads `fixtures/replay/retention-verified.json`.
5. `validating` runs `verifyFindings`. Every cited id must exist, `1 <= startLine <= endLine <= lineCount`, and the finding's service must match the artifact. Excerpts are copied from those source lines. If a live assessment fails that check, the workflow makes one repair call and includes the verifier errors. A second failure marks the job `failed` with category `validation_error` and stores no assessment.
6. A verified assessment is stored and the job moves to `awaiting_review`. The page polls `GET /api/jobs/[id]` and shows the summary, findings grouped by service, the server-derived lines, unknowns, reviewers, and the audit trail. A replay job is shown as `REPLAY: not a live model call`.
7. `POST /api/jobs/[id]/approve` with `{ approve: true, assessmentVersion }` is allowed only from `awaiting_review`. Inside one transaction it writes a ticket labelled `LOCAL DRAFT` (not a compliance certification) and an audit event, then moves to `draft_created`. The ticket table has `UNIQUE (job_id, assessment_version)`, so a repeat request returns the same draft.

Allowed pipeline moves are `queued → selecting_evidence → analyzing → validating → awaiting_review → draft_created`. Any of those active states may instead go to `failed`.

## Implemented

- Next.js App Router, Vitest, the Grok client, and the smoke script.
- Zod schemas for the event, catalog, policy config, evidence, and assessment, plus a strict-mode JSON Schema. No confidence score. `reviewRequired` is always `true`.
- Synthetic retention fixtures. `underwriting-api` stores derived cash-flow summaries with no classification. `document-ingestion-worker` records an owner and the classification id `derived-underwriting-summary`. `data-retention-job` deletes raw documents, emits an audit event, and does not cover derived summaries. `marketing-email-service` is out of scope and has no repo fixture.
- Durations live only in `fixtures/policy-config.json`. `REQ-AUDIT-EVENT` is uncovered on purpose: nothing records how long the audit record is kept, so the saved replay uses `insufficient_evidence`.
- Deterministic candidate selection, the allowlisted evidence packet, and the citation verifier.
- SQLite jobs, stage events, analysis inputs, versioned verified assessments, tickets, and audit events.
- The worker, the analysis workflow (including one repair), replay mode, and the event, job, retry, and approve routes.
- A single page: synthetic-data label, seeded event, editable description and requirements, live/replay, polled timeline, findings, evidence lines, draft approval, and the audit trail.

## Production roadmap

This process is one Node process and one SQLite file. A team running it for real would replace that with:

- A durable queue and a dead-letter queue, so a crashed worker does not depend on a startup scan of in-flight rows.
- Least-privilege Git access. The worker would read pinned commits through a read-only credential, not a local working tree.
- RBAC, so the person who runs an analysis is not automatically the person who approves the draft.
- Tenancy, so one customer's events, packets, and drafts are not rows in a shared file.
- Encryption and retention for the database, the evidence packet, and the prompts. The packet is source code.
- An append-only audit log. The table in this prototype can be updated by the same process that writes it.
- Evals for citation accuracy, the uncovered-audit case, and refusal to invent a retention duration.
- Observability beyond one duration line: traces per stage, token counts, and error budgets. Still no prompt or key in the logs.
- Prompt-injection testing. The packet is untrusted data, and the system prompt says so, but that instruction is not a control.
- Ticket adapters. `LOCAL DRAFT` would become a real tracker write behind an interface, still only after approval.

## Why there is no vector database

The catalog is a handful of services. Selection is an exact intersection of tags and data classes, and the packet is capped at 20 files and 128KB. The model sees that whole packet. Similarity search would add a ranking step this demo does not need, and it would make the citations harder to explain.

## Limitations

- Localhost only. There is no authentication and no authorization.
- The audit table is not tamper-proof. The same SQLite file can be edited.
- Replay is one saved assessment for the retention fixture. It is still checked against the packet, but editing the event does not create a new model answer in replay mode.
- A worker restart fails in-flight attempts. The person uses Retry, which starts a new attempt.
- Live mode needs `XAI_API_KEY`. Without it the job fails with category `missing_api_key` and no assessment is stored.
