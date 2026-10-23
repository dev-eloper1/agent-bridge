# Specialized agents: research and next milestone

Research checkpoint: 2026-10-19. Status: first slice shipped. Declarative specializations are implemented — client-owned specialists at `.specialists/<namespace>/<id>/specialist.yaml`, `~/.specialists/` and configured `specialistCatalogs:` roots, discovered through `specialists_catalog` and delegated with `specialistRef` or an inline `specialistSpec`; specializations today carry identity, description, instructions, delivery mode, provider/read-only compatibility restrictions and acceptance criteria, conversations pin the resolved snapshot, and the `specialize` skill covers natural-language create/adapt/save/update/delete/promote through the client's own file and Git tools. Everything below remains the proposed next milestones: evaluations, native tool/MCP bindings, model/memory settings and remote/hosted catalogs are **not implemented**.

## Product intent

Create reusable specialists from Claude Code through Agent Bridge, save them for a project or globally, and invoke them as named workers. A companion authoring tool could edit and evaluate the same packages later. Keep one runtime, one definition resolver and the existing task/session/UI machinery.

Current interactions: naming a persisted specialist naturally ("Use Hivemind's triage investigator on this case") discovers and runs it through `specialists_catalog`/`specialistRef`, a "for this task" specialist runs an inline `specialistSpec`, and follow-ups keep the pinned snapshot. Example future interactions, not current commands:

- “Create a security reviewer that reports only reproducible findings, cannot edit files, and saves this definition for this project.”
- “Use my migration specialist on this change, running through Devin.”
- “Compare this agent revision with its previous version on our eval cases.”
- “Explain what instructions, tools, model and memory this worker actually received.”

A template is a versioned definition, not a live worker. A configured worker binds it to a harness and effective settings. A conversation is one persistent instance; a task is one assignment inside it. Several conversations can use the same template without sharing memory or context. Reusing a conversation must not silently adopt a changed template.

## What the complete package includes

| Area                           | Questions and proposed contents                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and discovery         | Stable ID, name, purpose, when to use/avoid, examples, owner, version, provenance and concise routing description. Names should communicate specialty, with harness and conversation identity shown separately.                                                           |
| Behavior and context           | System prompt intent, append versus replace behavior, instructions, procedures/skills, reference documents, examples, task input schema, required context and project-rule inheritance. Record instruction precedence and provenance.                                     |
| Harness and model              | Supported harness bindings, required capabilities, model/reasoning preferences, provider-specific settings and explicit fallback policy. Distinguish advertised model choices from entitlement and effective settings.                                                    |
| Tools and execution authority  | Existing tool selection, custom tool names/descriptions/input/output schemas, implementation references, MCP connections, permission requirements and filesystem/network scope. A tool definition needs an execution implementation; its description alone supplies none. |
| Workspace and resources        | Default project folder, optional existing/temp directory or explicit worktree, allowed roots, setup/dependencies, environment references and cleanup ownership. Keep normal project-folder behavior; specialization does not make worktrees mandatory.                    |
| State and memory               | Session reuse/reset/fork policy, durable domain knowledge separate from conversation transcripts, memory scope, write ownership, retention, export/delete behavior and handling of stale facts. Disable cross-project memory unless deliberately configured.              |
| Lifecycle and collaboration    | Initialization/preflight, hooks, completion checks, cancellation, permission questions, auth/config failures, retries and bounded handoffs. Explicit nesting limits; no self-spawning or automatic retry loops by default.                                                |
| Deliverables and observability | Output schema, artifacts, evidence/citations, structured findings, change/test summaries, progress, effective-configuration display and observed usage. Preserve distinction between model completion and verified success.                                               |
| Evaluation and maintenance     | Representative tasks, fixtures, expected outcomes, deterministic checks, calibrated rubrics, repeated trials, baselines, regression cases, model/harness/version attribution, compatibility checks and revision history.                                                  |

