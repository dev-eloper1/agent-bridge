# ADR-001: one daemon, direct ACP SDK, MCP facade

Accepted 2026-10-19, after the local Mod and transport spikes.

Use pinned ACP SDK 2.0.0 stable v1 as the sole transport owner. Reuse its dispatch, wire validation and streaming implementation. Reuse MCP SDK for the Claude facade, YAML + Zod for configuration. A small local daemon owns tasks and provider processes. MCP connects over a private Unix-domain socket and can disconnect without killing work. No hosted services.

acpx offers substantially more than a command wrapper, including named sessions, queues and runtime/flow facilities. Adopting its CLI behind another durable scheduler would create two recovery policies and two state stores. Its documented fallback to new sessions can hide continuity failure. Direct SDK makes permission/elicitation requests and compact events straightforward, while letting us fail closed on failed load. acpx remains a comparison dependency only. Do not write custom ACP framing or import private acpx internals.

Atomic JSON snapshots are sufficient for this single-writer vertical slice. fsync + rename persist tasks, session mappings, and immutable event IDs together; an exclusive process lock prevents concurrent writers. Output is written separately to private append-only artifacts. Large deployments should replace whole-state rewrites with SQLite, without changing the facade.

Each conversation owns one worker process and serializes its turns; separate conversations on the same logical worker run concurrently up to `maxConcurrentTasks`. Worker processes remain alive across turns. Stable bridge agentSessionId and nativeSessionId are distinct from taskId. On daemon restart, in-flight work fails explicitly (never replay side effects), queued work resumes, and existing sessions load only when negotiated. Failed or unsupported load does not silently start a new conversation.

MCP is the portable integration for this milestone. Mod tools/status work locally, but documented agent registration cannot attach an external runtime. Keep the tested Mod as a feasibility spike; no false native-subagent identity and no auto-wake claim. Events are a durable replayable inbox; caller owns its cursor.

Steering means a bounded queued follow-up in the same task/conversation, not guaranteed mid-turn injection. Questions use negotiated ACP form elicitation; permission requests require explicit allow-once/reject choice. No model-generated permission approval. Exploration profiles must explicitly configure provider-side read-only enforcement; ACP itself is not an OS sandbox. Writable agents get persistent isolated Git worktrees. Independent acceptance verification remains the coordinator's job, and is shown as pending in results.


Storage update (2026-10-25): the Store facade now uses a storage port with SQLite as the default and the original atomic JSON adapter available through `AGENT_BRIDGE_STORAGE=json`. SQLite uses WAL, FULL synchronization, one transaction per save, entity JSON rows and append-only sequenced events. Existing JSON snapshots migrate once with a retained backup. The daemon's exclusive writer lock and separate artifact boundary remain unchanged. See [Architecture](ARCHITECTURE.md#identities-and-durable-state) for selection and recovery behavior.
