# Agent Bridge 0.5.2 checkpoint

Checkpoint prepared 2026-10-20 before specialized-agent implementation. This document captures the current prototype and findings; the subsequent Git commit identifies the exact source revision.

## Delivered behavior

- Claude Code plugin containing delegation/status skills, MCP worker tools and a native Mod interface.
- Automatic local runtime startup, durable task/event/artifact state, bounded results and pagination.
- Seven local harness profiles: Devin, Pi, Codex, Cursor, OpenCode, Copilot and Claude. Reuse native ACP or pinned adapters; one runtime owns execution and sessions.
- Foreground results and explicitly requested background execution; forwarded questions, cancellation and compact originating-session notifications.
- Fresh conversations for unrelated tasks; exact persistent follow-ups, stable semantic conversation names and retained reports per assignment.
- Project-folder default including saved uncommitted files. Existing directories, persistent temporary folders and opt-in Git worktrees.
- Inspector overview/search, worker/task selection, live output, history and separate report paging. Explicit Back, native scroll hints, guarded asynchronous navigation and a quiet composer.
- Workspace identity validation, descriptor-based artifact protections, state validation and regression coverage for previously reproduced failures.

## Validation at check-in

| Check                           | Result               | Scope                                                                                                                         |
| ------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                      | 35 passed, 0 failed  | Builds TypeScript; deterministic runtime, persistence, MCP, permissions, workspace/artifact and process lifecycle integration |
| `npm run test:mod`              | 24 passed, 0 failed  | Actual Claude Mod host, native component trees/handlers and asynchronous UI regressions; no paid model run                    |
| Installed 0.5.2 Mod tests       | 24 passed previously | Delivered user-cache package, recorded in VALIDATION.md                                                                       |
| Live terminal interaction       | Verified previously  | Back, Escape, slash autocomplete and Page Down; original terminal layout restored                                             |
| Seven-provider live integration | Recorded earlier     | Continuity/native recovery for seven; scoped edits/acceptance for six; Pi read-only review                                    |

Provider tests were not rerun for the check-in. Their evidence is historical and version-specific. Test names/counts are not a claim that every environment, auth failure, terminal behavior or provider edge case has been covered. Detailed provenance: [VALIDATION.md](VALIDATION.md), [PROVIDERS.md](PROVIDERS.md).

## Findings and follow-up priority

### 1. Native interface remains the immediate product priority

Actual usage revealed unstable worker identity, inaccessible old reports, weak hierarchy, selector focus traps, mixed navigation/paging and idle controls interfering with autocomplete. Releases through 0.5.2 address these with persistent names/history, overview/detail state, native styling, explicit Back, separate page controls and draft-sensitive activity. Remaining work is real task-based usability verification: picker entry/exit, repeated switching, concurrent active/blocked/finished workers, long reports, close/reopen and narrow terminals. Native arrow keys can navigate controls; Page Up/Page Down are the supported scrolling guidance. Do not claim full native-subagent parity.

### 2. Reviewer output must remain evidence, not authority

Live reviews included false critical findings, stale line references and incorrect claims about synchronous JavaScript races. Some reports contained useful bugs, others mixed verified paths with hypotheses. Independent inspection and reproduction are essential. Future reviewer evals should measure false positives and seeded-bug detection, not number/severity of claims. The specialized-agent brief records concrete fixture candidates.

### 3. Configuration support and readiness need explicit contracts

Executable discovery is not authenticated readiness. Models are discovered, but a universal settings UI, arbitrary system-prompt injection, scoped custom tools/MCP and guided sign-in/retry are not shipped. Existing harness flags/settings do not prove adapter forwarding or restart behavior. Verify effective settings and enforcement per provider; never label instruction-only restrictions as enforced.

### 4. Persistence has distinct layers

Recorded task history, the live worker process, native provider context and the Claude session's UI ownership are separate. Runtime restart preserves records but does not replay interrupted work. Unsupported native restoration fails explicitly. A project-wide cross-Claude-session inspector is not implemented. Template identity/revisions and scoped memory will be separate concerns in the next milestone.

### 5. Hardening questions remain open

These are code-inspection concerns, not newly reproduced exploits or confirmed severities. Preserve them for targeted fixtures rather than copying worker severity labels:

- `src/server.ts` creates the state directory with private mode but does not fully verify ownership/mode/symlink status of a pre-existing directory before placing its lock/socket there. Existing artifact safeguards do not replace daemon-root validation.
- Worker update/question callbacks in `src/runtime.ts` bind agent identity; the neighboring exit path also checks worker identity. Reproduce delayed old-process updates against a reused conversation before deciding the fix.
- Provider question/elicitation payloads need malformed-input tests before relying on their shape in blocked/reply state transitions.
- Explicit worktree creation needs crash-window recovery tests, distinct from normal worktree isolation tests.
- Directory identity verification and child launch cannot make arbitrary filesystem replacement races disappear. State the actual guarantees and test the intended boundary.

No claim here upgrades an untested hypothesis into a demonstrated bug. Existing protections/tests and public output sanitization are also not a general-purpose sandbox or comprehensive security audit.

### 6. Publishing and reproducibility

The repository excludes installed dependencies, generated builds/types, private `.agent-bridge/` state, machine-local Claude approvals, environment files and downloaded upstream checkout material. Recorded fixture smoke reports remain as evidence; their temporary artifact paths are historical references, not portable fixtures. Builds use package-lock.json. Fresh users must install/authenticate their own CLIs and build locally.

A source license has not been selected. Public GitHub visibility alone does not grant an open-source license; choose one deliberately before describing this project as licensed open source. No license was invented during check-in.

## Next work, in order

1. Finish interface/usability verification and prioritize reproduced failures.
2. Validate specialization mechanisms and adapter forwarding across installed harnesses, without broadening existing permissions.
3. Implement the smallest project/global agent-package resolver, effective configuration preview and immutable conversation snapshot.
4. Prove one reviewer on two compatible harnesses, with fresh/follow-up behavior and fixture-based evaluation.
5. Add Claude-led authoring, then assess companion tooling and broader use cases.

The first specialization research is already captured in [SPECIALIZED_AGENTS.md](SPECIALIZED_AGENTS.md). No template runtime, authoring command, evaluation workbench or A2A provider is implemented in this checkpoint.
