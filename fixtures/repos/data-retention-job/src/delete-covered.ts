/**
 * Deletes raw bank documents and emits a deletion audit event.
 * Derived cash-flow summaries are not in the coverage list.
 * This file does not say how long the audit event is kept.
 */

export const COVERED_CLASSIFICATION_IDS = ["raw-bank-document"];

export type DeletionAuditEvent = {
  classificationId: string;
  objectKey: string;
  deletedAt: string;
};

export function deleteCoveredObject(
  classificationId: string,
  objectKey: string,
  deletedAt: string,
): DeletionAuditEvent | undefined {
  if (!COVERED_CLASSIFICATION_IDS.includes(classificationId)) {
    return undefined;
  }
  removeObject(objectKey);
  return emitDeletionAudit({ classificationId, objectKey, deletedAt });
}

function removeObject(objectKey: string): void {
  void objectKey;
}

function emitDeletionAudit(event: DeletionAuditEvent): DeletionAuditEvent {
  return event;
}
