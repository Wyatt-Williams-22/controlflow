import { describe, expect, it } from "vitest";

import { AssessmentSchema, type Assessment } from "../src/schemas/assessment";
import { buildEvidencePacket, sourceLines } from "../src/services/evidence";
import { selectCandidateServices } from "../src/services/select-candidates";
import { verifyFindings } from "../src/services/verify-findings";
import { loadCatalog, loadEvent, repoRoot } from "./helpers";

const CAPTURED_AT = "2026-10-14T15:00:00.000Z";

function packet() {
  const services = selectCandidateServices(loadEvent(), loadCatalog().services).filter(
    (service) => service.id === "underwriting-api",
  );
  return buildEvidencePacket({ repoRoot, services, capturedAt: CAPTURED_AT });
}

function assessment(evidence: Assessment["findings"][number]["evidence"], serviceId = "underwriting-api"): Assessment {
  return AssessmentSchema.parse({
    summary: "Checked one citation.",
    findings: [
      {
        id: "F-1",
        serviceId,
        requirementId: "REQ-OWNER",
        status: "potential_gap",
        impactPriority: "medium",
        rationale: "The summary row has no owner field.",
        evidence,
        proposedTasks: [],
        unknowns: [],
      },
    ],
    unresolvedQuestions: [],
    reviewRequired: true,
  });
}

describe("finding verifier", () => {
  it("copies the excerpt from the source lines", () => {
    const artifacts = packet().artifacts;
    const artifact = artifacts[0];
    const result = verifyFindings(
      assessment([
        {
          evidenceId: artifact.evidenceId,
          startLine: 1,
          endLine: 1,
          rationale: "not the source line",
        },
      ]),
      artifacts,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings[0].evidence[0].excerpt).toBe(sourceLines(artifact)[0]);
    expect(result.findings[0].evidence[0].excerpt).not.toBe("not the source line");
    expect(result.findings[0].evidence[0].relativePath).toBe(artifact.relativePath);
  });

  it("rejects an unknown evidence id", () => {
    const result = verifyFindings(
      assessment([
        {
          evidenceId: "EV-underwriting-api-99",
          startLine: 1,
          endLine: 1,
          rationale: "This id is not in the packet.",
        },
      ]),
      packet().artifacts,
    );

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "unknown_evidence",
          findingId: "F-1",
          evidenceId: "EV-underwriting-api-99",
          message: "evidence id EV-underwriting-api-99 is not in the packet",
        },
      ],
    });
  });

  it("rejects a line range outside the file", () => {
    const artifacts = packet().artifacts;
    const lineCount = sourceLines(artifacts[0]).length;
    const pastEnd = verifyFindings(
      assessment([
        {
          evidenceId: artifacts[0].evidenceId,
          startLine: 1,
          endLine: lineCount + 1,
          rationale: "The range runs past the file.",
        },
      ]),
      artifacts,
    );
    const reversed = verifyFindings(
      assessment([
        {
          evidenceId: artifacts[0].evidenceId,
          startLine: 3,
          endLine: 2,
          rationale: "The range is backwards.",
        },
      ]),
      artifacts,
    );
    const zero = assessment([
      {
        evidenceId: artifacts[0].evidenceId,
        startLine: 1,
        endLine: 1,
        rationale: "Zero is not a source line.",
      },
    ]);
    zero.findings[0].evidence[0].startLine = 0;
    const zeroResult = verifyFindings(zero, artifacts);

    expect(pastEnd.ok).toBe(false);
    expect(reversed.ok).toBe(false);
    expect(zeroResult.ok).toBe(false);
    if (pastEnd.ok || reversed.ok || zeroResult.ok) return;
    expect(pastEnd.errors.map((error) => error.code)).toEqual(["invalid_line_range"]);
    expect(reversed.errors.map((error) => error.code)).toEqual(["invalid_line_range"]);
    expect(zeroResult.errors.map((error) => error.code)).toEqual(["invalid_line_range"]);
  });

  it("rejects a citation whose service does not match the finding", () => {
    const artifacts = packet().artifacts;
    const result = verifyFindings(
      assessment(
        [
          {
            evidenceId: artifacts[0].evidenceId,
            startLine: 1,
            endLine: 1,
            rationale: "This file belongs to underwriting.",
          },
        ],
        "marketing-email-service",
      ),
      artifacts,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        code: "service_mismatch",
        findingId: "F-1",
        evidenceId: artifacts[0].evidenceId,
        message: "finding service marketing-email-service does not match evidence service underwriting-api",
      },
    ]);
  });

  it("rejects a second finding for the same service and requirement", () => {
    const artifacts = packet().artifacts;
    const citation = {
      evidenceId: artifacts[0].evidenceId,
      startLine: 1,
      endLine: 1,
      rationale: "The first line.",
    };
    const first = assessment([citation]).findings[0];
    const conflicting = AssessmentSchema.parse({
      summary: "Two findings cover the same pair.",
      findings: [first, { ...first, id: "F-2", status: "supported_control" }],
      unresolvedQuestions: [],
      reviewRequired: true,
    });
    const conflict = verifyFindings(conflicting, artifacts);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.errors).toEqual([
        {
          code: "duplicate_finding",
          findingId: "F-2",
          evidenceId: "",
          message: "findings F-1 (potential_gap) and F-2 (supported_control) both cover underwriting-api / REQ-OWNER",
        },
      ]);
    }

    const repeated = AssessmentSchema.parse({
      ...conflicting,
      findings: [first, { ...first, id: "F-2" }],
    });
    const sameStatus = verifyFindings(repeated, artifacts);
    expect(sameStatus.ok).toBe(false);
    if (!sameStatus.ok) expect(sameStatus.errors[0]?.code).toBe("duplicate_finding");
  });

  it("allows an insufficient-evidence finding with no citations", () => {
    const parsed = AssessmentSchema.parse({
      summary: "Audit retention is not in the packet.",
      findings: [
        {
          id: "F-audit",
          serviceId: "data-retention-job",
          requirementId: "REQ-AUDIT-EVENT",
          status: "insufficient_evidence",
          impactPriority: "medium",
          rationale: "The job emits an event, but nothing records how long that record is kept.",
          evidence: [],
          proposedTasks: [],
          unknowns: ["Audit-record retention is not in the policy config or the job source."],
        },
      ],
      unresolvedQuestions: ["Where is the audit-record retention period defined?"],
      reviewRequired: true,
    });

    const result = verifyFindings(parsed, packet().artifacts);
    expect(result).toMatchObject({
      ok: true,
      findings: [{ id: "F-audit", evidence: [] }],
    });
  });
});
