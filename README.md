# ControlFlow

ControlFlow is a small interview prototype for compliance change impact intelligence. A control event names new requirements. The app selects the services those requirements apply to, reads an allowlisted evidence packet, and (in a later step) asks Grok for an assessment. A person reviews that assessment before any ticket is drafted.

The target runtime is Node 20. The model call is a direct `fetch` to the xAI Chat Completions API. Retention durations live only in `fixtures/policy-config.json`.

## Run

```bash
npm install
npm test
npm run smoke
npm run dev
npm run worker
```

`npm test` runs the unit tests. It does not call xAI.

`npm run smoke` makes one real Chat Completions call when `XAI_API_KEY` is set. Copy `.env.example` to `.env.local` and fill in the key. `.env.local` is gitignored. When the key is missing, the script exits with an error and does not print a key.

`npm run dev` serves a placeholder page. `npm run worker` exits with a not-implemented message.

`GROK_MODEL` defaults to `grok-4.7`.

## Where the Grok call is

The only model call is `completeStructured` in `src/integrations/grok.ts`. It sends:

- `POST https://api.x.ai/v1/chat/completions`
- `Authorization: Bearer <XAI_API_KEY>`
- `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }`

That request shape matches the [xAI structured outputs guide](https://docs.x.ai/docs/guides/structured-outputs). The JSON text is read from `choices[0].message.content` and checked with Zod. The client aborts after 60 seconds, caps `max_tokens` at 4096, and retries at most twice (250ms, then 500ms) for HTTP 429, HTTP 5xx, and network or timeout errors. It does not retry HTTP 401, HTTP 403, or a schema failure. Logs contain a category, a status, and an attempt number. They do not contain the key, the prompt, or the response body.

`scripts/smoke-grok.ts` is the only caller in this step. The assessment JSON schema that a later workflow will send is `assessmentJsonSchema` in `src/schemas/assessment.ts`.

## Implemented so far

- Next.js App Router scaffold, Vitest, and the scripts above.
- Server-only Grok client and the smoke script.
- Zod schemas for a control event, the service catalog, the policy config, an evidence artifact, and an assessment. The assessment schema exports a strict-mode JSON Schema. There is no confidence score. `reviewRequired` is always `true`.
- Synthetic fixtures for a fictional retention-policy change:
  - `underwriting-api` persists derived cash-flow summaries and does not store a retention classification.
  - `document-ingestion-worker` records an owner and the classification id `derived-underwriting-summary`. That is the compliant example. The duration for the id is not copied into the source.
  - `data-retention-job` deletes raw documents (`raw-bank-document`), emits a deletion audit event, and does not cover derived summaries.
  - `marketing-email-service` is in the catalog and is out of scope. It has no repo fixture, because selection drops it before any file is read.
- Deterministic candidate selection. A service is in scope when one of its `dataClasses` or `tags` appears on a requirement. Catalog order is kept.
- The policy config is data, not an allowlisted source file. A later prompt can pass the parsed durations in. The model is not given a second copy of them inside a repo fixture.
- Evidence packets. The reader opens only allowlisted files, rejects absolute paths and `..`, follows a symlink only if it still resolves inside the fixture root, and stops at 20 files, 32KB per file, and 128KB per packet. Each artifact has a stable id (`EV-<serviceId>-<n>`), numbered lines, and a sha256 of the raw bytes.
- A verifier. Every cited evidence id must exist, `1 <= startLine <= endLine <= lineCount`, and the finding's service must match the artifact. Excerpts are copied from those source lines. Failures come back as a list of `{ code, findingId, evidenceId, message }`.

One question is uncovered on purpose. `REQ-AUDIT-EVENT` asks for an auditable deletion event and for the retention period of that audit record. The retention job emits an event. Neither the job nor the policy config says how long the audit record is kept. An assessment has to use `insufficient_evidence` for that part. It should not invent a duration.

## Planned

- SQLite job store with `better-sqlite3` (Node 20 does not provide `node:sqlite`), a worker, and job routes for create, status, and approve.
- The analysis workflow: select services, build the packet, call `completeStructured` with `assessmentJsonSchema`, then run `verifyFindings`. A failed check fails the job. It does not become a successful assessment.
- The review page: event input, status, findings, server-derived excerpts, and an explicit approval that drafts a ticket.
- Idempotent draft tickets and an audit trail. Approval stays a separate step from generation.

## Layout

```
app/page.tsx                         placeholder
scripts/smoke-grok.ts                one live call
src/integrations/grok.ts             the model call
src/schemas/event.ts                 event, catalog, policy, evidence
src/schemas/assessment.ts            assessment and its JSON Schema
src/services/select-candidates.ts    tag and data-class match
src/services/evidence.ts             allowlisted packet
src/services/verify-findings.ts      citation checks and excerpts
src/worker.ts                        not implemented
fixtures/control-events/retention-change.json
fixtures/service-catalog.json
fixtures/policy-config.json
fixtures/repos/                      three small service trees
tests/                               unit tests
```

Routes, the database, and the analysis workflow are not in this tree yet.