Not every package needs every optional feature. A first reviewer should be small, inspectable and testable; the schema should not force ceremony on simple agents.

## Initial evidence and reuse opportunities

These are upstream-documentation findings unless marked local. Online documentation can be newer than installed binaries; the corresponding launch paths still need local adapter tests.

| Source                                                                                                        | Finding                                                                                                                                                                                       | Implication for Agent Bridge                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)                                           | Native definitions cover prompts, tools, models, skills, memory, hooks and scoped files. Plugin definitions have restrictions: inline MCP, hooks and permissionMode fields are ignored there. | Reuse native definitions where compatible. Import/export needs a compatibility report, not a claim of lossless conversion or external-worker registration in Claude's native Agent runtime.                                                     |
| [OpenCode agents](https://opencode.ai/docs/agents/)                                                           | Agent configuration includes prompts, model settings, step limits and permissions, with project/global definitions.                                                                           | Test a native agent binding rather than inventing another execution loop. Native tool/permission names require translation or provider-specific configuration.                                                                                  |
| [Pi upstream](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)                           | Pi exposes extension, skill, prompt-template and package mechanisms.                                                                                                                          | Reuse these facilities for behavior and custom tools. Pin resources and verify what the ACP adapter actually loads.                                                                                                                             |
| Installed `pi --help` (local inspection)                                                                      | Advertises system/append prompt, tool selection/exclusion, skills, extensions, thinking/model and context-discovery controls.                                                                 | Good candidate for a first specialist launch path. Help is flag discovery, not proof of per-session behavior or adapter forwarding. The command emitted a sandbox settings-lock warning; no settings change or authenticated run was validated. |
| [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)                                | Session creation/load can supply MCP servers; capabilities govern optional behavior.                                                                                                          | Reuse standard tool connectivity where supported. Supplying MCP servers does not remove a harness's built-in tools or prove isolation.                                                                                                          |
| [ACP configuration options](https://agentclientprotocol.com/protocol/v1/session-config-options)               | Agents may advertise session selectors, including model/reasoning/mode settings.                                                                                                              | Discover and validate values instead of assuming a common model/settings API. This does not establish a portable arbitrary system-prompt API.                                                                                                   |
| [Anthropic agent-evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Evaluations can check outcomes and traces, use multiple grader types and repeated trials, and track regressions.                                                                              | Grade actual artifacts and actions; do not accept “tests passed” solely because the worker says so. Reuse existing test runners before adopting an evaluation service/framework.                                                                |

Local bridge state: `src/specialists.ts` resolves declarative specializations from project/global/configured `.specialists` catalogs and `src/templates.ts` retains the legacy project/global saved definitions; instructions, delivery mode, provider/read-only restrictions and acceptance criteria reach the worker today. `src/acp.ts` still supplies empty MCP lists for new/load requests. Full editable session configuration, custom prompt installation beyond the shipped delivery modes, tool injection, package memory and evaluation tooling are not implemented. The shipped Pi wrapper deliberately disables extensions/MCP and limits tools; customization must not quietly remove its read-only guarantee.

The remaining harnesses—Devin, Cursor, Codex and Copilot—need a dedicated native-configuration and adapter-forwarding matrix. Prior delegation/recovery smoke tests do not prove specialization support. Do not fill these cells from assumptions about ordinary CLI flags.

## Architecture proposal

```text
Claude authoring/delegation skill       Optional companion editor/CLI
                 \                       /
                  Shared definition resolver and validator
                                  |
                      Capability/binding preflight
                                  |
                  Effective immutable agent snapshot
                                  |
                    Existing Agent Bridge runtime
                                  |
                     Native harness configuration
                                  |
                  Persistent conversation -> task/artifacts
```

Keep a small common contract plus explicit harness extensions. Prefer native configuration, established MCP servers and existing skills/extensions. Do not implement an agent loop, prompt framework, tool server registry or workflow engine to duplicate the installed harnesses.

For every field, distinguish required from preferred. For every effective capability, show whether it is enforced by the bridge/harness, conveyed as an instruction, unsupported or not yet verified. Reject an unsatisfied required restriction before starting. A requested system prompt passed only as a user message is a different behavior and must be labeled, never silently substituted.

Custom tools should primarily reference existing MCP servers or pinned native extensions. Their schemas, implementations and permissions belong together. Tool bundles and hooks can execute code: creating a definition should not install packages, start servers, authenticate services or broaden access as an incidental side effect. Use the coordinator's existing authorization rules for those actions.

### Storage and resolution

Shipped locations for specializations:

```text
.specialists/<namespace>/<id>/specialist.yaml             Project catalog
~/.specialists/<namespace>/<id>/specialist.yaml           Personal catalog
<configured root>/<namespace>/<id>/specialist.yaml        Named catalogs from agents.yaml `specialistCatalogs:`

.agent-bridge/agents/<agent-id>/       Legacy project saved definitions (compatibility only)
~/.agent-bridge/agents/<agent-id>/     Legacy personal saved definitions (compatibility only)
```

Specialist directories and the declared `namespace`/`id` must match. Unqualified `namespace/id` references resolve only when exactly one catalog contains the specialist; `catalog:namespace/id` addresses one catalog. One-off specializations also run inline as a `specialistSpec` with nothing persisted. Future bundle contents beyond `specialist.yaml` remain proposed, not shipped:

```text
Each bundle may later contain:
  instructions.md                    Human-readable behavior
  skills/                            Optional reusable procedures
  references/                        Optional domain material
  tools/                             Tool schemas/implementation references
  evals/                             Cases, fixtures and grader configuration
```

Keep generated configuration, transcripts, artifacts and eval results outside the definition bundle. The current `.agent-bridge/` directory also holds runtime state and is commonly ignored; the project catalog lives in `.specialists/` so shareable specialists are tracked. Never encourage committing the whole state folder. Global storage refers to definitions, not a single cross-project conversation or shared permissions.

Templates must not override stronger project, user or harness rules; specializations likewise request restrictions and never grant capabilities.

The shipped pinning persists the specialist's namespace/id, version, content digest, catalog and resolved snapshot on the conversation. Editing a specialist applies to new conversations. Existing conversations keep the pinned specialist; upgrade requires a fresh conversation. Native persistent context is not automatically portable between harnesses. An intentional handoff transfers a bounded, attributed summary/artifacts, not a claim that the original session moved.

### Authoring experience

Start with a Claude skill backed by shared library/CLI operations: create, inspect, validate, list, instantiate and evaluate. Names are illustrative, not shipped commands. Let the user describe a specialty; generate a reviewable bundle and preview its effective configuration. Ask only for missing consequential choices, not a long form of every optional setting.

The pane should make specialization visible without adding clutter: specialty, harness, conversation name, model where known, template revision, actual tool-policy status and evaluation provenance. Advanced configuration belongs in an inspector, not the idle activity band. A companion tool should consume this same format and API rather than owning a second runtime or session store.

## Evaluation strategy grounded in our observed failures

Start with a reviewer and an implementation specialist. Use fixtures rather than paid full-repo reviews for routine validation.

- Reviewer fixtures include known bugs, correct process-group cleanup, synchronous JavaScript that has no interleaving point, valid path guards and misleading/stale line references. Measure false positives, missed seeded bugs and evidence quality, not finding count.
- Implementation fixtures require a small fix, independent tests and an exact allowed change scope. Inspect file diffs and test exit/results independently.
- Tool-policy cases attempt a forbidden write, shell escape, extension/MCP side path and out-of-scope access. Report only guarantees verified for that launch configuration; an allowed general shell can defeat a nominal tool allowlist.
- Lifecycle cases cover same-conversation follow-up, fresh instance, changed-template reuse, reload, cancellation, pending permission, expired auth and unsupported required settings. Mock deterministic failures before live verification.
- Memory cases separate useful retained knowledge from stale/cross-project facts and verify isolation/reset behavior.
- Evaluate in fresh conversations and disposable fixtures, with controlled references/dependencies and separate grader inputs. Existing production memory must not leak expected answers into trials. Eval isolation is an explicit test setup, not a new default workspace rule for ordinary tasks.

Prefer Node tests and state/artifact assertions. Add a model grader only for criteria code cannot judge, calibrate against human examples and disclose its variability. Repeat behavioral trials, hold out some cases and record failures, latency and observed tokens/cost where available. Pin model/harness/template versions; compare only compatible runs and flag unavailable usage data. A passing result for one binding is not a certification for all harnesses. Set acceptance thresholds before comparing candidates.

## Use cases worth exploring

| Opportunity                       | Why specialization and persistence help                                                  | Evidence of success                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Repository maintainer             | Retains verified architecture decisions and recurring checks across assignments          | Fewer repeated explanations, stable rules, passing changes       |
| Domain migration specialist       | Bundles versioned migration recipes, compatibility references and narrowly scoped tools  | Representative migrations pass before/after tests                |
| Evidence-first reviewer           | Requires reproduction or a clearly labeled hypothesis; challenges common false positives | Lower false-positive rate without missing seeded bugs            |
| Research specialist               | Uses a source policy, citation format and refresh rules in a temporary workspace         | Supported claims, adequate coverage and explicit uncertainty     |
| Incident investigator             | Connects approved read-only observability tools with a hypothesis/evidence workflow      | Traceable diagnosis without unintended writes                    |
| Documentation verifier            | Compares documented interfaces with actual configuration/tests                           | Reproduced contradictions and correct fixes                      |
| Harness/model comparison lab      | Runs the same specialist package and eval cases across compatible bindings               | Measured quality/latency/usage tradeoffs, not anecdotal rankings |
| Bounded implementer/verifier pair | Separates production work from independent acceptance checks                             | Independent outcomes and finite review cycles                    |
| Portable team agent kit           | Shares reviewed recipes and evals while keeping credentials/memory local                 | A teammate can reproduce setup and capability checks             |
| Agent improvement workbench       | Proposes prompt/tool changes, evaluates them and presents a revision diff                | Held-out improvement without automatic self-modification         |

These are exploration candidates, not a commitment to build a large agent organization or autonomous routing system. Automatic routing should follow measured performance and user preference; fallback across harnesses must respect capability and context boundaries.

## Delivery sequence and gates

1. Finish interface usability: predictable focus/back/scroll, all workers/history accessible, quiet composer, approvals/errors clear, effective state trustworthy.
2. Validate native specialization paths across all seven harnesses. Record installed version, prompt semantics, tools/MCP/extensions, settings, instruction inheritance, session reload and unsupported fields. Try the smallest compatible paths first; do not require all seven for the first slice.
3. Implement one project/global package format and resolver, strict validation and effective-configuration inspection. Confirm version-control behavior and precedence with tests.
4. Run one reviewer package through Pi and a second compatible harness. Verify real prompt/tool effects, follow-up persistence, fresh instances and pinned revision behavior. Unsupported bindings fail explicitly.
5. Add a minimal eval command over existing runtime/tests; compare revisions on seeded defects, clean cases and bounded implementation tasks. Preserve reports and replay metadata.
6. Add Claude-led authoring and discovery, then consider a companion editor, import/export, memory and reusable tool bundles based on demonstrated need.

Open research decisions: append versus replace defaults; what instructions each native harness already discovers; existing-agent/skill import licensing and compatibility; MCP/extension credential isolation; how much reproducibility model catalogs permit; global/project memory boundaries; trust for shared executable bundles; and whether a companion tool improves actual authoring beyond the Claude skill. Resolve these with small local experiments before expanding the schema.
