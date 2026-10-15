# Live run notes

Recorded live run of ControlFlow against the synthetic fixtures (Oct 14, 2026, ~5:11 PM ET). No secrets or keys are included.

- **Mode:** live (not replay), analysis depth `standard`
- **Model:** `grok-4.20-0309-non-reasoning`
- **Final state:** `draft_created`, verifier passed on first attempt (no repair)
- **Timing:** Grok `analyzing` stage 10.5 s; evidence selection 4 ms; validation 2 ms; end to end ~13.4 s including human review

## Findings (7 across 3 services)

| ID | Service | Requirement | Status | Priority |
|----|---------|-------------|--------|----------|
| F1 | underwriting-api | REQ-OWNER | potential_gap | high |
| F2 | underwriting-api | REQ-RETENTION-CLASS | potential_gap | high |
| F3 | document-ingestion-worker | REQ-OWNER | supported_control | low |
| F4 | document-ingestion-worker | REQ-RETENTION-CLASS | supported_control | low |
| F5 | data-retention-job | REQ-DELETION-COVERAGE | potential_gap | high |
| F6 | data-retention-job | REQ-AUDIT-EVENT | supported_control | medium |
| F7 | data-retention-job | REQ-AUDIT-RETENTION | insufficient_evidence | medium |

## Draft

**`[LOCAL DRAFT] Retention control 2026.10-retention: 4 remediation tasks`** (tasks for F1, F2, F5, F7). A local draft only, not a compliance certification; nothing is written externally. Approving twice produces exactly one draft.
