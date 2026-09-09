import type { EventKind, TranscriptEvent } from "@/lib/detail";

const KIND_LABEL: Record<EventKind, string> = {
  user: "You",
  reasoning: "Reasoning",
  assistant: "Assistant",
  tool_call: "Tool call",
  tool_result: "Tool result",
};

function clock(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** One-line preview of a tool's arguments, favoring the fields people scan for. */
function argSummary(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "description"]) {
    const v = input[key];
    if (typeof v === "string" && v) return v;
  }
  const json = JSON.stringify(input);
  return json === "{}" ? "" : json;
}

function EventBody({ event }: { event: TranscriptEvent }) {
  if (event.kind === "tool_call") {
    const summary = argSummary(event.toolInput);
    return (
      <>
        <div className="ev-tool">
          <span className="ev-tool-name mono">{event.toolName}</span>
          {summary && <span className="ev-tool-arg mono">{summary}</span>}
        </div>
        {event.toolInput && Object.keys(event.toolInput).length > 0 && (
          <details className="ev-raw">
            <summary>arguments</summary>
            <pre className="mono">{JSON.stringify(event.toolInput, null, 2)}</pre>
          </details>
        )}
      </>
    );
  }

  if (event.kind === "tool_result") {
    const text = event.text ?? "";
    return (
      <pre className={`ev-pre mono${event.isError ? " err" : ""}`}>
        {text.length > 4000 ? `${text.slice(0, 4000)}\n… (${text.length - 4000} more chars)` : text || "(empty)"}
      </pre>
    );
  }

  // user / reasoning / assistant are prose.
  return <div className="ev-text">{event.text}</div>;
}

export function Transcript({ events }: { events: TranscriptEvent[] }) {
  if (events.length === 0) {
    return <div className="panel empty">No transcript events.</div>;
  }

  return (
    <div className="transcript">
      {events.map((event) => (
        <div key={event.index} className={`ev ev-${event.kind}${event.isError ? " ev-error" : ""}`}>
          <div className="ev-gutter">
            <span className="ev-kind">{KIND_LABEL[event.kind]}</span>
            <span className="ev-meta sub mono">
              {event.model && <span>{event.model}</span>}
              {clock(event.timestamp) && <span>{clock(event.timestamp)}</span>}
              <span>#{event.index + 1}</span>
            </span>
          </div>
          <div className="ev-content">
            <EventBody event={event} />
          </div>
        </div>
      ))}
    </div>
  );
}
