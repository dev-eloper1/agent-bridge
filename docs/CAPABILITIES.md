# Capability matrix

Current local validation: 2026-10-19, expanded to all seven installed CLIs. The initial milestone's absent-binary findings are historical; see [PROVIDERS.md](PROVIDERS.md) for the current versions, commands, research sources and detailed live results.

| Capability                                             | Pi                | Codex                 | Claude Code             | OpenCode                | Cursor                | Devin                   |
| ------------------------------------------------------ | ----------------- | --------------------- | ----------------------- | ----------------------- | --------------------- | ----------------------- |
| ACP initialize/session create                          | Passed            | Passed                | Passed                  | Passed                  | Passed                | Passed                  |
| Models discovered                                      | Passed            | Passed                | Passed (config options) | Passed (config options) | Passed                | Passed (config options) |
| Two turns, same conversation                           | Passed            | Passed                | Passed                  | Passed                  | Passed                | Passed                  |
| Same native session after runtime/provider replacement | Passed            | Passed                | Passed                  | Passed                  | Passed                | Passed                  |
| Scoped code edit + independent tests                   | Read-only profile | Passed                | Passed                  | Passed                  | Passed                | Passed                  |
| Read-only code review                                  | Passed            | Not separately tested | Not separately tested   | Not separately tested   | Not separately tested | Not separately tested   |
| Live permission/form question                          | Not elicited      | Not elicited          | Not elicited            | Not elicited            | Not elicited          | Not elicited            |
| Live mid-turn cancellation                             | Not exercised     | Not exercised         | Not exercised           | Not exercised           | Not exercised         | Not exercised           |

The deterministic mock additionally verifies: true background MCP dispatch, facade disconnection, queued steering with caps, form question/reply validation, explicit once-only permission selection, read-only permission denial, artifact pagination/traversal rejection, output budgets, cancellation/deadlines, provider death, failed/unsupported load without fallback, historical replay separation, actual daemon SIGKILL and provider cleanup, and queued-task recovery. Thirty-three offline tests pass, plus the production Mod host tests. Full live evidence is in [provider-smoke.json](provider-smoke.json); discovery-only evidence is in [provider-probes.json](provider-probes.json).

## Recovery boundaries

- **Facade/UI connection:** the MCP client disconnect test and demo prove the daemon and worker continue. Interactive Claude UI restart itself was not automated; another session can reconnect using the same config.
- **Daemon shutdown/restart:** task/event history survives. In-flight jobs fail explicitly, pending questions invalidate, queued jobs resume. Graceful and actual SIGKILL paths were tested with the mock.
- **Backend replacement:** all seven real providers restored native conversation context using advertised session/load. This restores a conversation, not an interrupted tool operation.
- **Failed/unsupported load:** mock test fails the next task and preserves the native ID; no silent conversation replacement or side-effect replay.
- **Durability:** snapshots fsync file and directory; artifacts append independently. Process-restart durability is tested. Sudden machine power-loss atomicity across state and artifact files is not claimed.

## Integration boundaries

The shipped Claude plugin bundles delegation/status skills, automatic MCP/runtime startup, a worker pane and same-session notifications. Production Mod host tests verify watched-task tracking, rendering, notification submission and ignoring other sessions’ events. Arbitrary ACP workers are not native Claude subagent identities. The Mod uses documented $.prompt.submit for originating-session notifications; no private cross-session messaging protocol is used. Without the Mod, use bounded waits/status and the durable inbox.

`steer` queues at most two follow-ups for later ACP turns. It is not guaranteed immediate mid-turn injection. Acceptance criteria are passed to the worker; independent verification remains pending in the runtime. The live test harness performed its own independent verification without changing that runtime contract.

Provider permissions and tool autonomy differ. The bridge never implicitly approves an incoming ACP permission request, but cannot intercept operations a provider handles internally. Pi is explicitly restricted to read tools with executable extensions/MCP disabled. Git worktrees and read-only tool profiles are not OS sandboxes.

Models are discovered when a session opens or updates config; roster output includes at most ten entries and total count. Usage is provider-reported session metadata, not invoice cost. No universal model switching, plan entitlement, quota isolation or measured quota savings is promised. macOS is locally tested; Linux and Windows were not tested here.

## Copilot addition and plugin delivery

Copilot CLI 1.0.100 passes native ACP initialization/model discovery, two-turn continuity, same-native-ID load after runtime replacement, and a scoped code edit with independent tests. Its live edit permission request was answered allow_once only for the authorized fixture path. The bridge profile uses the advertised auto model to avoid a rejected saved custom model; it does not change global settings.

