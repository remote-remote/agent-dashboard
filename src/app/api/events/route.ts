import { getWatcher } from "@/lib/watcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The app's only route handler.
 *
 * Pings are content-free: the client just calls `router.refresh()` and the
 * server component re-runs against the already-warm index. No delta payloads
 * and no client-side merge, which is where this class of bug lives.
 */
export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (event: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: 1\n\n`));
        } catch {
          closed = true;
        }
      };

      send("ready");

      const unsubscribe = getWatcher().subscribe(() => send("change"));

      // Keeps proxies and idle connections from dropping the stream.
      const keepAlive = setInterval(() => send("ping"), 30_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed by the client going away
        }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
