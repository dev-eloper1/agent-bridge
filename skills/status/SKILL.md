---
name: status
description: Show configured external workers and check Agent Bridge task progress or results inside Claude Code.
argument-hint: "[taskId]"
---

Use Agent Bridge's MCP tools to report external worker status. The runtime starts automatically. If a taskId is supplied, call `agents_status`, and fetch a small `agents_result` if it is terminal. Otherwise call `agents_list` and read a bounded recent `agents_events` batch when useful. Preserve your event cursor and deduplicate eventId. Do not claim an old event is a new completion. For a visual worker pane the user can also run `/workers` when the Mod is enabled.

A task blocked on a permission or input question shows its request and pending command in the `/workers` detail pane with direct Allow once/Reject buttons or a Reply field — if the user is already looking at the pane, point them there; `agents_reply` remains available for model-driven replies. Persistent permission choices still belong in `/workers settings`.

For model, mode, reasoning or permission-setting questions, direct the user to `/workers settings`. Do not infer unsupported settings from `"not discovered"`, guess provider values, edit `agents.bridge.yaml`, or claim that a descriptive profile name enforces read-only behavior. Settings are confirmed by the user in the Mod pane and are not model-callable MCP operations.

Requested task: $ARGUMENTS
