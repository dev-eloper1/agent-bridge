# Milestone checklist

- [x] Read both project specifications in full; inspect empty workspace.
- [x] Inventory installed CLIs and check authentication without reading credentials.
- [x] Validate Mod tools/UI and external native subagent assumptions with a local spike.
- [x] Inspect reusable upstream code, licenses, versions; compare acpx and SDK.
- [x] Record validation and runtime decision before implementing runtime.
- [x] Implement durable runtime, persistent ACP process, bounded artifacts and MCP facade.
- [x] Exercise background tasks, questions/replies, steering, cancellation and recovery.
- [x] Run deterministic integration tests and installed-provider smoke test.
- [x] Document runnable demo, capability matrix and precise remaining limitations.

Delivered first milestone. See CAPABILITIES.md for features deliberately unverified or deferred beyond this slice.

## Installed-provider follow-up

- [x] Re-inventory all six installed CLIs and verify native ACP/adapter commands.
- [x] Add pinned Pi/Claude adapters and all six configurable profiles.
- [x] Fix npm CLI shadowing and normalize modern model discovery.
- [x] Add Pi read-only wrapper and explicit model-error handling; retain the user's fixed default.
- [x] Pass live context/recovery on all six; five code-edit acceptance tests and Pi read-only review.
- [x] Add project init command and twelve deterministic tests.
- [x] Write architecture, usage, provider research and updated capability documentation.

## Claude-native user experience

- [x] Package a Claude Code plugin, local marketplace and delegation/status skills.
- [x] Auto-create project config and start/reconnect one detached runtime.
- [x] Implement worker pane and session-owned compact event notifications through documented Mod APIs.
- [x] Prevent recursive plugin activation in external Claude workers.
- [x] Cover auto-start/reconnect, long socket paths and Mod notification behavior in tests.
- [x] Pass live Claude-to-Pi plugin verification.
- [x] Install the validated local plugin for the user.

- [x] Add native Copilot ACP and pass live continuity, recovery, scoped edit/permission and independent acceptance tests.

## Future features

- [ ] Add optional A2A agent-service providers behind the existing Claude delegation tools. Retain Agent Client Protocol for installed CLI workers. This is separate from the IBM/BeeAI Agent Communication Protocol that merged into A2A. Scope, reuse strategy and acceptance gates are in [ROADMAP.md](ROADMAP.md).

## Workspace behavior correction (0.3.0)

- [x] Use the current project folder by default; remove Git requirements for ordinary review/research/implementation and manual project initialization.
- [x] Support per-dispatch project, existing directory, persistent scratch and explicitly requested isolated worktree selection.
- [x] Bind conversations to their workspace and support exact follow-ups by agentSessionId without silently moving native context.
- [x] Update the skill to carry forward Claude Code task/project instructions and scope, coordinate overlapping edits, and avoid unsolicited Git setup/worktree requirements.
- [x] Pass eighteen offline tests, two Mod-host tests and live Claude → skill → Codex review in a non-Git folder.
- [x] Update the user-installed plugin from 0.2.0 to 0.3.0 and pass the same Codex review through the installed copy.

## Activity and review follow-up (0.3.1)

- [x] Expose bounded provider tool activity and public output in the Mod detail pane.
- [x] Replace clipped-report notifications with lifecycle metadata and explicit full-output references in results.
- [x] Fix reused-worker stderr callback ownership and add a regression test.
- [x] Validate state on load without deleting invalid data; surface daemon spawn errors.
- [x] Pass twenty-two offline tests and three production Mod-host tests.

## Claude delegation usability gaps

Addressed in 0.4.0 through a foreground MCP path and revised Mod/skill behavior. External runtimes remain distinct from native Anthropic Agent registration:

- [x] Choose foreground/background based on the caller's request; ordinary review requests should return findings rather than end at a dispatch receipt.
- [x] Keep task/session IDs and process details internal unless requested; use short task descriptions in progress UI.
- [x] Keep the pane optional and compact; provide readable full results instead of automatically expanding a raw output tail.
- [x] Integrate completion with the calling workflow and suppress duplicate/handled completion prompts; background wake-up is a separate path.
- [x] Define fresh task context versus explicit conversation resume, preventing unrelated tasks from silently sharing provider/folder history.
- [x] Make context, permission and cancellation differences from native Claude subagents explicit; verify any claimed native integration before shipping it.

Workspace identity checks are included in this release. Validation: 29 offline tests, 6 Mod-host tests, an offline background/recovery demo and a natural-language Claude-to-Codex foreground review test. Native external-runtime registration remains unsupported through the inspected schema; no such identity is claimed.

- [x] Install 0.4.0 and pass ordinary Codex/Pi delegation through the installed copy, preserving existing task history.

## Worker visibility and formatted panels (0.4.1)

- [x] Show automatic inline tool/file activity while work runs without model wake-up prompts.
- [x] Use Claude's documented pane components, native Markdown and native buttons/hotkeys.
- [x] Follow live public output; support pause/report paging and return to live following.
- [x] Reproduce artifact symlink redirection with a disposable fixture and reject unsafe read/append paths.
- [x] Add explicit waitExpired metadata for bounded foreground waits.

## Worker navigation and conversation intent (0.4.2)

