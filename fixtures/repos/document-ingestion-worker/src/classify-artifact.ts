/**
 * Compliant example. Extracted artifacts record an owner and a retention
 * classification id. The duration for that id lives only in the policy config.
 */

export const ARTIFACT_OWNER = "document-platform";
export const RETENTION_CLASSIFICATION_ID = "derived-underwriting-summary";

export type ExtractedArtifact = {
  documentId: string;
  owner: string;
  retentionClassificationId: string;
};

export function classifyExtractedArtifact(documentId: string): ExtractedArtifact {
  return {
    documentId,
    owner: ARTIFACT_OWNER,
    retentionClassificationId: RETENTION_CLASSIFICATION_ID,
  };
}
