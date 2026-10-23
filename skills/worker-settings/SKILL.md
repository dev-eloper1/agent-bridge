---
name: worker-settings
description: Explain or configure Agent Bridge worker models, modes, reasoning, permissions, availability and profile boundaries without guessing provider settings.
argument-hint: "<worker> <model|mode|reasoning|permissions|read-only|profile request>"
---

Handle the worker-settings request without launching work or editing project configuration.

Request: $ARGUMENTS

Agent Bridge settings are profile-scoped, provider-advertised and directly confirmed by the user. For an existing profile, tell the user to open **`/workers settings`**, find that profile and choose the exact model, mode, reasoning or other option advertised by its harness. If the user says not to launch unless a setting is guaranteed, do not launch until they confirm the effective selection.

Never:
- Guess model or mode IDs.
- Treat `agents_list.models: "not discovered"` as proof that a harness lacks model selection.
- Pass model/mode/permission fields to `agents_run` or `agents_spawn`; those tools intentionally have no per-task setting override.
- Edit `agents.bridge.yaml` for an ordinary natural-language settings request.
- Use a specialization to grant a model, tool or permission capability.
- Claim that "reader", "reviewer", "do not edit" or similar instructions enforce read-only access.

Read-only is enforceable only when the selected profile/provider reports `readOnlyEnforced`. If it does not, say plainly that no-edit behavior would be instruction-scoped and coordinator-verified, then offer an actually enforced profile when one is available.

Agent Bridge currently configures existing worker profiles; normal profile creation/cloning is not yet supported. When the user asks for a separate profile such as "Claude Haiku reader", explain this boundary and offer:
1. Configure the existing Claude profile's advertised model in `/workers settings`.
2. Use an enforced read-only profile if read-only is the actual requirement.
3. Discuss advanced `agents.bridge.yaml` profile authoring only when the user explicitly asks for advanced project configuration.

Provider availability and native session health are separate from settings. If a profile is unavailable or its probe fails, report the exact settings-pane error and fix that environment first; never silently launch a different provider.
