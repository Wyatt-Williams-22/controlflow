# ControlFlow: Demo Cheat Sheet

## 1. Pre-flight (repo: controlflow, branch with PR #1)
- Terminal 1: `npm run dev` → http://localhost:3000
- Terminal 2: `npm run worker` (loads .env.local itself, so no source step needed)
- Expect: `ControlFlow worker started model=grok-4.20-0309-non-reasoning key=yes`
- Optional: `npm run smoke` → `smoke ok model=… echo=pong`
- Page: Mode = **Live**, Depth = **Standard**

## 2. The 3 beats
1. **Start job.** Click Analyze on the retention-change event. States: queued → selecting_evidence → analyzing → validating → awaiting_review.
2. **Show the Grok call.** `src/integrations/grok.ts` → `completeStructured()` (called from `src/workflows/analyze-control-event.ts`). Path: event → deterministic evidence selection (`EV-<service>-<n>`, line numbers, sha256) → Grok (json_schema, strict, temp 0) → code verifier (`verify-findings.ts`, 1 bounded repair) → human review.
3. **Approve twice = ONE local draft.** Click Approve, then re-POST `/api/jobs/<id>/approve` with `{"approve":true,"assessmentVersion":1}` → same `ticket.id`. Enforced by `UNIQUE (job_id, assessment_version)`.

## 3. Key numbers
- 7 findings across 3 services · 5/5 expected checks matched · verifier passed first try
- Grok call ~10.5 s (~11 s) · default `grok-4.20-0309-non-reasoning`
- Deep mode `grok-4.7`: ~167 s, ~14k reasoning tokens, failed verification

## 4. One-line answers
- **Why non-reasoning?** ~11 s and passes the verifier; grok-4.7 took ~167 s and still failed it. Deep stays opt-in.
- **Why a code verifier?** The model proposes and code checks it: unknown IDs, line ranges, service mismatch, duplicates, coverage and status. Nothing unverified gets stored.
- **FS fit:** Reg B keeps application and adverse-action records 25 months (12 CFR 1002.12). Retention changes ripple through underwriting. SR 11-7: documented inputs, the verifier as a control, human sign-off.

## 5. If something breaks
- **Fallback:** Mode = **Replay** → shows "REPLAY: not a live model call", still verified.
- Categories: missing_api_key · unauthorized · quota_exhausted · timeout (180 s, no retry) · rate_limited / server_error / network (2 retries) · bad_request · invalid_response · validation_error
- Stuck in analyzing? Check Depth = Standard, Retry, then Replay. Narrate; don't sit silent.

## 6. Live extension tip
- Start with the event: `fixtures/control-events/retention-change.json` (or paste into the Requirements JSON box).
- Then the code fixture (e.g. `fixtures/repos/data-retention-job/src/delete-covered.ts`). Verifier rules: `src/services/verify-findings.ts`. Prompt or model: `src/integrations/grok.ts`.
- Do the extension after you're done with Replay, because it shifts the cited lines.
