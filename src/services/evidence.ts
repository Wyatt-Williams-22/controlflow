import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  EvidenceArtifactSchema,
  type EvidenceArtifact,
  type ServiceCatalogEntry,
} from "../schemas/event";

/**
 * Reads only allowlisted files under each service fixture root.
 * Evidence ids are EV-<serviceId>-<n> after sorting paths, so they do not
 * change between runs. Line prefixes are `<n>|`. The hash is sha256 of the
 * raw file bytes.
 */

export const EVIDENCE_LIMITS = {
  maxFiles: 20,
  maxBytesPerFile: 32 * 1024,
  maxTotalBytes: 128 * 1024,
};

export class EvidenceAccessError extends Error {
  constructor(
    readonly code: "path_traversal" | "absolute_path" | "outside_root" | "file_limit" | "byte_limit" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "EvidenceAccessError";
  }
}

export type EvidencePacket = {
  artifacts: EvidenceArtifact[];
};

export function buildEvidencePacket(input: {
  repoRoot: string;
  services: readonly ServiceCatalogEntry[];
  capturedAt: string;
  limits?: Partial<typeof EVIDENCE_LIMITS>;
}): EvidencePacket {
  const limits = { ...EVIDENCE_LIMITS, ...input.limits };
  const fileCount = input.services.reduce((count, service) => count + service.allowlistedFiles.length, 0);
  if (fileCount > limits.maxFiles) {
    throw new EvidenceAccessError("file_limit", `allowlist has ${fileCount} files; limit is ${limits.maxFiles}`);
  }

  const repoRoot = realpathOf(input.repoRoot, "repository root");
  const artifacts: EvidenceArtifact[] = [];
  let totalBytes = 0;

  for (const service of input.services) {
    assertSafeRelative(service.fixtureRoot);
    const serviceRoot = resolveInside(repoRoot, service.fixtureRoot);
    const relativePaths = [...service.allowlistedFiles].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    relativePaths.forEach((relativePath, index) => {
      assertSafeRelative(relativePath);
      const filePath = resolveInside(serviceRoot, relativePath);
      const size = fileSize(filePath);
      if (size > limits.maxBytesPerFile) {
        throw new EvidenceAccessError(
          "byte_limit",
          `${relativePath} is ${size} bytes; per-file limit is ${limits.maxBytesPerFile}`,
        );
      }
      totalBytes += size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new EvidenceAccessError("byte_limit", `evidence packet exceeds ${limits.maxTotalBytes} bytes`);
      }
      const bytes = fs.readFileSync(filePath);

      const artifact = EvidenceArtifactSchema.parse({
        evidenceId: `EV-${service.id}-${index + 1}`,
        serviceId: service.id,
        relativePath,
        contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
        numberedContent: toNumberedContent(bytes.toString("utf8")),
        capturedAt: input.capturedAt,
      });
      artifacts.push(artifact);
    });
  }

  return { artifacts };
}

/** Source lines in order. The `<n>|` prefix is removed from the first pipe only. */
export function sourceLines(artifact: EvidenceArtifact): string[] {
  if (artifact.numberedContent.length === 0) return [];
  return artifact.numberedContent.split("\n").map((line) => {
    const separator = line.indexOf("|");
    return separator === -1 ? line : line.slice(separator + 1);
  });
}

function toNumberedContent(text: string): string {
  return splitSourceLines(text).map((line, index) => `${index + 1}|${line}`).join("\n");
}

function splitSourceLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function assertSafeRelative(value: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new EvidenceAccessError("path_traversal", "empty or invalid relative path");
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith("\\")) {
    throw new EvidenceAccessError("absolute_path", "absolute paths are not allowlisted");
  }
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new EvidenceAccessError("path_traversal", "path escapes the fixture root");
  }
}

function realpathOf(target: string, label: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    throw new EvidenceAccessError("not_found", `${label} does not exist`);
  }
}

function resolveInside(root: string, relativePath: string): string {
  const realTarget = realpathOf(path.resolve(root, relativePath), relativePath);
  const relative = path.relative(root, realTarget);
  // realpath follows symlinks. Reject a link that lands outside this root.
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new EvidenceAccessError("outside_root", "resolved path escapes the fixture root");
  }
  return realTarget;
}

function fileSize(filePath: string): number {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new EvidenceAccessError("not_found", "allowlisted path is not a file");
  }
  return stat.size;
}
