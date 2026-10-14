import { describe, expect, it } from "vitest";

import {
  ASSESSMENT_SCHEMA_NAME,
  AssessmentSchema,
  FINDING_STATUSES,
  IMPACT_PRIORITIES,
  assessmentJsonSchema,
  type Assessment,
} from "../src/schemas/assessment";

function sampleAssessment(): Assessment {
  return {
    summary: "One service is missing a retention classification.",
    findings: [
      {
        id: "F-1",
        serviceId: "underwriting-api",
        requirementId: "REQ-RETENTION-CLASS",
        status: "potential_gap",
        impactPriority: "high",
        rationale: "The cash-flow row does not store a classification id.",
        evidence: [
          {
            evidenceId: "EV-underwriting-api-1",
            startLine: 1,
            endLine: 2,
            rationale: "The persistence helper has no classification field.",
          },
        ],
        proposedTasks: [
          {
            title: "Store the classification id on the summary",
            ownerTeam: "credit-decisioning",
            acceptanceCriteria: "The row stores a classification id from the policy config.",
            requiredReviewers: ["records-management"],
          },
        ],
        unknowns: [],
      },
    ],
    unresolvedQuestions: ["How long is a deletion audit record kept?"],
    reviewRequired: true,
  };
}

type JsonObject = {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonObject>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonObject;
};

function assertStrictObjects(schema: JsonObject): void {
  if (schema.type === "object" && schema.properties) {
    expect(schema.additionalProperties).toBe(false);
    expect([...(schema.required ?? [])].sort()).toEqual(Object.keys(schema.properties).sort());
    for (const property of Object.values(schema.properties)) assertStrictObjects(property);
  }
  if (schema.type === "array" && schema.items) assertStrictObjects(schema.items);
}

describe("assessment schema", () => {
  it("accepts a review-gated assessment and rejects confidence scores", () => {
    const assessment = sampleAssessment();
    expect(AssessmentSchema.safeParse(assessment).success).toBe(true);
    expect(AssessmentSchema.safeParse({ ...assessment, reviewRequired: false }).success).toBe(false);
    expect(AssessmentSchema.safeParse({ ...assessment, confidence: 0.8 }).success).toBe(false);
    expect(
      AssessmentSchema.safeParse({
        ...assessment,
        findings: [{ ...assessment.findings[0], confidence: 1 }],
      }).success,
    ).toBe(false);
  });

  it("exports a strict-mode JSON schema for the Grok response format", () => {
    expect(ASSESSMENT_SCHEMA_NAME).toBe("control_event_assessment");
    assertStrictObjects(assessmentJsonSchema as JsonObject);
    const serialized = JSON.stringify(assessmentJsonSchema);
    expect(serialized).not.toContain("confidence");

    const findings = (assessmentJsonSchema.properties as { findings: { items: JsonObject } }).findings.items;
    expect(findings.properties?.status.enum).toEqual([...FINDING_STATUSES]);
    expect(findings.properties?.impactPriority.enum).toEqual([...IMPACT_PRIORITIES]);
    expect((assessmentJsonSchema.properties as { reviewRequired: JsonObject }).reviewRequired).toEqual({
      type: "boolean",
      const: true,
    });
  });
});
