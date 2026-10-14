import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ServiceCatalogEntry } from "../src/schemas/event";
import { EvidenceAccessError, buildEvidencePacket, sourceLines } from "../src/services/evidence";
import { selectCandidateServices } from "../src/services/select-candidates";
import { loadCatalog, loadEvent, repoRoot } from "./helpers";

const CAPTURED_AT = "2026-10-14T15:00:00.000Z";
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): { repo: string; serviceDir: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "controlflow-"));
  temps.push(repo);
  const serviceDir = path.join(repo, "svc");
  fs.mkdirSync(serviceDir);
  return { repo, serviceDir };
}

function service(fixtureRoot: string, allowlistedFiles: string[]): ServiceCatalogEntry {
  return {
    id: "svc",
    name: "Service",
    ownerTeam: "team",
    tags: ["derived-underwriting-artifact"],
    dataClasses: ["derived-underwriting-artifact"],
    fixtureRoot,
    allowlistedFiles,
  };
}

describe("evidence packet", () => {
  it("numbers allowlisted lines, hashes the bytes, and skips everything else", () => {
    const selected = selectCandidateServices(loadEvent(), loadCatalog().services);
    const packet = buildEvidencePacket({
      repoRoot,
      services: selected,
      capturedAt: CAPTURED_AT,
    });
    const again = buildEvidencePacket({
      repoRoot,
      services: selected,
      capturedAt: CAPTURED_AT,
    });

    expect(packet).toEqual(again);
    expect(packet.artifacts.map((artifact) => artifact.evidenceId)).toEqual([
      "EV-underwriting-api-1",
      "EV-document-ingestion-worker-1",
      "EV-data-retention-job-1",
    ]);
    expect(JSON.stringify(packet)).not.toContain("CANARY-NOT-IN-PACKET");

    const underwriting = packet.artifacts[0];
    const bytes = fs.readFileSync(path.join(repoRoot, "fixtures/repos/underwriting-api/src/persist-cashflow.ts"));
    expect(underwriting.contentHash).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    expect(underwriting.numberedContent.startsWith("1|")).toBe(true);
    expect(sourceLines(underwriting).length).toBeGreaterThan(1);
  });

  it("assigns ids from the sorted allowlist", () => {
    const { repo, serviceDir } = makeRepo();
    fs.writeFileSync(path.join(serviceDir, "b.txt"), "beta\n");
    fs.writeFileSync(path.join(serviceDir, "a.txt"), "alpha\n");

    const packet = buildEvidencePacket({
      repoRoot: repo,
      services: [service("svc", ["b.txt", "a.txt"])],
      capturedAt: CAPTURED_AT,
    });

    expect(packet.artifacts.map((artifact) => [artifact.evidenceId, artifact.relativePath, artifact.numberedContent])).toEqual([
      ["EV-svc-1", "a.txt", "1|alpha"],
      ["EV-svc-2", "b.txt", "1|beta"],
    ]);
  });

  it("rejects path traversal and absolute paths", () => {
    const { repo, serviceDir } = makeRepo();
    fs.writeFileSync(path.join(repo, "secret.txt"), "SECRET-TRAVERSAL");
    fs.writeFileSync(path.join(serviceDir, "a.txt"), "alpha\n");

    expect(() =>
      buildEvidencePacket({
        repoRoot: repo,
        services: [service("svc", ["../secret.txt"])],
        capturedAt: CAPTURED_AT,
      }),
    ).toThrow(expect.objectContaining({ name: "EvidenceAccessError", code: "path_traversal" }));

    expect(() =>
      buildEvidencePacket({
        repoRoot: repo,
        services: [service("svc", [path.join(serviceDir, "a.txt")])],
        capturedAt: CAPTURED_AT,
      }),
    ).toThrow(expect.objectContaining({ code: "absolute_path" }));

    try {
      buildEvidencePacket({
        repoRoot: repo,
        services: [service("svc", ["../secret.txt"])],
        capturedAt: CAPTURED_AT,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceAccessError);
      expect((error as Error).message).not.toContain("SECRET-TRAVERSAL");
    }
  });

  it("rejects a symlink that resolves outside the fixture root", () => {
    const { repo, serviceDir } = makeRepo();
    const outside = path.join(repo, "secret.txt");
    fs.writeFileSync(outside, "SECRET-OUTSIDE");
    fs.symlinkSync(outside, path.join(serviceDir, "linked.txt"));

    expect(() =>
      buildEvidencePacket({
        repoRoot: repo,
        services: [service("svc", ["linked.txt"])],
        capturedAt: CAPTURED_AT,
      }),
    ).toThrow(expect.objectContaining({ code: "outside_root" }));
  });

  it("rejects packets that exceed the file or byte bound", () => {
    const { repo, serviceDir } = makeRepo();
    fs.writeFileSync(path.join(serviceDir, "a.txt"), "0123456789");
    fs.writeFileSync(path.join(serviceDir, "b.txt"), "short");

    expect(() =>
      buildEvidencePacket({
        repoRoot: repo,
        services: [service("svc", ["a.txt", "b.txt"])],
        capturedAt: CAPTURED_AT,
        limits: { maxFiles: 1 },
      }),
    ).toThrow(expect.objectContaining({ code: "file_limit" }));

    expect(() =>
      buildEvidencePacket({
        repoRoot: repo,
        services: [service("svc", ["a.txt"])],
        capturedAt: CAPTURED_AT,
        limits: { maxBytesPerFile: 4 },
      }),
    ).toThrow(expect.objectContaining({ code: "byte_limit" }));
  });
});
