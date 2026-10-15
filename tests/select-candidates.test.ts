import { describe, expect, it } from "vitest";

import type { ServiceCatalogEntry } from "../src/schemas/event";
import { selectCandidateServices } from "../src/services/select-candidates";
import { loadCatalog, loadEvent } from "./helpers";

describe("candidate selection", () => {
  it("keeps the three in-scope services and excludes the unrelated one", () => {
    const selected = selectCandidateServices(loadEvent(), loadCatalog().services);
    expect(selected.map((service) => service.id)).toEqual([
      "underwriting-api",
      "document-ingestion-worker",
      "data-retention-job",
    ]);
    expect(selected.map((service) => service.id)).not.toContain("marketing-email-service");
  });

  it("matches a tag or a data class, and ignores a service with neither", () => {
    const event = loadEvent();
    const base: ServiceCatalogEntry = {
      id: "example",
      name: "Example",
      ownerTeam: "team",
      tags: ["other"],
      dataClasses: ["other-class"],
      fixtureRoot: "fixtures/repos/example",
      allowlistedFiles: [],
    };
    const catalog: ServiceCatalogEntry[] = [
      { ...base, id: "by-tag", tags: ["derived-underwriting-artifact"] },
      { ...base, id: "by-class", dataClasses: ["derived-underwriting-artifact"] },
      { ...base, id: "neither" },
    ];

    expect(selectCandidateServices(event, catalog).map((service) => service.id)).toEqual([
      "by-tag",
      "by-class",
    ]);
  });
});
