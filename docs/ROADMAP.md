# Future features

These items mix shipped foundations with planned directions; each section names which parts are live. The current Claude Code plugin delegates to local coding CLIs through Agent Client Protocol.

## Next major milestone: specialized workers

**Priority:** after worker interface/usability stabilization. **Status:** first slice shipped. Declarative specializations are live: client-owned `.specialists` catalogs at `<project>/.specialists/<namespace>/<id>/specialist.yaml`, `~/.specialists/` or configured `specialistCatalogs:` roots supply instructions, delivery mode, provider/read-only restrictions and acceptance criteria; `specialists_catalog` discovery, `specialistRef`/`specialistSpec` delegation, `specialists_schema`/`specialists_validate` authoring support, the `specialize` skill and per-conversation pinned snapshots are implemented. Still future: evals, native tool/MCP bindings, model/memory settings and any remote or hosted catalog.

Continue toward versioned specialists with skills/context, native tool/MCP bindings, model settings, workspace/permission policy, scoped memory, deliverable contracts and evals. Saved definitions under `.agent-bridge/agents/` and `~/.agent-bridge/agents/` remain the compatibility layer. Specialist files are managed by Claude's ordinary file/Git tools through the `specialize` skill; a companion UI could reuse the same file contract later.

Reuse native harness facilities and the current persistent task/session machinery. Distinguish template, configured worker, conversation and task. Pin the effective template revision per conversation; show enforced versus instructed versus unsupported capabilities. Never silently weaken a required restriction for portability. Validate provider bindings and grade actual task outcomes before claiming support.

The [specialized agents research brief](SPECIALIZED_AGENTS.md) defines the full package, primary-source findings, storage/versioning proposal, evaluation cases based on our observed review failures, use cases and staged acceptance gates. First delivery should prove one reviewer package on two compatible harnesses, not build a new general agent framework.

## Optional A2A agent-service providers

**Status:** future feature; no A2A client/server is implemented or tested in Agent Bridge.

**Use case:** delegate from the same Claude Code skill to an independently hosted agent that exposes an A2A endpoint, alongside the existing Pi, Devin, Copilot and other CLI workers.

Keep the existing Claude-facing skill, MCP tools, compact results and task supervision. Add an A2A provider connection using an established official SDK rather than building a new agent framework. Retain Agent Client Protocol for coding CLIs that expose it.

Proposed flow:

```text
Claude Code skill → existing MCP tools → Agent Bridge runtime
                                        ├─ Agent Client Protocol → local CLI workers (shipped)
                                        └─ A2A client → agent services (future)
```

Before implementation, validate the target service and current A2A SDK. Map Agent Cards/capabilities, authentication, task/context identifiers, streaming updates, artifacts, input-required states and cancellation into the bridge's existing model. Keep remote identifiers durable and negotiate supported capabilities. Remote context IDs do not automatically prove restart recovery; remote services also do not automatically share local worktrees or permissions.

Acceptance gates:

- Delegate through `/agent-bridge:delegate` to one real A2A service without changing the normal Claude workflow.
- Verify multi-turn context and distinguish reconnecting to a task from recovering a conversation or replaying work.
- Test streamed output/artifacts, errors, cancellation and input-required behavior where advertised.
- Verify explicit endpoint authentication, bounded artifact retrieval and relevant approval boundaries; never translate generic remote input into implicit local tool approval.
- Pass the existing ACP/provider tests unchanged so local CLI delegation keeps working.

Exposing Agent Bridge itself as an A2A server is a separate possible follow-up, outside this initial client-provider feature.

## Why this does not require replacing ACP

**Agent Client Protocol**, used by this project, connects clients to coding agents. **Agent Communication Protocol**, developed by IBM/BeeAI, is the different ACP that merged into A2A. The merger is not a deprecation of Agent Client Protocol or wire compatibility between it and A2A.

Sources: [Agent Client Protocol introduction](https://agentclientprotocol.com/get-started/introduction), [official IBM/BeeAI ACP merger announcement](https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/), [A2A overview](https://a2a-protocol.org/latest/topics/what-is-a2a/).

## Provider settings and actionable recovery

**Settings UI shipped.** `/workers settings` exposes provider-advertised ACP session config options (selects, grouped choices, booleans and legacy modes) as native controls validated against each provider's catalog, persisted as private per-workspace preferences with a one-time managed-defaults migration for advanced/legacy bases. Global harness settings are never changed; permission-affecting modes stay a deliberate choice. Still future: session-scoped model selection beyond what providers advertise as config options, and reporting effective settings across supported native reloads.

Distinguish executable availability from authenticated readiness. Add actionable authentication, entitlement/quota, network, configuration and provider-exit diagnostics where reliable evidence exists. Show a sign-in remedy and explicit retry action; do not replay side-effecting prompts automatically. Support advertised ACP authentication only through a verified user-driven flow. Acceptance requires deterministic unsupported/invalid-setting and auth-error tests plus live checks for each claimed provider capability. Current boundaries: [Worker settings](WORKER_SETTINGS.md).
