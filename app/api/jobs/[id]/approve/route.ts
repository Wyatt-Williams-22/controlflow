import { z } from "zod";

import { approveAssessment } from "@/src/services/tickets";
import { getDatabase } from "@/src/storage/db";

const RequestSchema = z
  .object({
    approve: z.boolean(),
    assessmentVersion: z.number().int().positive(),
  })
  .strict();

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Approval requires approve: true and an assessment version." }, { status: 400 });
  }
  const result = approveAssessment(getDatabase(), id, parsed.data);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ticket: result.ticket });
}
