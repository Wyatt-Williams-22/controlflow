import { z } from "zod";

/**
 * Model output. reviewRequired is always true: a person approves before any
 * ticket exists. There is no confidence field.
 *
 * assessmentJsonSchema is the document sent as response_format.json_schema.schema.
 * xAI strict mode wants every property listed in `required` and
 * additionalProperties: false. Bounds here match the Zod schema.
 */

const LIMITS = {
  id: 64,
  summary: 2_000,
  findings: 32,
  rationale: 2_000,
  evidence: 8,
  citationRationale: 500,
  tasks: 8,
  taskTitle: 200,
  team: 80,
  acceptance: 1_000,
  reviewers: 10,
  reviewer: 80,
  unknowns: 8,
  unknown: 500,
  questions: 16,
  question: 500,
  line: 10_000,
};

export const FINDING_STATUSES = ["potential_gap", "supported_control", "insufficient_evidence"] as const;
export const IMPACT_PRIORITIES = ["low", "medium", "high"] as const;

export const ASSESSMENT_SCHEMA_NAME = "control_event_assessment";

const EvidenceCitationSchema = z
  .object({
    evidenceId: z.string().min(1).max(80),
    startLine: z.number().int().min(1).max(LIMITS.line),
    endLine: z.number().int().min(1).max(LIMITS.line),
    rationale: z.string().min(1).max(LIMITS.citationRationale),
  })
  .strict();

const ProposedTaskSchema = z
  .object({
    title: z.string().min(1).max(LIMITS.taskTitle),
    ownerTeam: z.string().min(1).max(LIMITS.team),
    acceptanceCriteria: z.array(z.string().min(1).max(LIMITS.acceptance)).min(2).max(4),
    requiredReviewers: z.array(z.string().min(1).max(LIMITS.reviewer)).max(LIMITS.reviewers),
  })
  .strict();

export const FindingSchema = z
  .object({
    id: z.string().min(1).max(LIMITS.id),
    serviceId: z.string().min(1).max(LIMITS.id),
    requirementId: z.string().min(1).max(LIMITS.id),
    status: z.enum(FINDING_STATUSES),
    impactPriority: z.enum(IMPACT_PRIORITIES),
    rationale: z.string().min(1).max(LIMITS.rationale),
    evidence: z.array(EvidenceCitationSchema).max(LIMITS.evidence),
    proposedTasks: z.array(ProposedTaskSchema).max(LIMITS.tasks),
    unknowns: z.array(z.string().min(1).max(LIMITS.unknown)).max(LIMITS.unknowns),
  })
  .strict();

export const AssessmentSchema = z
  .object({
    summary: z.string().min(1).max(LIMITS.summary),
    findings: z.array(FindingSchema).max(LIMITS.findings),
    unresolvedQuestions: z.array(z.string().min(1).max(LIMITS.question)).max(LIMITS.questions),
    reviewRequired: z.literal(true),
  })
  .strict();

export type EvidenceCitation = z.infer<typeof EvidenceCitationSchema>;
export type ProposedTask = z.infer<typeof ProposedTaskSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Assessment = z.infer<typeof AssessmentSchema>;

type JsonSchema = Record<string, unknown>;

function objectSchema(properties: Record<string, JsonSchema>, extras?: Record<string, unknown>): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
    ...extras,
  };
}

function stringSchema(maxLength: number, description?: string): JsonSchema {
  return description ? { type: "string", maxLength, description } : { type: "string", maxLength };
}

const citationJsonSchema = objectSchema({
  evidenceId: stringSchema(80),
  startLine: { type: "integer", minimum: 1, maximum: LIMITS.line },
  endLine: { type: "integer", minimum: 1, maximum: LIMITS.line },
  rationale: stringSchema(LIMITS.citationRationale),
});

const taskJsonSchema = objectSchema({
  title: stringSchema(LIMITS.taskTitle),
  ownerTeam: stringSchema(LIMITS.team),
  acceptanceCriteria: {
    type: "array",
    minItems: 2,
    maxItems: 4,
    description:
      "Two to four concrete testable statements. Example: a unit test asserts the inserted row stores an owner.",
    items: stringSchema(LIMITS.acceptance),
  },
  requiredReviewers: {
    type: "array",
    items: stringSchema(LIMITS.reviewer),
    maxItems: LIMITS.reviewers,
  },
});

const findingJsonSchema = objectSchema({
  id: stringSchema(LIMITS.id),
  serviceId: stringSchema(LIMITS.id),
  requirementId: stringSchema(LIMITS.id),
  status: {
    type: "string",
    enum: [...FINDING_STATUSES],
    description:
      "supported_control: the packet shows the required behavior. potential_gap: positive evidence that code the artifact covers contradicts or omits a required behavior. insufficient_evidence: the required fact is not in the supplied artifacts; record it as an unknown. Lack of evidence is not proof of absence.",
  },
  impactPriority: { type: "string", enum: [...IMPACT_PRIORITIES] },
  rationale: stringSchema(LIMITS.rationale),
  evidence: { type: "array", items: citationJsonSchema, maxItems: LIMITS.evidence },
  proposedTasks: { type: "array", items: taskJsonSchema, maxItems: LIMITS.tasks },
  unknowns: {
    type: "array",
    items: stringSchema(LIMITS.unknown),
    maxItems: LIMITS.unknowns,
  },
});

export const assessmentJsonSchema: JsonSchema = objectSchema(
  {
    summary: stringSchema(LIMITS.summary),
    findings: { type: "array", items: findingJsonSchema, maxItems: LIMITS.findings },
    unresolvedQuestions: {
      type: "array",
      items: stringSchema(LIMITS.question),
      maxItems: LIMITS.questions,
    },
    reviewRequired: { type: "boolean", const: true },
  },
  { description: "Impact assessment for one control event. A person must review it." },
);
