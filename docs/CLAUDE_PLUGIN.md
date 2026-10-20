# Use external agents inside Claude Code

Start Claude in the project you want to work on, with Agent Bridge installed. Ask for the work naturally:

```text
Use Devin to review this repo without changing files.
Use Codex to fix the retry regression and add a focused test.
Ask Pi to review the changes.
```

Claude delegates, waits, retrieves the result and reports useful findings in the same conversation. You do not need to handle IDs, start another terminal or open the inspector. A compact live block above the prompt identifies the task and shows actual provider-reported tools and file paths, refreshing every two seconds while work runs. Clickable worker names above the prompt open that worker directly; All workers opens the overview. Active work also opens it automatically when the terminal permits; completed workers remain in the overview; the idle band/status are hidden. Closing it does not cancel work or cause polling to reopen it.

## Install or update

Build the checkout once:

```sh
cd /Users/bhushan/Documents/Projects/agent-bridge
npm ci
npm run build
claude plugin install agent-bridge --marketplace /Users/bhushan/Documents/Projects/agent-bridge --scope user
```

To update an installed copy after building:

```sh
claude plugin update agent-bridge@agent-bridge-local --scope user
```

Restart Claude Code or run `/reload-plugins`. Existing project daemons also need restarting to run updated runtime code: `/workers stop` interrupts their active tasks, so finish those tasks first. For development, start Claude with `--plugin-dir /Users/bhushan/Documents/Projects/agent-bridge` from your target folder.

The plugin bundles skills, an MCP server and a Mod. Existing native CLI authentication is reused. It does not change global model settings or enable blanket provider approvals.

## Delegate naturally

| Name           | Worker            | Default behavior                                                   |
| -------------- | ----------------- | ------------------------------------------------------------------ |
| Devin          | `devin-worker`    | Current project folder                                             |
| Codex          | `codex-worker`    | Current project folder                                             |
| Pi             | `pi-reviewer`     | Current project folder, enforced read tools                        |
| Cursor         | `cursor-worker`   | Current project folder                                             |
| OpenCode       | `opencode-worker` | Current project folder                                             |
| GitHub Copilot | `copilot-worker`  | Current project folder; bridge selects its advertised `auto` model |
| Claude         | `claude-worker`   | Separate external Claude conversation; may share coordinator quota |

Direct skill invocation also works:

```text
/agent-bridge:delegate devin review the validation logic without editing files
/agent-bridge:delegate copilot implement the retry fix and its regression test
```

Each unrelated new task starts with fresh context. "Ask Devin to explain finding #2" resumes the conversation for that review when Claude retains its reference. Different tasks do not automatically share conversation history just because they use the same CLI/folder. If the intended prior task is ambiguous, Claude should clarify rather than resume an arbitrary conversation. Native load support determines whether a stopped worker can restore its context; failures are explicit.

## Foreground and background

Ordinary requests use `agents_run`. It dispatches and waits inside one MCP call for up to 45 seconds, returning completed results or an input request. For longer tasks Claude continues waiting with the same task reference. A bounded call timeout does not create a new job. The final answer contains the findings or outcome, rather than a launch receipt. Internal task/session IDs remain available for diagnostics.

Use background work when you want independent parallel activity:

> Have Devin review the API in the background while we work on the UI.

That uses `agents_spawn`. Claude gives a short acknowledgment, then continues. The Mod brings completion or questions to the originating session. Retrieving a terminal result marks it handled for notification purposes; it does not mark the work independently verified. Foreground tasks do not generate background completion prompts.

Cancelling/disconnecting an open foreground call attempts to cancel its task. With the Mod, interrupting the parent turn or ending the session also cancels tracked foreground tasks between bounded calls. Explicit background jobs continue independently. Without Mods, use tools/status for background work; automatic notification delivery and between-call cancellation are unavailable. Abrupt process termination and providers detaching subprocesses are outside orderly cancellation guarantees.

## Choose a workspace only when needed

Workers use the project folder by default, including uncommitted files saved on disk. They do not read unsaved editor buffers. No Git setup is required. Authorized edits are already in this checkout; review them and run relevant checks before accepting the work.

