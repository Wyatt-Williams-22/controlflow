import { randomUUID } from "node:crypto";

import { ControlEventSchema } from "@/src/schemas/event";
import { createJob, getDatabase } from "@/src/storage/db";
import { z } from "zod";

const RequestSchema = z
  .object({
    event: ControlEventSchema,
    mode: z.enum(["live", "replay"]).default("live"),
    analysisDepth: z.enum(["standard", "deep"]).default("standard"),
  })
  .strict();

const MAX_BODY_CHARS = 200_000;

export async function POST(request: Request): Promise<Response> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  if (text.length > MAX_BODY_CHARS) {
    return Response.json({ error: "Request body is too large." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).filter(Boolean).slice(0, 8);
    return Response.json({ error: "Event did not match the schema.", fields }, { status: 400 });
  }
  const job = createJob(getDatabase(), {
    id: randomUUID(),
    event: parsed.data.event,
    mode: parsed.data.mode,
    analysisDepth: parsed.data.analysisDepth,
  });
  return Response.json(
    { id: job.id, state: job.state, mode: job.mode, analysisDepth: job.analysisDepth },
    { status: 201 },
  );
}
