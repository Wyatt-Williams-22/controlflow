import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ControlEventSchema,
  PolicyConfigSchema,
  ServiceCatalogSchema,
  type ControlEvent,
  type PolicyConfig,
  type ServiceCatalog,
} from "../src/schemas/event";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

export function loadEvent(): ControlEvent {
  return ControlEventSchema.parse(readJson("fixtures/control-events/retention-change.json"));
}

export function loadCatalog(): ServiceCatalog {
  return ServiceCatalogSchema.parse(readJson("fixtures/service-catalog.json"));
}

export function loadPolicy(): PolicyConfig {
  return PolicyConfigSchema.parse(readJson("fixtures/policy-config.json"));
}
