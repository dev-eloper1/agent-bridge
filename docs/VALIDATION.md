# Validation — 2026-10-19

Current status: all six installed providers passed live continuity and native recovery. Five passed scoped code edits and independent tests; Pi passed read-only review using the user-corrected default model. See [PROVIDERS.md](PROVIDERS.md), [CAPABILITIES.md](CAPABILITIES.md), and [provider-smoke.json](provider-smoke.json). The sections below preserve the initial milestone research and are superseded where noted by that expanded validation.

## Initial milestone snapshot

Confidence labels: **local** means exercised here; **upstream** means inspected documentation/source, not a runtime guarantee; **unverified** means not tested; **unsupported** means this bridge intentionally does not offer it.

## Environment and Claude gate

- **Local:** Node 26.2.0, npm 11.13.0, Claude Code 2.1.303, Codex CLI 0.163.0. `devin`, Cursor `agent`, and `pnpm` absent from PATH. Claude and Codex login status report authenticated; no credential files read. Authentication status does not prove entitlement or a successful model request.
- **Local:** `claude plugin validate spikes/mod --json` passes. `CMUX_CLAUDE_HOOKS_DISABLED=1 claude plugin test spikes/mod` passes custom tool/command tests; `claude -p /acp-probe --plugin-dir ./spikes/mod --no-session-persistence` returns the probe command. The cmux wrapper otherwise injects flags before `plugin`, which the test runner refuses.
- **Upstream + schema inspection:** Mods expose `$.tool.register`, `$.ui.status`, `$.prompt.submit`, `$.session.send`, and `$.agent.register`. AgentSpec defines prompt/model/tools/isolation, with no arbitrary ACP executable/transport/runtime field. Native external ACP subagent registration is **unsupported through this documented schema**, not experimentally proven impossible through every conceivable hook. We do not intercept the Agent tool to impersonate a native agent. Probe status was callable; interactive pane rendering was not visually tested.
- **Unverified:** unsolicited cross-session delivery and waking a coordinator. Documented `session.send` concerns authorized Claude peers; it is not a generic daemon inbox endpoint. MVP uses a durable polling inbox. No private socket protocol used.
- Sources: [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference), [create/test Mods](https://code.claude.com/docs/en/plugins/mods/create), [declarations](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts), [peer messaging](https://code.claude.com/docs/en/cross-session-messaging). Raw Anthropic HTTP requests returned 403, but browser research tools fetched the docs. Upstream declarations were downloaded for inspection; they are not necessarily the exact local build's generated types.

## Reuse review

Snapshots and commit SHAs are in `spikes/*/inventory.json` (downloaded review material, ignored from release). Review covered source/docs, not execution of their complete test suites.

| Project                                                                     | Inspected version/license                                         | Findings and decision                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [acpx](https://github.com/openclaw/acpx)                                    | 0.19.6, MIT                                                       | Active source with client transport, named session queue, history, tests and new runtime/flow APIs. `--no-wait` applies to busy-session queue acknowledgement; not our background lifecycle. CLI source owns `.acpx` metadata and can fall back to a new session after failed load. Pinned dev dependency for comparison; do not combine its session truth with our store. |
| [devin-subagents](https://github.com/Duro02/devin-subagents)                | 0.5.0, MIT, default branch master                                 | `src/acp.ts` implements raw stdio RPC, process recovery, permission callbacks; test/smoke/e2e scripts exist. `sessiondb.ts` modifies Devin's private SQLite hidden flags. Reuse lifecycle ideas; avoid copying raw protocol implementation or modifying provider databases. Devin assumptions require adaptation.                                                          |
| [open-agent-bridge](https://github.com/kevinArgueta96/open-agent-bridge)    | 0.1.0, MIT, branch production                                     | Registry HTTP/WebSocket server plus client integrations, durable conversation messaging, dashboard, Vitest tests. Useful discovery/message concepts; brings another session owner and network surface. Not adopted.                                                                                                                                                        |
| [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) | 2.0.0, Apache-2.0                                                 | Reuse stable v1 `ClientApp`/`AgentApp`, NDJSON transport, typed schemas, RPC dispatch and permission/elicitation handlers. Avoid writing a new ACP implementation. Two sequential prompts passed in one mock session.                                                                                                                                                      |
| [Codex adapter](https://github.com/agentclientprotocol/codex-acp)           | 2.2.2, Apache-2.0 (LICENSE inspected; GitHub metadata says Other) | Separate adapter, bundles compatible Codex dependency, documents CODEX_PATH override and auth reuse. Native installed `codex --help` offers app-server, not `codex acp`. Pin adapter; do not invent flags.                                                                                                                                                                 |

Source maintenance timestamps and test file inventories are recorded in snapshots; no independent maturity/security certification inferred from activity. Optional frameworks were not adopted: extra harness not needed for this slice.

## Protocol and provider gates

- [ACP setup](https://agentclientprotocol.com/protocol/session-setup): negotiate initialize capabilities; load is optional. ACP isn't our queue or message bus.
- [acpx CLI](https://github.com/openclaw/acpx/blob/main/docs/CLI.md): locally installed 0.19.6 and tested named session creation; further prompt result recorded below. SDK mock spike in `spikes/transport.mjs` passes. acpx writes ~/.acpx and required filesystem escalation for the comparison.
- [Devin commands](https://docs.devin.ai/cli/reference/commands) and [Cursor ACP](https://prod.cursor.com/docs/cli/acp): provider commands are upstream profiles only until installed. No Devin Cloud used.
- [OpenAI CLI reference](https://developers.openai.com/codex/cli/reference/) and installed help: app-server is separate from ACP. Codex ACP is adapter functionality, not a universal native Codex flag.

See CAPABILITIES.md and the final test evidence below for actual recovery limits. Usage updates are stored as provider-reported metadata; invoice pricing and quota relief remain unverified. No comparative quota benchmark is claimed.

## Final local evidence

- acpx 0.19.6: named session creation and a prompt through the mock both passed. One first prompt invocation used `-s` at the top level and failed with usage; corrected `prompt -s` worked. The mock's initial session was memory-only for this transport comparison, so the later acpx invocation created a new native session. This comparison establishes executable/wire viability, not acpx recovery/continuity. No acpx persistence claim inferred. SDK selected for explicit ownership and fail-closed load behavior, not because acpx cannot work.
- `npm test`: six integration tests pass, covering config, bounded output, replayable inbox, sequential context, form replies, next-turn steering limits, permissions, isolated worktrees, concurrent providers, cancellation, deadlines, backend death, unsupported recovery, artifact budget, MCP disconnect, actual daemon SIGKILL and queued-task recovery. Historical replay during load is kept out of new-task output.
- `npm run demo`: actual MCP dispatch returns in approximately 20 ms; facade closes while worker continues, question/reply completes, 24 KB output is paginated, runtime restart reloads conversation context.
- `npm run test:mod`: one installed Claude Mod harness test passes. CLI command `/acp-probe` also passed. No external native identity assertion.
- `npm run smoke`: authenticated Codex adapter passes three tiny no-tools prompts, two in a live session and one after runtime/provider replacement. Same native ID, exact random-label recall, model discovery and context usage recorded in `docs/real-smoke.json`. Initial sandboxed attempt failed because Codex app-server needs normal ~/.codex writes; rerun with filesystem escalation passed. Later smoke confirmed replay separation with clean new-turn output. Real execution required no Devin/Cloud service.
- `npm audit`: zero known vulnerabilities after updating pinned YAML from 2.8.1 to 2.9.1. Dependencies and lockfile are pinned. Upstream projects' own test suites were inspected, not run.

Upstream review snapshot identifiers:

| Repo                             | Commit                                   | Last pushed (GitHub metadata) |
| -------------------------------- | ---------------------------------------- | ----------------------------- |
| openclaw/acpx                    | 40ecc17ec17cd8abf4eb311bbc13ba635657f798 | 2026-10-19T20:08:44Z          |
| Duro02/devin-subagents           | 6a1e025c886fa15d5149ff7aabb936d12095ce2a | 2026-09-17T10:42:10Z          |
| kevinArgueta96/open-agent-bridge | c117ae93a8d3a86633fb2fd6d8f3365d44463ac8 | 2026-10-16T00:55:16Z          |

Remaining limits: real Devin/Cursor authentication and recovery, live Codex permission/question/cancel paths, interactive pane rendering, automatic wake-up, independent coding-task acceptance and comparative quota benchmarking remain unverified. They do not block the offline first-milestone slice. No automatic merge, agent-to-agent message bus, or generalized planner was added.

## Expanded six-provider validation

The follow-up implementation reuses pinned Pi ACP 0.0.34 and Claude Agent ACP 0.94.0, plus native OpenCode/Devin/Cursor ACP and the existing Codex adapter. All installed CLI versions and evidence are in PROVIDERS.md. Twelve deterministic tests pass. The expanded source fixes native CLI discovery under npm, modern configuration-based model discovery, and non-success stop reasons; it adds a restricted Pi RPC wrapper and a non-overwriting project-config setup command.

The initial Codex smoke could select the adapter's bundled 0.160.1 binary because npm injected node_modules/.bin ahead of PATH. This follow-up detected the discrepancy and retested installed Codex 0.163.0 explicitly. Do not infer the exact binary version solely from the earlier shell inventory. The final provider-smoke evidence records the actual resolved installed CLI version.

Pi's rejected initial default was diagnosed from this test's newly created session log. After the user corrected Pi's model, the bridge-only workaround was removed; the final test passes with the user's default openai-codex/gpt-5.6-luna. No global Pi settings are modified.

Full live tests use scoped temporary repositories, up to four small prompts per provider and independent Node acceptance tests. Separate metadata-only probes verify Claude/OpenCode/Devin's modern model catalogs without model prompts. The live writable providers did not trigger ACP permission callbacks, so permission dialogs remain mock-tested. Code inspection and live results support session continuity, not general code quality, task-acceptance automation, invoice costs or quota relief.

## Claude Code plugin delivery

The Claude-first packaging now includes a local marketplace, plugin manifest, delegate/status skills, auto-started project runtime, bounded wait tool, worker Mod pane/status and same-session event submission using documented $.prompt.submit. No user-managed daemon terminal or MCP JSON is needed for ordinary use.

Fifteen offline tests cover runtime plus simultaneous plugin auto-start, reconnect/recovery, long macOS socket paths and recursive-activation prevention. Two tests in the installed Claude Mod host cover task tracking/rendering, one compact notification and cross-session filtering. Actual Claude-to-Pi skill/MCP/worker execution passes; full evidence is claude-plugin-smoke.json. Claude's real MCP tool result is a content-block array; the Mod handles this form, and its live active-worker status was observed.

A failed initial startup exposed macOS Unix socket length limits. Long paths now use a private per-user hashed socket under /tmp. Claude cached the previous failed MCP connection; adding the release env field to the plugin config forced a fresh connection. No private Claude socket protocol was used.

Copilot was added and live-tested after the initial six-provider suite; see PROVIDERS.md for its scoped permission test and model workaround. All seven have passed native conversation continuity/recovery.

## Project-folder delegation correction (0.3.0)

The mandatory worktree default prevented Codex from reviewing a folder without Git. Shipped writable profiles now use the current project folder. The delegation skill explicitly selects project mode for ordinary new tasks, including when an older generated config still specifies worktrees, and carries relevant user/project instructions and file scope into the worker prompt. The bridge does not claim to transfer Claude permission configuration to other CLIs.

Per-dispatch workspace selection now supports project, existing directory, temporary scratch and explicit isolated worktree modes. Follow-ups use agentSessionId; different folders keep separate conversations. Existing worktree sessions/state remain intact. Scratch folders persist for inspection and follow-up rather than being deleted automatically.

Validation: eighteen offline tests and two actual Mod-host tests passed. New tests exercise the actual mock process and ACP session cwd, non-Git project dispatch, explicit isolation failure without fallback, context separation/restoration across folder switches, temporary-folder persistence after runtime restart, invalid/cross-worker conversation references, and missing workspace handling. A test exposed idle-process cleanup on a missing workspace; that process is now terminated rather than removed from tracking while alive.

Live evidence: [claude-codex-review-smoke.json](claude-codex-review-smoke.json). Actual Claude loaded the delegation skill, selected project mode, dispatched Codex, waited and read the result. Codex identified the seeded subtraction bug and exact random marker. The harness independently checked that the source was unchanged and no Git repository or worktree was created. Run with `npm run smoke:claude-plugin -- --codex-review`; add `--installed` to exercise the installed plugin copy. These live tests use existing CLI authentication and make real model requests.

Both development and installed-plugin runs passed. The user plugin was updated to 0.3.0; the final recorded evidence uses the installed copy without a development plugin flag. This project's idle old runtime was stopped, and its task-free generated defaults were changed to project mode. Existing task/conversation history was not deleted. Restart Claude Code or reload plugins to load the updated tools and skill.

## Activity visibility and review fixes (0.3.1)

A real Devin review produced 48 tool_call and 150 tool_call_update messages; the previous pane discarded them and showed only identity/status. The runtime now retains up to eight recent tool entries with titles, kinds, status and timestamps. The Mod detail pane shows folder, tools and the public-output tail. It does not promote internal thought chunks to the UI. Providers may omit activity; this is not a terminal attachment.

The same review exposed chopped report text in completion notifications and ambiguity around the result summary. Completion notices now carry lifecycle metadata without provider-report fragments. Result metadata explicitly labels the bounded output tail and includes fullOutputRef/outputBytes; review instructions require reading relevant report pages from offset 0 and independently checking important claims.

Confirmed implementation fixes: reused-worker stderr callbacks interrupt the active task instead of the creation-time task; invalid state gets a recovery diagnostic while the original bytes are preserved; daemon spawn failures surface their cause without waiting for the generic timeout. Existing project state containing the completed Devin review validated successfully, with no history discarded. Its idle runtime was stopped before upgrading the plugin.

Validation: 22 offline tests and 3 production Mod-host tests passed; manifest validation passed without warnings. Regressions cover tool activity/public-output separation, terminal event wording, result output metadata, reused-worker stderr overflow, corruption preservation and immediate launch diagnostics. The Mod tests cover detail rendering and omission of report fragments from prompts.

The installed 0.3.1 plugin also passed the real Claude-to-Codex non-Git review test, recording two completed provider tool calls in compact task activity. Evidence: [claude-codex-review-smoke.json](claude-codex-review-smoke.json). Manifest validation, formatting and documentation link checks passed.

## Delegation interaction model (0.4.0)

Ordinary delegation now uses agents_run, a foreground MCP coordinator over existing spawn/wait/result methods. It returns results/input in the tool call and supports continuing bounded waits by taskId alone. Explicit background work still uses spawn. The skill keeps identifiers internal, starts fresh context for new tasks and resumes only explicit follow-ups. Session listings include bounded last-task descriptions for reference recovery. Review results start at the beginning of public output, with pagination metadata.

The Mod no longer auto-opens a pane. Compact progress and optional numbered inspection replace dispatch receipts and mandatory UUID navigation. Inspection supports public-output pages, selected-task cancellation and closing the pane. Foreground tasks do not generate background completion prompts; retrieving a background terminal result suppresses its pending/later completion notification without marking independent acceptance complete.

Foreground cancellation is tested through MCP client abort and EOF. The SDK stdio server transport lacked an EOF close handler; the facade now explicitly closes its protocol on stdin end so in-flight request signals abort. The Mod additionally cancels tracked foreground tasks when the parent turn is interrupted or the session ends; explicit background tasks remain detached. Failed foreground coordination attempts best-effort cancellation.

The workspace identity fix is included: canonical path and device/inode are pinned at dispatch for existing folders and after creation for scratch/worktree folders, rechecked before launch/native load/prompt, and persisted across restarts. Initial outside-folder and symlink selections remain intentional. Checks cannot eliminate filesystem changes after validation and are not OS sandboxing.

Validation: 29 offline tests, 6 actual Mod-host tests and the offline background/recovery demo pass. A real natural-language Claude-to-Codex review used one agents_run call and returned the bug/label without task IDs, artifact URIs or a launch receipt. Live status correlation used the Mod's tool-call taskKey. Tests also cover fresh task contexts, explicit follow-up continuity, first-page results, notification ownership/acknowledgment, optional numbered inspection, pagination and parent-turn cancellation. External workers remain outside Anthropic's native Agent runtime; no new native-registration claim is made.

The user-installed plugin was updated from 0.3.1 to 0.4.0. Both natural-language installed-plugin tests passed: Claude→Codex review and Claude→Pi file reading each used one agents_run call and returned results without internal IDs or a background dispatch receipt. Existing project history (three recorded tasks) was preserved. Manifest validation, formatting and local documentation link/anchor checks passed. Evidence is in [claude-codex-review-smoke.json](claude-codex-review-smoke.json) and [claude-plugin-smoke.json](claude-plugin-smoke.json).

## Visibility and artifact-link follow-up (0.4.1)

The user's Pi run exposed locations containing file paths that the previous compact status discarded. The automatic AbovePrompt block now shows bounded tool names/paths while active, yields to surveys and disappears at completion. The Pane follows live public output for active tasks, can pause to read from the beginning, and renders reports using the engine's Markdown component. Documented native Button constructors hold their actual handlers; surface validation caught invalid undefined style props and unowned raw button declarations during development, which were corrected before delivery. Tests exercise a 38-column pane, native controls and report paging.

A regression test reproduced artifact symlink reads following a disposable unrelated file before the fix. Shared descriptor I/O now rejects linked leaf files, hard-linked files and static artifact/task-directory symlinks. Regression tests confirm no unrelated contents are returned or changed and preserve append/page/budget behavior. This is not an OS sandbox or a guarantee against every concurrent ancestor race. The bounded-call wait behavior was already correct; waitExpired now labels unfinished returns explicitly.

The updated suite passes 33 offline tests and 9 Mod-host tests. No private files were used in the symlink reproduction.

The user-installed plugin was updated from 0.4.0 to 0.4.1 after stopping the idle project runtime; its four existing tasks were preserved. Manifest validation and formatting checks passed. A real installed-plugin Claude→Pi test passed using one foreground agents_run call, with the exact fixture label returned and fixture.txt retained in recent tool activity. Evidence: [claude-plugin-smoke.json](claude-plugin-smoke.json). The Mod-host tests validate native component trees, narrow layouts and button handlers; the noninteractive live smoke does not verify painted terminal pixels.

## Worker navigation and conversation intent (0.4.2)

The installed Mod declarations (spikes/claude-code.d.ts, PaneOpenArgs) explain why an open pane may remain invisible: unsolicited panes wait below 144 terminal columns, or 110 after that pane has been explicitly requested. Explicit user input places panes at any width. The current [official reference](https://code.claude.com/docs/en/plugins/mods/reference) directs implementers to prefer installed declarations for version-specific behavior.

Active owned tasks now open the inspector once without a focus request. A native AbovePrompt output button opens it through an actual user press with a focus request; All tasks returns to the task list, and a completed report remains accessible. Tests exercise the button at 38 columns, manual close without repeated opening, completion switching to the first report page, and existing Markdown/paging controls. The suite passes 33 runtime and 10 Mod-host tests; manifest validation passes. Component-tree and handler tests do not prove painted terminal pixels or override Claude's layout/focus decisions.

The delegation skill now spells out natural-language same-session follow-ups, explicit fresh-session instructions and unambiguous recovery from recent session listings. Runtime routing still requires the corresponding agentSessionId for a follow-up; unrelated requests do not silently reuse a conversation.

Installed 0.4.2 verification passed: actual Claude loaded the skill and made three foreground Pi calls. The second task reused the first conversation, recalled the random fixture label without receiving that label in its prompt and made no tool calls. The third task used a different conversation and returned the requested fresh-session response without tools. Evidence: [claude-session-smoke.json](claude-session-smoke.json). Reproduce with `npm run smoke:claude-plugin -- --installed --session-continuity`. The idle project runtime was stopped before upgrade; all six existing project tasks were preserved.

## Stable worker identity and task history (0.4.4)

Activity-sorted list positions caused worker numbers to change when tasks completed or another worker started. The Mod now groups tasks by persistent conversation, uses semantic names and retains task-specific history. Runtime names survive native load and runtime restart; legacy state migrates without changing task/conversation IDs. Fresh conversations with the same initial description receive distinct suffixes. Roster/status/results expose workerName so Claude can resolve names to internal conversation references.

Tests cover same-name follow-ups, separate old/new report reads through the actual native history button, unique fresh names, runtime restart/legacy migration, and eight completed workers restored after a same-Claude-session UI reload. Old owned history is hydrated rather than dropped by the last-five refresh window. The suite passes 35 runtime tests and 14 Mod-host tests.

The autostart failure shown in the user's worker run was independently reproduced by setting AGENT_BRIDGE_WORKER=1. The marker correctly prevents recursive plugin activation, but the test helper inherited it unintentionally. The helper now defaults its child to coordinator mode while the recursion test explicitly retains worker mode. Both tests pass under the inherited worker flag. Panel finish wording is neutral and explicitly does not claim passing tests; recent failed tool calls get a separate warning, and multiline commands have compact first-line labels.

Installed 0.4.4 passed the real three-turn Claude→Pi test: first and second tasks shared both workerName and agentSessionId, Pi recalled the random label without tools or a supplied answer, and the fresh task used a different name/conversation. Evidence: [claude-session-smoke.json](claude-session-smoke.json). This noninteractive smoke validates transport/metadata, not painted terminal pixels. Existing project tasks were left running during installation; the old project daemon needs an idle restart before its statuses expose the new runtime naming metadata. The Mod provides descriptive fallback names in the meantime.

## Multiple active workers (0.4.5)

A user screenshot showed one worker dominating the compact activity area while the detail pane correctly displayed one selected worker. The band now allocates worker headings before tool details, and its counted Choose worker button opens the named conversation list. The 14-test Mod suite includes two distinct worker headings at a three-row budget, real button presses revealing both choices, independent selection, and cancellation that leaves the other task running. One pane still displays one selected task at a time.

## Navigation workspace (0.5.0)

The previous inspector required list→detail→history round trips and reset artifact offsets on selection. The new overview/selection state is independent: overview preserves the reading target, per-task reading state stores artifact-page history/live mode, and per-conversation state restores the last visited task. Native Worker and Task selectors make switching available before output in detail/history/overview views. A native Find field filters overview cards by name, task history and status without removing picker options. Status counts separate active, input, finished and failed/cancelled work. Pending-input navigation only selects a task; it does not answer permissions.

The band now provides direct conversation buttons and a consistent counted All workers overview action. New work updates the roster without changing the reading target. A queued turn no longer takes precedence over a running/input turn in the same conversation's overview status. Native controls were validated at 38 columns and with a mobile button fallback; the engine rejected punctuation hotkeys during development, so adjacent-worker controls use supported j/k keys.

Validation: 35 runtime tests and 18 Mod-host tests pass. New tests exercise real Select/Input/Button handlers, direct switching between two report pages, restoration through overview and same-Claude-session reload, task selection during arrival of a follow-up, attention/work previews, search with full picker access, adjacent-worker navigation and mobile fallback. Manifest validation passes. These checks validate native component trees and interactions, not painted pixels or exact terminal scroll positions after resizing. No live provider run was repeated for these frontend-only changes. Interaction design and explicit scope are in [Worker navigation](WORKER_NAVIGATION.md).

The user-installed plugin was updated from 0.4.5 to 0.5.0. All 18 Mod tests also passed against the installed cache directory, validating the delivered native selectors and handlers. Once project tasks were all terminal, the idle runtime was restarted and all eleven task records were preserved; nine existing conversations now expose persistent names. No active work or pending approval was interrupted.

## Visual navigation hierarchy (0.5.1)

The user's live screenshot showed selectors, actions, status and report headings merging into a dense monochrome view. Native Box borders/padding/margins, Text colors/weight and explicit status symbols now distinguish these regions. The overview has worker cards and a selected-worker cue. Native Select labels include symbols because Select/Button do not expose arbitrary per-option color styling. The band uses colored status symbols next to its actual worker buttons. Completed tasks remain neutral; only failed/input/running states receive red/yellow/cyan status emphasis. The Markdown report renderer remains unchanged.

Nineteen Mod-host tests pass. The added regression mounts a 38-column overview/detail, checks failure/input/finished styling, verifies framed navigation and report headings, and presses the actual next-page button to ensure presentation does not break navigation. Existing tests cover selectors, search, reading-position restoration and mobile fallback. Tests validate native trees/handlers; terminal pixel appearance remains dependent on the host/theme and has not been screenshot-verified automatically.

The user-installed plugin was updated from 0.5.0 to 0.5.1, and all 19 Mod-host tests passed against the installed cache. Build, manifest validation and formatting checks passed. The runtime was not interrupted for this presentation update.

## Navigation state and composer priority (0.5.2)

The user's live screenshots exposed a selector holding the arrows, mixed report/worker controls, an unclear return path and idle band buttons colliding with slash autocomplete. The pane now has one explicit screen state, Back to workers/Back to report, reading focus outside selectors, separate stable report paging, rendered-task/page guards, stale artifact response guards and cancellation of pending navigation on close. Idle status/band content disappears; any composer draft suppresses active controls and unsolicited pane discovery without changing the draft or stopping work.

The installed local Mod declarations verify prompt.read/edit/fill, ui.focus and native scrolling APIs. Live testing in the user's VS Code Claude terminal verified Back to overview, Esc returning the keyboard with the pane retained, `/relo` autocomplete and Down selecting a native command without worker interference, and Page Down scrolling Pi's retained report at the original terminal height. The temporary draft was cleared and terminal panel size restored. Native arrows may move control focus, so hints explicitly recommend Page Up/Page Down for content scrolling. This is a host behavior constraint; no custom keyboard/rendering framework was added.

Twenty-four Mod-host tests pass. Added coverage checks detail focus declarations, Back through history/overview with page preservation, stale mounted controls, idle/draft visibility without input mutation, close during a delayed read, and a delayed poll arriving after another worker is selected. Build and manifest validation pass. No provider/model run or runtime restart was needed for these frontend changes.

The user-installed plugin was updated from 0.5.1 to 0.5.2. All 24 Mod-host tests also pass against the installed cache directory. Formatting checks pass. The runtime was not restarted.
