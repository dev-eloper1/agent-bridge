# Codex Kickoff Prompt — Universal Persistent ACP Subagents for Claude Code

You are the principal engineer beginning a **local-first, multi-provider agent interoperability** project. Read `RESEARCH_SEED.md` in full before doing anything else. Treat it as product/architecture context, not as ground truth about any third-party API. Verify version-sensitive details from installed tools, source code and current official documentation.

## Mission

Build a working prototype where **Claude Code remains the primary UI and coordinator** and can manage external coding CLI agents such as Devin, Codex and Cursor as **persistent, asynchronous, native-feeling subagents**. The workers must preserve their own sessions/context, accept follow-up instructions, stream compact progress, ask questions, and report completion without dumping enormous responses into Claude's context. Prefer ACP as the provider-neutral communication protocol.

Cloud development/Devin Cloud is out of scope. The agents run as local CLI processes and use their existing authentication/model quotas. Our runtime should be a small local process, not a new large orchestration framework.

## First actions: inspect, validate and make a decision

1. Inspect the current working directory/repo. If empty, initialize a tidy TypeScript/Node project. Do not overwrite existing files without examining them.
2. Read `RESEARCH_SEED.md`, extract requirements, critical assumptions and questions.
3. Inspect local installed versions for Claude Code, Devin CLI, Codex, Cursor CLI, Node and package manager. Don't print credentials or secrets. If an agent is absent, don't block the whole project.
4. Verify Claude Code Mods API with current official docs and local runtime. Specifically investigate whether Mods can make **arbitrary ACP agents actual native subagents** or only give us a custom tool/UI. Run a minimal spike. Don't mislabel one as the other.
5. Examine the current source/docs and licenses of `openclaw/acpx`, `Duro02/devin-subagents`, `kevinArgueta96/open-agent-bridge`, plus optional `open-multi-agent` and Cursor/Devin ACP docs. Avoid dependency sprawl. Decide whether acpx or direct ACP SDK makes the better *single owner* of ACP session transport and stream/event handling.
6. Write `docs/VALIDATION.md` (findings with source URLs/versions) and `docs/ADR-001-runtime.md` (tradeoffs + chosen path). Then implement, don't stop at a proposal.

## MVP delivery

- A configurable provider registry in `agents.yaml` (Devin, Codex adapter, Cursor plus arbitrary custom ACP command) with schema validation, available-model discovery where possible, and capability negotiation.
- A local durable runtime (TypeScript + SQLite or simple persistent store) with separate `agentSessionId` and `taskId`, managed agent processes, event inbox, artifact store, and bounded result summaries.
- A Claude-facing integration using a **Mod if practical**, with `list`, `spawn`, `status`, `steer`, `reply`, `events`, `result`, `artifact`, and `cancel`. If Mod integration cannot support an essential capability, provide an MCP tool facade for the same runtime API; optionally layer a Mod for a status pane.
- Real async `spawn`: returns a task ID immediately; doesn't keep Claude's tool invocation blocked. Runtime continues even when Claude's chat turn finishes.
- A persistent agent session: send two sequential prompts to the same worker and demonstrate context continuity. Make restart/recovery claims only after testing the backend's ACP capabilities.
- Worker-to-coordinator questions/events and compact notifications where supported. Use documented Claude session-messaging APIs, not invented socket payloads. If autonomous wake-up fails, implement a durable inbox fallback and clearly describe the limitation.
- Full logs/transcripts/diffs stored in files, concise summaries and artifact references returned to Claude; limit inline output and allow paging.
- Workspace safety: read-only for exploration, isolated git worktree for concurrent writes, deliberate permission handling, explicit cancellation and bounded retries.
- Unit/integration tests using a deterministic mock ACP worker, plus at least one real provider smoke test if installed and authenticated.

## Explicit engineering rules

- Keep this small. Do not build a general multi-agent civilization, DAG engine, semantic routing model, or custom LLM inference provider.
- Distinguish **agent conversation**, **task lifecycle**, **message/event**, and **artifact** in schemas.
- Make events at-least-once or explicitly document different semantics; deduplicate by event/message ID. Never falsely mark unread updates as delivered.
- Avoid uncontrolled agent-to-agent chatter, infinite review loops, duplicate file edits, uncontrolled subprocess trees and scope creep.
- Don't autoapprove dangerous actions by default. No hard-coded API keys, no secret logging, no arbitrary shell string execution from YAML.
- Do not claim ACP offers universal model switching, persistent sessions or asynchronous agent-to-agent messages: detect optional capabilities.
- Pin third-party versions and isolate adapters. Avoid installing all overlapping open-source frameworks together.
- Every proposed workflow should have a runnable CLI/manual demonstration and an acceptance test.

## Working style

Operate autonomously within this repo: research the actual APIs, write a concise architecture, implement the smallest end-to-end path, run tests, then iterate. Use a visible task checklist in `docs/PLAN.md`; update it as work completes. If internet or authentication prevents a real provider test, use a local deterministic mock and document precisely what remains unverified. Don't ask me for decisions that can be settled through a small experiment. Don't substitute extensive docs for a runnable POC.

## Definition of done for first milestone

A command can start the runtime; a Claude-facing tool can spawn a worker; the tool immediately returns a task handle; a live or mock ACP agent runs in the background, emits events, asks a question if needed, accepts a reply, completes, and stores its large output as an artifact. Claude can query a small summary. The project restarts without losing recorded task/event history. At least two provider configurations parse, and we know exactly which ACP session-recovery claims passed a real test.

Start now: inspect the workspace and seed, validate critical upstream assumptions, make the smallest architecture decision, and implement the first vertical slice.
