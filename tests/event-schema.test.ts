import { describe, expect, it } from "vitest";

import { ControlEventSchema, ServiceCatalogEntrySchema } from "../src/schemas/event";
import { loadCatalog, loadEvent } from "./helpers";

describe("control event schema", () => {
  it("accepts the retention-change fixture", () => {
    const event = loadEvent();
    expect(event.requirements.map((requirement) => requirement.id)).toEqual([
      "REQ-OWNER",
      "REQ-RETENTION-CLASS",
      "REQ-DELETION-COVERAGE",
      "REQ-AUDIT-EVENT",
    ]);
  });

  it("rejects an invalid event", () => {
    const event = loadEvent();
    const { requirements, ...withoutRequirements } = event;

    expect(ControlEventSchema.safeParse(withoutRequirements).success).toBe(false);
    expect(ControlEventSchema.safeParse({ ...event, requirements: [] }).success).toBe(false);
    expect(ControlEventSchema.safeParse({ ...event, title: "x".repeat(201) }).success).toBe(false);
    expect(ControlEventSchema.safeParse({ ...event, createdAt: "2026-10-14" }).success).toBe(false);
    expect(ControlEventSchema.safeParse({ ...event, confidence: 0.9 }).success).toBe(false);
    expect(requirements.length).toBeGreaterThan(0);
  });

  it("rejects a catalog path that leaves the fixture root", () => {
    const service = loadCatalog().services[0];
    expect(
      ServiceCatalogEntrySchema.safeParse({
        ...service,
        allowlistedFiles: ["../../fixtures/policy-config.json"],
      }).success,
    ).toBe(false);
    expect(
      ServiceCatalogEntrySchema.safeParse({
        ...service,
        allowlistedFiles: ["/etc/passwd"],
      }).success,
    ).toBe(false);
  });
});
