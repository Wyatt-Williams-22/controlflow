import type { Assessment, EvidenceCitation, Finding } from "../schemas/assessment";
import type { EvidenceArtifact } from "../schemas/event";
import { sourceLines } from "./evidence";

/**
 * Checks citations against the packet. Excerpts are copied from the numbered
 * source lines here. The model text is not used as the excerpt.
 */

export type VerificationError = {
  code: "unknown_evidence" | "invalid_line_range" | "service_mismatch";
  findingId: string;
  evidenceId: string;
  message: string;
};

export type VerifiedCitation = EvidenceCitation & {
  excerpt: string;
  relativePath: string;
  serviceId: string;
};

export type VerifiedFinding = Omit<Finding, "evidence"> & {
  evidence: VerifiedCitation[];
};

export type VerifyResult =
  | { ok: true; findings: VerifiedFinding[] }
  | { ok: false; errors: VerificationError[] };

export function verifyFindings(
  assessment: Assessment,
  artifacts: readonly EvidenceArtifact[],
): VerifyResult {
  const byId = new Map(artifacts.map((artifact) => [artifact.evidenceId, artifact]));
  const errors: VerificationError[] = [];
  const findings: VerifiedFinding[] = [];

  for (const finding of assessment.findings) {
    const citations: VerifiedCitation[] = [];
    for (const citation of finding.evidence) {
      const artifact = byId.get(citation.evidenceId);
      if (!artifact) {
        errors.push({
          code: "unknown_evidence",
          findingId: finding.id,
          evidenceId: citation.evidenceId,
          message: `evidence id ${citation.evidenceId} is not in the packet`,
        });
        continue;
      }
      if (artifact.serviceId !== finding.serviceId) {
        errors.push({
          code: "service_mismatch",
          findingId: finding.id,
          evidenceId: citation.evidenceId,
          message: `finding service ${finding.serviceId} does not match evidence service ${artifact.serviceId}`,
        });
        continue;
      }
      const lines = sourceLines(artifact);
      if (!isValidRange(citation.startLine, citation.endLine, lines.length)) {
        errors.push({
          code: "invalid_line_range",
          findingId: finding.id,
          evidenceId: citation.evidenceId,
          message: `line range ${citation.startLine}-${citation.endLine} is outside 1-${lines.length}`,
        });
        continue;
      }
      citations.push({
        ...citation,
        excerpt: lines.slice(citation.startLine - 1, citation.endLine).join("\n"),
        relativePath: artifact.relativePath,
        serviceId: artifact.serviceId,
      });
    }
    findings.push({ ...finding, evidence: citations });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, findings };
}

function isValidRange(startLine: number, endLine: number, lineCount: number): boolean {
  return Number.isInteger(startLine) && Number.isInteger(endLine) && startLine >= 1 && startLine <= endLine && endLine <= lineCount;
}