| Request                                  | Workspace                             | Git required? |
| ---------------------------------------- | ------------------------------------- | ------------- |
| "Review this folder"                     | Current project                       | No            |
| "Use Devin in /path/to/research"         | Existing specified folder             | No            |
| "Research this in a temporary folder"    | Fresh private scratch folder          | No            |
| "Implement this in an isolated worktree" | Separate checkout from committed HEAD | Yes           |

Outside-project absolute paths, parent-relative paths and symlink aliases are intentionally supported. Initial directory selections are canonicalized. Conversations pin that directory's canonical path and filesystem identity; revalidation rejects later replacement/redirection. These checks do not provide an OS sandbox or prevent every concurrent filesystem race.

Scratch folders live under `.agent-bridge/scratch/<conversationId>/` and persist for follow-ups. Worktrees are explicitly requested and start at committed HEAD; they do not automatically contain uncommitted main-checkout changes. Review an isolated worker's actual folder/diff before integration. Pi can review another directory when Claude selects it or passes the actual diff.

## Continuing or starting fresh

- "Ask Pi to explain finding 2" and "continue with Pi in the same session" resume that review's conversation.
- "Ask Pi to check the fix" resumes the worker involved in the current discussion.
- "Start a fresh Pi session" or "have Pi review independently" creates a new conversation.

Claude passes the matching agentSessionId internally for follow-ups. A new task in that conversation has its own taskId; continuing to wait on unfinished work uses its existing taskId. If conversation context was lost, Claude can recover recent session references by matching worker, folder and last task description from agents_list. Ambiguous references need clarification. Naming a worker for an unrelated task does not implicitly share its previous context. Resume depends on the provider's native session support; errors are reported rather than silently substituting a fresh session.

## Status, notifications and questions

Normal supervision happens in the conversation. Use the direct worker buttons above the prompt or All workers, then the persistent Worker and Task selectors inside the pane. These commands also work:

```text
/workers          # Named conversation overview
/workers codex-review-repository # Inspect this conversation
/workers history  # Browse earlier tasks in it
/workers codex-review-repository/1 # Read its first report
/workers watch    # Follow an active worker
/workers pause    # Switch to report reading from the beginning
/workers next     # Next public-output page
/workers prev     # Previous page
/workers cancel   # Cancel the selected task
/workers close    # Close the pane without stopping work
```

Claude Code defers unsolicited panes below its width thresholds (144 terminal columns, or 110 once that pane has been requested). Clicking a worker or All workers or running /workers watch is an explicit request and can place it at any width. Explicit navigation requests keyboard focus when Claude permits; automatic opening does not take focus. Focus the pane with a click or Ctrl+X then Tab to use its controls; Escape returns typing to Claude and leaves it open; Close or q closes it. Back to workers (b) returns to the overview. Use Page Up/Page Down to scroll; arrows and Enter operate a focused selector. All workers returns to the named conversation list. These are documented Mod panes, separate from Claude's native subagent transcript list.

The inspector refreshes every two seconds and shows provider-reported tool activity with file paths. Selecting an active task follows its latest public output. On completion it opens the report from the beginning. Pause switches from following live output to report reading; Watch resumes live following. Native buttons and focus-scoped hotkeys provide Follow/Pause, Previous/Next, Cancel and Close. Task headings, status/duration, muted folder context and activity use documented Claude Mod components. Public output uses Claude's native Markdown renderer for lists, code blocks, links and tables, rather than a plain-text dump. Raw byte offsets and artifact IDs stay out of the normal panel. Pages are bounded; there is no automatic replay of a huge transcript into Claude's context. Task IDs and stable numeric shortcuts still work for diagnostics, but normal navigation uses conversation names. Older tasks may lack compact activity history; their artifacts remain available. The pane is not an attached terminal, and a silent provider is not necessarily stuck.

Background completion/input events use Claude's documented prompt API, so they appear as plugin-originated turns. This mechanism applies only to background work. It is not native Anthropic Agent completion delivery. Event ownership is per originating Claude session; viewing another session's task does not subscribe you to its notifications.

