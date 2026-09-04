"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Subscribes to the SSE ping and re-runs the server component.
 *
 * The ping carries no data: the refetch is cheap because the index is already
 * warm, and there is nothing to merge on the client.
 */
export function LiveRefresh() {
  const router = useRouter();
  const [live, setLive] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/events");

    source.addEventListener("ready", () => setLive(true));
    source.addEventListener("change", () => router.refresh());
    source.addEventListener("error", () => setLive(false));

    return () => source.close();
  }, [router]);

  return (
    <span className="live" title={live ? "Updating as sessions write" : "Reconnecting"}>
      <span className={`dot ${live ? "working" : "unknown"}`} />
      {live ? "live" : "offline"}
    </span>
  );
}
