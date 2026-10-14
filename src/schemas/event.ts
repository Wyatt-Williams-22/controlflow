import { z } from "zod";

/**
 * Inputs to an analysis: the control event, the service catalog, the policy
 * config (the only place retention durations live), and one captured file.
 * Unknown keys are rejected so a confidence score cannot sneak in.
 */

const LIMITS = {
  id: 64,
  title: 200,
  description: 4_000,
  requirementText: 1_000,
  dataClass: 64,
  requirements: 20,
  dataClasses: 10,
  tags: 20,
  name: 120,
  team: 80,
  path: 200,
  allowlistedFiles: 20,
  services: 50,
  classifications: 20,
  numberedContent: 80_000,
};

const IdSchema = z.string().min(1).max(LIMITS.id);
const DataClassSchema = z.string().min(1).max(LIMITS.dataClass);

function isSafeRelativePath(value: string): boolean {
  if (value.includes("\0")) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const parts = value.split(/[\\/]/);
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

const RelativePathSchema = z
  .string()
  .min(1)
  .max(LIMITS.path)
  .refine(isSafeRelativePath, "path must be relative and stay inside its root");

export const RequirementSchema = z
  .object({
    id: IdSchema,
    text: z.string().min(1).max(LIMITS.requirementText),
    dataClasses: z.array(DataClassSchema).min(1).max(LIMITS.dataClasses),
  })
  .strict();

export const ControlEventSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1).max(LIMITS.title),
    description: z.string().min(1).max(LIMITS.description),
    policyVersion: z.string().min(1).max(LIMITS.id),
    requirements: z.array(RequirementSchema).min(1).max(LIMITS.requirements),
    createdAt: z.string().datetime(),
  })
  .strict();

export const ServiceCatalogEntrySchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(LIMITS.name),
    ownerTeam: z.string().min(1).max(LIMITS.team),
    tags: z.array(z.string().min(1).max(LIMITS.dataClass)).min(1).max(LIMITS.tags),
    dataClasses: z.array(DataClassSchema).min(1).max(LIMITS.dataClasses),
    fixtureRoot: RelativePathSchema,
    allowlistedFiles: z.array(RelativePathSchema).max(LIMITS.allowlistedFiles),
  })
  .strict();

export const ServiceCatalogSchema = z
  .object({
    services: z.array(ServiceCatalogEntrySchema).min(1).max(LIMITS.services),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    for (const service of catalog.services) {
      if (seen.has(service.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate service id ${service.id}`,
          path: ["services"],
        });
      }
      seen.add(service.id);
    }
  });

export const PolicyClassificationSchema = z
  .object({
    id: IdSchema,
    dataClass: DataClassSchema,
    retentionDays: z.number().int().positive().max(20_000),
    deletionMode: z.enum(["hard-delete"]),
  })
  .strict();

export const PolicyConfigSchema = z
  .object({
    policyVersion: z.string().min(1).max(LIMITS.id),
    classifications: z.array(PolicyClassificationSchema).min(1).max(LIMITS.classifications),
  })
  .strict();

export const EvidenceArtifactSchema = z
  .object({
    evidenceId: z.string().min(1).max(80),
    serviceId: IdSchema,
    relativePath: RelativePathSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    numberedContent: z.string().max(LIMITS.numberedContent),
    capturedAt: z.string().datetime(),
  })
  .strict();

export type Requirement = z.infer<typeof RequirementSchema>;
export type ControlEvent = z.infer<typeof ControlEventSchema>;
export type ServiceCatalogEntry = z.infer<typeof ServiceCatalogEntrySchema>;
export type ServiceCatalog = z.infer<typeof ServiceCatalogSchema>;
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;
