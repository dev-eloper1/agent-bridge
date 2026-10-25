In plain words

Watchers can now receive saved task events as they happen through the existing private socket, and reconnect using their last sequence to recover missed events. Waiting callers receive a result when selected tasks finish or need input, while saved events wake the internal checks without polling.

## What changed

- Added GET /events?since=<sequence> on the existing Unix socket. The default is zero; invalid, negative and unsafe integer sequences receive HTTP 400. Each newline-delimited JSON record retains its original event fields and global cursor, with a normalized kind.
- Replay includes every event strictly after the cursor, followed by live events through the same cursor path. Notifications happen after successful persistence. Existing history is normalized on delivery without rewriting it.
- Added the typed EventKind vocabulary: task.queued, task.started, task.needs_input, task.completed, task.failed, task.cancelled, verification.result and task.updated. Both input questions and permission requests become needs_input; timed-out tasks become failed. Original type remains available, including verification.passed/failed, so verdicts and existing consumers remain compatible.
- Watchers stop writing when Node reports backpressure. Pending events stay in the existing store rather than a per-watcher queue. A watcher that cannot drain within one second is disconnected; disconnect removes its subscription. Shutdown destroys streams so they cannot hold server shutdown open.
- Replaced wait's 50 ms polling with store notifications and a deadline timer. Task ID waits return on finish or needs-input; label waits return when the group has no open tasks or any member needs input, including members beyond the ten returned tasks. Started and other intermediate updates only trigger a recheck. Existing limits and response fields are retained.
- Isolated each listener notification after successful persistence. A throwing watcher cannot roll a saved event out of memory, skip later listeners or cause cursor reuse. Failed persistence still rolls back the newly appended in-memory event. Exposed a read-only listener count for cleanup checks.
- POST /call events now fills in kind for legacy events as well as new events, matching the stream without rewriting stored history.
- Socket permissions remain 0600, on the same listener and access boundary. No Mod pane changes, dependencies or lockfile changes.

## How it was tested

Observed repair-round checks:

- npm run build, then GIT_CEILING_DIRECTORIES="$PWD/tmp" TMPDIR="$PWD/tmp" node --test test/storage.test.mjs test/live-events.test.mjs test/lineage-labels.test.mjs test/reliability.test.mjs: **46 passing, 0 failing, 0 skipped** (8.63 seconds). This preceded the additional six-task group regression test.
- GIT_CEILING_DIRECTORIES="$PWD/tmp" TMPDIR="$PWD/tmp" npm test: **239 passing, 0 failing, 0 skipped** (11.21 seconds), including the TypeScript build. Test-only listeners ran with sandbox permission.
- git diff --check: no whitespace errors.

Tests cover socket replay, live delivery, reconnect without gaps or duplicates, invalid sequences, socket permissions, bounded slow-consumer writes and actual store subscription removal. The needs-input test asserts timedOut is false for both label and task ID waits and proves a started event does not return a wait result. A six-task group test uses one wait call through all intermediate starts and completions, then asserts all six completed without timing out.

For both SQLite and JSON, new tests inject a throwing listener and verify the following listener still runs, memory matches disk, cursors keep increasing and history survives reopening. Failed-save tests inject a persistence failure, assert no notification and unchanged memory/disk history, then retry and reopen with the next sequence preserved. The socket test also reads a legacy record through POST /call events and checks its normalized kind without mutating history. Slow-consumer backpressure uses a deterministic response double; delivery tests use a real test-only socket.

Restored test/lineage-labels.test.mjs, test/plugin.test.mjs and test/reliability.test.mjs exactly to their pre-PR-3 contents. Their original completion assertions and single-call waits are retained. The round-1 retry helpers and weakened bounded-shape assertion were compensating for an incorrect change to wait's documented meaning; that change is now removed.

All listeners and daemons were started only by tests.

## Choices I made

- Used newline-delimited JSON because the endpoint runs over a private local socket and existing events are JSON objects with caller-owned cursors. It avoids an additional SSE framing and ID format.
- Added kind rather than renaming existing type values. This conservatively preserves existing event consumers and append-only history. Auxiliary events use task.updated; the original type explains the update.
- Used Node's response backpressure limit and a one-second drain grace period. Reconnecting callers must retain the last complete parsed record's cursor and ignore any incomplete trailing line.
- Kept the documented finish-or-input wait semantics. Notifications trigger internal rechecks rather than exposing intermediate status changes as finished waits.
- Kept replay on the store's existing retained event array, whose contiguous global sequence is already validated. This avoids copying history into each watcher's buffer and works with both storage adapters.

## Risks and what is left

Requested PR 3 behavior and review repairs are implemented. The Mod pane and external watcher clients still need a later PR to adopt the endpoint. Existing history remains fully retained in memory, as in PR 2; this change does not add pruning or a database paging strategy. A stalled watcher must reconnect, and there is no heartbeat or automatic client reconnect helper. The deterministic slow-consumer test exercises response backpressure rather than relying on platform-specific kernel socket buffer sizes.
