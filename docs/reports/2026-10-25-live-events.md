In plain words

Watchers can now receive saved task events as they happen through the existing private socket, and reconnect using their last sequence to recover missed events. Waiting callers wake when a watched task changes state, including when it needs input.

## What changed

- Added GET /events?since=<sequence> on the existing Unix socket. The default is zero; invalid, negative and unsafe integer sequences receive HTTP 400. Each newline-delimited JSON record retains its original event fields and global cursor, with a normalized kind.
- Replay includes every event strictly after the cursor, followed by live events through the same cursor path. Notifications happen after successful persistence. Existing history is normalized on delivery without rewriting it.
- Added the typed EventKind vocabulary: task.queued, task.started, task.needs_input, task.completed, task.failed, task.cancelled, verification.result and task.updated. Both input questions and permission requests become needs_input; timed-out tasks become failed. Original type remains available, including verification.passed/failed, so verdicts and existing consumers remain compatible.
- Watchers stop writing when Node reports backpressure. Pending events stay in the existing store rather than a per-watcher queue. A watcher that cannot drain within one second is disconnected; disconnect removes its subscription. Shutdown destroys streams so they cannot hold server shutdown open.
- Replaced wait's 50 ms polling with store notifications and one deadline timer. Task ID and label waits compare watched statuses against their starting snapshot, including label members beyond the ten returned tasks. Existing limits and response fields are retained.
- Socket permissions remain 0600, on the same listener and access boundary. No Mod pane changes, dependencies or lockfile changes.

## How it was tested

Observed final full run, including the TypeScript build:

- GIT_CEILING_DIRECTORIES="$PWD/tmp" TMPDIR="$PWD/tmp" npm test: **234 passing, 0 failing, 0 skipped** (11.45 seconds), with sandbox permission for test-only local listeners.
- git diff --check: no whitespace errors.

Four new tests cover socket replay from a sequence, live delivery, reconnect without gaps or duplicates, invalid sequence rejection, socket permissions, a stalled response being dropped without queued writes, subscription cleanup, wait waking on needs-input and started states, and the normalized vocabulary. Slow-consumer behavior is tested deterministically with a response double that never drains; replay/live/reconnect use an actual test-only Unix socket.

Existing label and plugin tests intentionally assumed wait meant completion. Their completion-dependent scenarios now continue waiting through intermediate wakes, preserving completion and persistence assertions. The bounded-shape test accepts the newly observable running state while retaining its exact field assertion.

The initial sandbox run could not bind test listeners. The first permitted run exposed the old wait assumptions and a new test cleanup-order issue; these were corrected before the successful full run above. No daemon was started outside tests.

## Choices I made

- Used newline-delimited JSON because the endpoint runs over a private local socket and existing events are JSON objects with caller-owned cursors. It avoids an additional SSE framing and ID format.
- Added kind rather than renaming existing type values. This conservatively preserves existing event consumers and append-only history. Auxiliary events use task.updated; the original type explains the update.
- Used Node's response backpressure limit and a one-second drain grace period. Reconnecting callers must retain the last complete parsed record's cursor and ignore any incomplete trailing line.
- Kept replay on the store's existing retained event array, whose contiguous global sequence is already validated. This avoids copying history into each watcher's buffer and works with both storage adapters.

## Risks and what is left

Requested PR 3 behavior is implemented. The Mod pane and external watcher clients still need a later PR to adopt the endpoint. Existing history remains fully retained in memory, as in PR 2; this change does not add pruning or a database paging strategy. A stalled watcher must reconnect, and there is no heartbeat or automatic client reconnect helper. The deterministic slow-consumer test exercises response backpressure rather than relying on platform-specific kernel socket buffer sizes.
