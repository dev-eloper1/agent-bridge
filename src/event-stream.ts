import type { ServerResponse } from "node:http";
import { eventKind, type Store } from "./store.js";

// Replay and live delivery share a cursor; pending events stay in the store,
// never in a per-watcher queue. A stalled socket gets one second to drain.
export function streamEvents(store: Store, res: ServerResponse, since: number) {
  let cursor = since;
  let blocked = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const cleanup = () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    res.off("drain", drain);
  };
  const pump = () => {
    if (stopped || blocked) return;
    try {
      while (cursor < store.state.events.length) {
        const event = store.state.events[cursor];
        cursor = event.cursor;
        if (!res.write(JSON.stringify({ ...event, kind: eventKind(event.type) }) + "\n")) {
          blocked = true;
          timer = setTimeout(() => res.destroy(), 1000);
          return;
        }
      }
    } catch {
      res.destroy();
    }
  };
  const drain = () => {
    clearTimeout(timer);
    blocked = false;
    pump();
  };
  const unsubscribe = store.subscribe(pump);
  res.on("drain", drain);
  res.once("close", cleanup);
  res.once("error", cleanup);
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-store",
  });
  res.flushHeaders();
  pump();
}
