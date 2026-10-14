import type { ControlEvent, ServiceCatalogEntry } from "../schemas/event";

/**
 * A service is in scope when one of its data classes or tags appears on a
 * requirement. Catalog order is preserved, so the same inputs always produce
 * the same candidate list. This does not read files.
 */
export function selectCandidateServices(
  event: ControlEvent,
  catalog: readonly ServiceCatalogEntry[],
): ServiceCatalogEntry[] {
  const required = new Set(event.requirements.flatMap((requirement) => requirement.dataClasses));
  return catalog.filter(
    (service) =>
      service.dataClasses.some((dataClass) => required.has(dataClass)) ||
      service.tags.some((tag) => required.has(tag)),
  );
}
