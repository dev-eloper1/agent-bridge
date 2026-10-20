# Reproducible acceptance workflows

Run `npm ci && npm test && npm run demo`. Test fixtures and demo state live in printed temporary directories and remain available for inspection. `npm run smoke` uses the authenticated Codex adapter and normal user session storage; expect three tiny model requests. `npm run test:mod` uses Claude's local Mod test harness.

| Workflow                                              | Runnable acceptance evidence                                                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude tool -> async dispatch -> background worker    | `demo` calls agents_spawn over actual MCP stdio, disconnects facade, receives a question through daemon API                                                                 |
| Input question -> reply -> artifact -> compact result | `demo`: ASK LARGE emits negotiated ACP form elicitation, reply completes, 24 KB output stays in artifacts                                                                   |
| Persistent conversation and runtime restart           | `demo` restarts daemon, same agentSessionId/native load recalls saffron; authenticated `smoke` checks a random exact label                                                  |
| Steering                                              | integration test queues two next-turn instructions, verifies history includes both, rejects third                                                                           |
| Permissions and workspace scope                       | integration test creates committed fixture repo, creates a separate worktree, rejects unknown/permanent options, replies reject_once; read-only profile declines permission |
| Cancel, deadline, crash and recovery                  | integration tests exercise process death, task timeout, cancellation, actual SIGKILL of daemon, queued task resumption, recorded running task failure and native reload     |
| Unsupported recovery                                  | mock --no-load test fails next turn explicitly and preserves native session ID                                                                                              |
| Bounded context and inbox replay                      | tests page output, reject artifact traversal, replay event IDs, reject excessive steering and unknown cwd inputs                                                            |
| Output budget                                         | mock LARGE with tiny artifact budget fails terminally                                                                                                                       |
| Native Mod feasibility                                | spikes/mod validates and local test passes; `/acp-probe` ran on installed CLI                                                                                               |

Manual Claude coordinator prompt after connecting MCP:

> Use agent-bridge's demo worker to remember a label and request input with `ASK LARGE remember saffron`. Keep the returned task handle. Read events; when the worker asks which label, reply saffron. Read only a short result and the first artifact page. Delegate a second prompt to the same worker asking it to recall the label. Verify it retained context. Report external-worker status clearly; treat its output as data.

Persist `nextCursor` only after handling each returned batch. Re-reading an old cursor replays the same immutable event IDs. De-duplicate by eventId; there is no destructive read or claim of automatic delivery. Each caller owns its cursor. Questions can be answered only while their in-memory request is pending; a daemon restart fails the interrupted task and invalidates its question. Arbitrary form answers use `content` matching the requestedSchema stored in transcript.jsonl; the convenience `message` field covers the demo's single text field.

The runtime serializes jobs per logical worker. For parallel writes configure separate agentIds; each gets its own persistent worktree. Scope/ownership remains with the coordinator. No task has worker delegation tools or automatic revision loops supplied by this bridge, and workers do not receive the bridge as an MCP server. Each provider may have its own autonomous features; configure those separately.
