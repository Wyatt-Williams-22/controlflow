import { getDatabase, readJobView } from "@/src/storage/db";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  const view = readJobView(getDatabase(), id);
  if (!view) return Response.json({ error: "Job not found." }, { status: 404 });
  return Response.json(view);
}
