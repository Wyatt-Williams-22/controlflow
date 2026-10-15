import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadCatalog, loadEvent, loadPolicy, repoRoot } from "./helpers";

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

describe("retention fixtures", () => {
  it("keeps retention durations only in the policy config", () => {
    const policy = loadPolicy();
    const event = loadEvent();
    expect(event.policyVersion).toBe(policy.policyVersion);
    expect(policy.classifications.every((item) => item.retentionDays >= 1000)).toBe(true);

    const durations = policy.classifications.map((item) => String(item.retentionDays));
    for (const file of walk(path.join(repoRoot, "fixtures"))) {
      if (file.endsWith(`${path.sep}policy-config.json`)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const duration of durations) {
        expect(text.includes(duration), `${path.relative(repoRoot, file)} mentions ${duration}`).toBe(false);
      }
    }
  });

  it("tells the three service stories without covering audit-record retention", () => {
    const policyIds = new Set(loadPolicy().classifications.map((item) => item.id));
    expect(policyIds.has("derived-underwriting-summary")).toBe(true);
    expect(policyIds.has("raw-bank-document")).toBe(true);

    const underwriting = fs.readFileSync(
      path.join(repoRoot, "fixtures/repos/underwriting-api/src/persist-cashflow.ts"),
      "utf8",
    );
    const ingestion = fs.readFileSync(
      path.join(repoRoot, "fixtures/repos/document-ingestion-worker/src/classify-artifact.ts"),
      "utf8",
    );
    const retention = fs.readFileSync(
      path.join(repoRoot, "fixtures/repos/data-retention-job/src/delete-covered.ts"),
      "utf8",
    );

    expect(underwriting).not.toContain("derived-underwriting-summary");
    expect(underwriting).not.toContain("owner:");
    expect(underwriting).not.toContain("retentionClassification");
    expect(ingestion).toContain("document-platform");
    expect(ingestion).toContain("derived-underwriting-summary");
    expect(retention).toContain("raw-bank-document");
    expect(retention).not.toContain("derived-underwriting-summary");
    expect(retention.toLowerCase()).not.toContain("retentiondays");
    expect(loadCatalog().services).toHaveLength(4);
  });
});
