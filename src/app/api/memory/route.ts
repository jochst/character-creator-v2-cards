import { summarizeCharacter, type MemoryUpdate } from "@/lib/memory";
import { parseTurnRequest } from "@/lib/scene";

export const maxDuration = 120;

/**
 * Updates the private memory of every character whose summary is due, each on its own model, all in parallel.
 * Takes the same body as /api/turn (turnId is ignored) and returns `{ updates }`; characters not yet due are left out.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = parseTurnRequest(body && { order: "parallel", ...body, turnId: "memory" });
  if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
  const results = await Promise.all(parsed.characters.map((c) => summarizeCharacter(c, parsed.characters, parsed.log, parsed.defaults, { signal: request.signal })));
  const updates = results.filter((u): u is MemoryUpdate => Boolean(u));
  return Response.json({ updates });
}