The production plugin is loadable/installable as agent-bridge@agent-bridge-local. A real Claude Code session loaded agent-bridge:delegate, called plugin MCP spawn/wait/result, delegated to installed Pi and returned the exact fixture label. The live Mod status changed from zero to one active worker. Mod-driven notification submission/ownership are validated in the actual Mod test host; the real non-interactive CLI smoke intentionally uses bounded wait instead of interactive wake-up.

## Workspace selection (0.3.0)

Current project is now the shipped default for writable profiles; Pi stays read-only in the project folder. No Git setup is required for project, existing-directory or scratch-folder tasks. Isolated worktrees are available by explicit request and still require committed HEAD. Per-dispatch workspace choices and exact conversation follow-ups are exposed in agents_spawn; status/results report cwd, and list exposes known workspace conversations. The skill carries relevant coordinator instructions/scope into worker prompts; external CLIs retain their own permission settings. See [usage](CLAUDE_PLUGIN.md#choose-a-workspace-only-when-needed) and [live non-Git Codex review evidence](claude-codex-review-smoke.json).

## Activity visibility (0.3.1)

The worker pane shows folders and latest activity; `/workers <taskId>` shows up to eight recent provider-reported tools/statuses and a bounded public-output tail. This is not an attached CLI terminal and does not imply access to every internal operation. Completion notifications omit clipped provider-report text; results expose the full output reference and byte count. Three Mod tests cover ownership, live detail rendering and notification behavior; runtime tests cover tool activity, report-tail metadata, current-task interruption on reused-worker log failures, state corruption preservation and prompt launch-error diagnostics.

## Foreground delegation and task context (0.4.0)

Ordinary Claude requests use agents_run, returning results in the tool call with bounded waits and progress. Explicit background requests retain spawn/event notification behavior. Fresh task context is now default; only an explicit agentSessionId resumes a conversation. Cancellation tests cover MCP abort and transport EOF; Mod tests cover parent-turn interruption, no automatic pane, no foreground completion prompt, handled-background-result suppression and numbered paginated inspection. The suite now has 29 offline tests and 6 Mod-host tests.

Workspace identity checks pin canonical paths plus device/inode and reject persisted/queued replacements while allowing intentional outside-directory selections. Checks are not an OS sandbox and cannot eliminate races after validation. Provider permissions are not automatically inherited from Claude; forwarded task instructions and adapter-supported restrictions remain the available boundaries.

## Automatic visibility and formatted inspector (0.4.1)

Automatic inline activity now shows actual tool names/file paths while tasks run, rather than generic status alone. The live inspector follows the public-output tail, can pause for paginated report reading, and uses Claude's native Markdown, Text/Box styling and Button components. Artifact descriptor I/O rejects linked leaves and static linked parent directories; regression fixtures verify unrelated data is neither returned nor modified. Bounded foreground wait expiration is explicitly labeled waitExpired. Current coverage: 33 offline tests and 9 Mod-host tests.

## Worker output navigation (0.4.2)

Active work opens inspection once in interactive sessions when Claude's layout permits. A native View worker output button explicitly opens it at narrow widths and remains as Latest worker output after completion. Closing a pane does not cancel work or cause it to reopen on every poll. All tasks provides task navigation. This is a Mod pane with provider tools/public output, not a native subagent transcript or attached terminal. Ten Mod-host tests now cover navigation, native controls, live output, completion and manual close; 33 runtime tests pass. The skill recognizes same-session and fresh-session intent; runtime defaults for unrelated tasks remain fresh.

## Named history and multiple workers (0.4.4–0.4.5)

Conversations have stable semantic names, including runtime status/list/result metadata. Follow-ups retain their name and expose task history; independent sessions reserve distinct names. The same Claude session restores owned completed history beyond five tasks after reload. A new Claude session retains separate UI/notification ownership while runtime conversations remain available for tool discovery. Current validation: 35 runtime and 14 Mod-host tests, plus installed real Pi same/fresh-session naming and recall. The activity band prioritizes worker headings and offers a counted chooser; the pane shows one selected task.

Model discovery is supported, but a general editable model/settings selector and guided authentication recovery remain unimplemented. See [worker settings](WORKER_SETTINGS.md).

## Navigation workspace (0.5.0)

The inspector has a searchable overview with work previews and persistent native worker/task selection in detail views. Per-task report pages/live mode and per-conversation task selection survive switching, overview visits and same-Claude-session reload. Direct band buttons and adjacent-worker controls reduce navigation steps; new work preserves the reading target. Current validation: 35 runtime tests and 18 Mod-host tests. Scope remains the owning Claude session; other runtime conversations are discoverable through tools, not an automatically merged project-wide UI/notification feed. Exact terminal scroll pixels and painted layout are not covered by component-tree tests. See [navigation model](WORKER_NAVIGATION.md).
