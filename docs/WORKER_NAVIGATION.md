# Worker navigation

The inspector answers three questions: who is working, what are they doing, and how do I get back to the work I was reading?

## Model

A worker is a persistent named conversation. A task is one assignment in that conversation. Output belongs to a task. Completion, new assignments and switching views must not change conversation identity or overwrite earlier output.

The inspector is scoped to work owned by this Claude session, including its restored history. The runtime retains other conversations for explicit tool discovery; this is not yet a project-wide browser of every Claude session's work. UI visibility and background notification ownership remain separate concepts.

## One inspector, two views

The overview is home. It shows all owned conversations most recently touched first, with active/input/finished counts, separate failure/cancellation counts when present, current task descriptions, task counts and bounded work previews. Names are stable. The Find field matches names, task descriptions (including earlier tasks) and status. Clearing search restores the full list. A pending-input shortcut opens the relevant task without answering it.

The detail view shows one selected task's activity and public output. Worker and Task selectors appear before the report, so switching does not require returning through several screens. The Worker selector always includes all owned conversations, even while the overview is filtered. Previous worker/Next worker provide adjacent navigation in the same most-recent-first order. Task selection opens each assignment's own output. Controls are before lengthy output, using native Select/Input/Button/Markdown components rather than a separate UI framework.

The terminal still owns layout, focus and scrolling. Controls belong to every detail view; they are not a custom pinned viewport. Narrow panes wrap/truncate as the native renderer allows. Mobile's current native control table lacks Input/Select, so it keeps worker buttons and the task-history fallback.

## Navigation contract

| Action                          | Result                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `/workers` or All workers       | Open the overview and preserve the selected task's reading state                   |
| Click a worker above the prompt | Open that conversation directly                                                    |
| Pick Worker in the pane         | Restore the conversation's last visited task and its report page/live mode         |
| Pick Task                       | Open that assignment and restore its own report page/live mode                     |
| First visit to a worker         | Open its running/input task, otherwise its latest task                             |
| New task arrives                | Update counts and previews; preserve the person's current view                     |
| Task completes                  | Update status; a live view reads the report from the beginning                     |
| Close and reopen                | Keep work running and retain reading state                                         |
| Reload the same Claude session  | Restore names, history, task selection and report-page state                       |
| Needs input                     | Navigate to a pending task; no approval or model prompt is submitted by navigation |

Report-page state means the bounded artifact page and live/paused setting. It does not claim restoration of exact terminal scroll pixels after resizing. Task index shortcuts and `/workers history` remain for compatibility; normal navigation uses selectors and descriptive names.

## Above the prompt

The band offers direct worker buttons for up to two active conversations, with tool activity when space permits. When idle it disappears, along with the plugin status line. Typing any draft, including a slash command, hides the band and plugin status so native autocomplete has the space and keyboard. Completed reports remain available through `/workers`. While active with an empty composer, All workers is available with the total count and active/input counts; its action is consistently the overview. Small row budgets prioritize direct worker access and the overview over tool detail. Other plugins' band content and surveys retain their existing behavior.

Focus a pane/band by clicking or using Claude's focus chord. Native selectors use arrows to highlight and Enter to open; Tab leaves the selector. Reports no longer autofocus the Worker selector. Back to workers is the initial detail control; `b` returns detail to overview or history to the report. Use Page Up/Page Down to scroll the pane: native controls can use arrows for focus navigation. Esc gives the keyboard back to Claude and leaves the pane open; Close or `q` closes it. Focus-scoped buttons provide `w` for the overview where present, `j`/`k` for next/previous worker, `a` for pending input, `n`/`p` for report pages, `f` for follow/pause and `q` for closing. Not every button is present in every state.

## Validation

Tests exercise actual native selector/input/button handlers, worker switching at 38 columns, restoring separate report pages, same-session reload, task-history selection, new-task arrival while reading, overview previews, attention counts, search without losing picker choices, direct band navigation and a mobile button fallback. These validate component trees and behavior in Claude's Mod host; they do not certify painted terminal pixels or override native layout/focus rules.

## Visual hierarchy (0.5.1)

The worker switcher and counts sit inside a cyan-framed navigation section. Overview entries are padded cards, with a cyan outline and pointer for the last selected conversation. Counts highlight nonzero active/input/failure states. Worker and task picker labels include status symbols; status also retains its text label.

| State       | Symbol | Appearance                                  |
| ----------- | ------ | ------------------------------------------- |
| Running     | ●      | Cyan                                        |
| Queued      | ◷      | Muted                                       |
| Needs input | ◆      | Yellow                                      |
| Finished    | ✓      | Neutral/muted; does not imply passing tests |
| Failed      | ×      | Red                                         |
| Timed out   | ◷      | Red, with explicit timed-out label          |
| Cancelled   | −      | Muted                                       |

Worker navigation/actions have a separate frame; report paging has its own stable row immediately above output, with dimmed boundary controls. Navigation/actions use directional symbols and spacing. Recent activity and report output have bold cyan section headings with space above them; paths, secondary context and completed tool activity are muted. Public output stays in Claude's Markdown renderer. Narrow/short panes reduce optional spacing. Colors use native terminal palette names and do not impose a fixed background; icons and labels convey state without depending on color alone. Native controls retain their own focus/selection behavior.

## Consistent state and quiet composer (0.5.2)

Overview, detail and history are explicit mutually exclusive screens. Selected task and saved reading positions are independent of the screen. All navigation uses one serialized command path. Buttons carry their rendered task/page identity; stale clicks cannot page a different report. Artifact responses are accepted only for the current session, task, offset and request sequence. Closing invalidates pending navigation so a slow read cannot reopen the pane.

The composer draft is only observed as an empty/nonempty flag; it is never rewritten or stored by this UI. Active work continues and events remain durable while controls are hidden. Automatic worker discovery also waits while a draft is present. Native surveys and other plugins retain their own content.

Live verification in the user's VS Code terminal covered Back to overview, Esc returning to the composer, `/relo` autocomplete selection with Down, and native Page Down scrolling a retained Pi report. The original terminal panel size was restored and the test draft cleared. Native arrow behavior is deliberately retained rather than overridden with a custom keyboard framework.
