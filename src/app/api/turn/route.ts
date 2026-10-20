import { parseTurnRequest, type TurnEvent } from "@/lib/scene";
import { runTurn, stopCharacter } from "@/lib/turn";

export const maxDuration = 300;

/**
 * One scene turn. Every character streams from its own provider call; this merges them into one
 * Server-Sent Events response where each `data:` line is a TurnEvent tagged with its characterId.
 */
export async function POST(request: Request) {
  const parsed = parseTurnRequest(await request.json().catch(() => null));
  if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: TurnEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* client went away */
        }
      };
      await runTurn(parsed, send, request.signal);
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}

/** Stops one character (`?characterId=`) or the whole turn. */
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const turnId = url.searchParams.get("turnId");
  if (!turnId) return Response.json({ error: "turnId is required." }, { status: 400 });
  const stopped = stopCharacter(turnId, url.searchParams.get("characterId") ?? undefined);
  return Response.json({ stopped });
}