For ordinary clarifications, Claude can answer within your instructions. Existing authorization and approval requirements still apply to tool permission requests. Folder choice alone does not make a writable CLI read-only; the shipped Pi profile restricts its tools. Other CLIs retain their own tool/permission settings. Claude must include relevant project rules and task scope in the delegated prompt.

## Review and acceptance

Results include public output from the start of the report. If truncated, Claude reads further pages internally. It checks significant claims before presenting them as confirmed and distinguishes a code-traced hypothesis from a reproduced/tested bug. A worker's "VERIFIED" label is not independent evidence. File modification times alone do not establish that nothing changed.

Claude coordinates shared-folder edits to avoid conflicts. The plugin does not automatically merge, commit or apply isolated-worktree patches. Provider logs and large outputs stay in private project-local artifacts.

## Runtime lifecycle and troubleshooting

The plugin finds the Git project root, or uses the starting folder outside Git. Config selection is explicit `AGENT_BRIDGE_CONFIG`, then project `agents.bridge.yaml`, then generated `.agent-bridge/plugin-agents.yaml`. Long socket paths use a private hashed location under `/tmp`; no localhost TCP port is exposed. Add `.agent-bridge/` to `.gitignore`.

`/workers stop` interrupts active work and stops the project runtime; next delegation starts it again. Runtime restarts preserve recorded history and fail interrupted jobs without replaying side effects. Native conversation load supports explicit follow-ups where the backend advertises it. External Claude workers cannot recursively activate this plugin.

If tools/skills are missing, reload/restart and inspect `/plugin` or `/mcp`. Failed MCP startup can be cached; reconnect after fixing it. Runtime diagnostics are in `.agent-bridge/daemon.log`. Fix authentication/model problems in the native CLI. Only worktree isolation needs Git HEAD.

The agents run externally through Agent Client Protocol; the plugin does not register them as native Anthropic Agent runtimes or add a hidden Claude proxy. A2A agent-service connections remain a [future feature](ROADMAP.md).

See [architecture](ARCHITECTURE.md), [advanced API usage](USAGE.md) and [live foreground evidence](claude-codex-review-smoke.json).

## Stable worker names and history (0.4.4)

Worker names come from the harness and initial task description, for example codex-review-repository. A follow-up keeps that name even when its task description changes; an independent new conversation gets a unique name (a numeric suffix resolves duplicate topics). These names are stored with runtime conversations and exposed in list/status/results, so Claude can match a named follow-up to its internal conversation ID. Names are scoped to this project's bridge state.

The inspector shows one entry per conversation, retaining completed work. Select a name to open its active/latest task. The Task selector lists every task recorded for that conversation in this Claude session and restores its own report page; Task history remains a compatibility command. Direct navigation `/workers <name>/1` opens the first task. Stable numeric shortcuts remain supported, but positions no longer change with activity/completion. Reloading the same Claude session restores its owned history, including older entries beyond the last five. A new Claude session has separate ownership/notifications; the runtime still retains conversations for explicit discovery through Claude's tools.

When multiple tasks are active, the activity band shows their headings before tools and offers a counted Choose worker button. It opens the conversation overview, where each named entry opens its own pane output. The pane displays one selected task; it does not merge two workers' transcripts.

## Navigation workspace (0.5.0)

The overview now shows status/input counts and work previews, with a Find field for names, current/earlier task descriptions and status. A Worker selector is available in overview/history/detail views; it stays complete while search filters overview cards. Detail views have a Task selector plus adjacent-worker controls before the report. Each task remembers its artifact page and live/paused setting, and each conversation remembers its last visited task. New work does not replace the current reading target. All workers consistently returns to overview without forgetting reading position. The band has direct worker buttons and a counted overview button, only while work is active and the composer is empty. Full interaction model and keyboard controls: [Worker navigation](WORKER_NAVIGATION.md).

The 0.5.1 presentation groups navigation and actions into framed sections, uses spaced cyan headings for activity/report content, and displays statuses as both symbols and colored labels. Finished work remains neutral rather than implying successful verification. The overview uses padded worker cards and a selected-worker marker; the activity band has matching status symbols. See the [visual hierarchy](WORKER_NAVIGATION.md#visual-hierarchy-051).