- [x] Diagnose native pane placement thresholds using the installed Mod declarations.
- [x] Open active-worker inspection once; preserve manual close and paused report selection.
- [x] Add explicit native output button for narrow terminals and completed reports, plus All tasks navigation.
- [x] Clarify same-session follow-ups, fresh-session requests and reference recovery in the delegation skill and docs.
- [x] Pass 33 runtime tests, 10 Mod-host tests and installed natural-language same/fresh-session verification.

## Stable conversation identity and history (0.4.4)

- [x] Replace activity-sorted list identity with persistent semantic conversation names.
- [x] Group follow-ups under the original conversation and retain separate task reports.
- [x] Restore older owned history after same-session reload, beyond the five-task refresh window.
- [x] Reproduce/fix the autostart test's inherited worker flag; preserve the real recursion guard.
- [x] Distinguish worker finish from test success and compact multiline activity commands.
- [x] Document current worker customization, authentication/error gaps and configuration roadmap.
- [x] Pass 35 runtime tests, 14 Mod-host tests and installed named follow-up/fresh-conversation verification.

## Multiple-worker visibility (0.4.5)

- [x] Show each active worker heading before its recent tool details.
- [x] Include active worker count and open the conversation chooser from the band.
- [x] Cover both worker headings and actual chooser button handling in a three-row activity area.

## Navigation from user tasks (0.5.0)

- [x] Define worker/conversation, task and report as separate navigation objects.
- [x] Provide an overview with work previews, attention/status counts and search.
- [x] Make worker selection available inside reports and task selection available without a history drill-down.
- [x] Preserve per-task report pages/live mode and per-conversation task selection across switching, overview and reload.
- [x] Prevent new work from replacing a person's reading target.
- [x] Add direct band access and a consistent All workers action, with native/mobile fallbacks.
- [x] Validate native control handlers, narrow layouts, concurrent activity and navigation restoration.
- [x] Install 0.5.0, pass all 18 Mod-host tests against the installed copy, and restart the idle project runtime with history preserved.

## Visual navigation hierarchy (0.5.1)

- [x] Frame navigation/actions separately from worker context and public output.
- [x] Add status symbols and native palette colors while keeping finished status neutral.
- [x] Add spaced section headings, padded overview cards and a selected-worker cue.
- [x] Match band status symbols and reduce spacing in narrow/short panes.
- [x] Validate native styles, status distinctions and report paging at 38 columns.
- [x] Install 0.5.1 and pass all 19 Mod-host tests against the installed package.

## Navigation consistency and composer priority (0.5.2)

- [x] Consolidate screen state, Back behavior and detail focus.
- [x] Separate report paging from worker navigation; reject stale actions and responses.
- [x] Prevent pending navigation from reopening a closed pane.
- [x] Hide idle controls/status and yield to composer drafts and native autocomplete.
- [x] Exercise native Back, Escape, autocomplete and Page Down in the live terminal.
- [x] Install 0.5.2 and pass all 24 Mod-host tests against the installed package.

## Harness-neutral worker settings

- [x] Add private per-workspace preferences (0600, canonical-path/device/inode keyed) and a compiled `.agent-bridge/effective-agents.yaml` with managed defaults overlaid by saved choices.
- [x] Add build/config daemon handshake: stale idle runtimes restart automatically; active tasks keep the previous runtime with `update_pending`; the MCP facade recompiles config before every call.
- [x] Normalize provider-advertised ACP session options (select/grouped/boolean/legacy modes) and probe profiles without sending a prompt.
- [x] Add `plugin-settings`/`plugin-configure`/`plugin-migrate-managed` human operations (CLI only, never MCP tools) with strict validation and fail-closed writes.
- [x] Ship `/workers settings` in the Mod: provenance, readiness, profile cards, native selects, managed migration, explicit-env read-only and mobile CLI fallback.
- [x] Safe legacy migration: matching generated configs import runtime/session preferences and stay managed; provider-different legacy configs are retained as base with warnings.
- [x] Pass 137 runtime tests and 38 Mod-host tests; explicit `AGENT_BRIDGE_CONFIG` stays operator-managed read-only.
- [x] Ship `npm run update:plugin`: fast-forward-only main update that preserves uncommitted changes, rebuilds, verifies and refreshes the installed plugin.

## Next milestone: specialized agents (after interface stabilization)

- [x] Record product direction, initial primary-source research, package scope, use cases and acceptance gates in [SPECIALIZED_AGENTS.md](SPECIALIZED_AGENTS.md).
- [x] Ship declarative specializations: `.specialists/` project/personal/configured catalogs, strict namespaced resolution, `specialists_catalog` discovery, `specialistRef`/inline `specialistSpec` delegation with compatibility checks, `specialists_schema`/`specialists_validate`, the `specialize` skill and pinned conversation snapshots.
- [ ] Validate specialization capabilities and adapter forwarding across the installed harnesses.
- [ ] Extend packages beyond declarative instructions: native tool/MCP bindings, model/memory settings and effective configuration inspection.
- [ ] Prove a versioned reviewer on two compatible harnesses with persistent and fresh conversations.
- [ ] Add fixture-based outcome/behavior evals and revision comparisons.
- [ ] Grow the specialist ecosystem: adapt-from-native flows and team catalogs via normal Git review. No bridge-side publishing command or remote catalog is planned; management stays with the `specialize` skill and host file/Git tools.
