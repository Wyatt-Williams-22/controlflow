import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { completeStructured } from "../src/integrations/grok";

/**
 * One real Chat Completions call when XAI_API_KEY is set.
 * Exits with a clear message when the key is missing. Does not print the key.
 */

const SmokeSchema = z
  .object({
    ok: z.literal(true),
    echo: z.string().max(32),
  })
  .strict();

const smokeJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { const: true },
    echo: { type: "string", maxLength: 32 },
  },
  required: ["ok", "echo"],
};

function loadEnvFile(filename: string): void {
  const fullPath = path.join(process.cwd(), filename);
  if (!fs.existsSync(fullPath)) return;
  const text = fs.readFileSync(fullPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function safeUnexpectedMessage(error: unknown): string {
  if (!(error instanceof Error)) return "unexpected smoke failure";
  return error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);
}

async function main(): Promise<void> {
  loadEnvFile(".env");
  loadEnvFile(".env.local");

  if (!process.env.XAI_API_KEY?.trim()) {
    console.error(
      "XAI_API_KEY is not set. Copy .env.example to .env.local, set the key, and run npm run smoke again.",
    );
    process.exit(1);
  }

  const result = await completeStructured({
    schemaName: "smoke_pong",
    jsonSchema: smokeJsonSchema,
    outputSchema: SmokeSchema,
    system: "Reply with the requested JSON object only.",
    user: "Set echo to the exact word pong.",
    maxTokens: 128,
  });

  if (!result.ok) {
    console.error(`smoke failed category=${result.category} status=${result.status ?? "none"}`);
    console.error(result.message);
    process.exit(1);
  }

  console.log(`smoke ok model=${result.model} echo=${result.data.echo}`);
}

main().catch((error: unknown) => {
  console.error(`smoke failed category=network`);
  console.error(safeUnexpectedMessage(error));
  process.exit(1);
});
