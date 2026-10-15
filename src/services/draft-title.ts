/** Frozen at approval from the event policy version and the remediation task count. */
export function draftTitle(policyVersion: string, taskCount: number): string {
  const tasks = taskCount === 1 ? "1 remediation task" : `${taskCount} remediation tasks`;
  return `[LOCAL DRAFT] Retention control ${policyVersion}: ${tasks}`;
}
