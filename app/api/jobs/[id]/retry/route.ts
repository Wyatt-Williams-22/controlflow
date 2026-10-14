import { getDatabase, retryJob } from "@/src/storage/db";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  const result = retryJob(getDatabase(), id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ id: result.job.id, attempt: result.job.attempt, state: result.job.state });
}
