# Harness-Neutral Worker Settings and Updates

## Summary

Agent Bridge provides a human-controlled settings flow for every supported worker harness and preserves those choices across plugin updates. Ordinary users install the plugin, choose trust and provider-advertised session settings once per workspace, and then delegate naturally without editing YAML, copying generated configuration, inspecting daemon PIDs, or restarting project runtimes by hand.

## Problem

Agent Bridge currently snapshots bundled worker configuration into each workspace. Session settings can be applied generically through ACP, but users must edit workspace YAML and restart a daemon to use them. The snapshot also prevents later plugin updates from automatically supplying changed provider definitions or newly supported workers. Repository-controlled configuration can request a permissive mode even though permission expansion must remain a direct user decision.

## Goals

- Make setup and updates harness-neutral; Devin is one supported harness, not a special case.
- Keep provider-advertised option IDs, values, names, descriptions, and categories authoritative.
- Store permission and trust choices in user-owned state outside the repository.
- Regenerate effective runtime configuration from the current plugin on every startup.
- Restart stale idle daemons automatically and defer updates without interrupting active work.
- Preserve advanced explicit configuration and provide a one-time migration path for legacy generated snapshots.
- Keep worker settings inaccessible to model-callable Agent Bridge tools.

## Non-goals

- Guessing that differently named provider modes have equivalent security semantics.
- Guaranteeing editable settings for harnesses that do not advertise ACP config options or legacy modes.
- Editing Claude Code permission settings.
- Moving credentials or secret environment values into the preference store.
- Silently deleting or rewriting an existing `agents.bridge.yaml`.
- Changing specialist behavior, specialist catalogs, task execution semantics, or the once-only `agents_reply` policy.

## Figma

Figma: none provided. The settings surface uses the existing Claude Mod pane components and visual hierarchy.

## Behavior

1. `/workers settings` opens a human-operated settings screen inside the existing Workers pane. Opening settings never starts a model prompt or worker task.

2. The settings screen lists every configured Agent Bridge worker profile, not a hard-coded provider list. Each row shows:
   - Worker profile ID and description.
   - Provider ID.
   - Executable availability.
   - Provider-enforced read-only status.
   - Saved user choices for this workspace.
   - Probe status or a bounded actionable error.

3. Settings are scoped to worker profiles. Two profiles that share one provider can retain different settings and trust choices.

4. Agent Bridge discovers editable settings from the selected harness:
   - Modern ACP `configOptions` are preferred.
   - Legacy ACP modes are shown as a compatible select option when modern mode config is absent.
   - Select groups, booleans, categories, current values, option names, and provider descriptions are preserved.
   - Discovery creates and closes an ACP session but sends no model prompt.

5. Discovery failures are isolated. A missing executable, authentication failure, unsupported ACP method, malformed response, or unavailable account for one profile does not hide or disable other profiles.

6. A harness that advertises no editable options remains usable with its native defaults. The UI states that no editable ACP session settings were advertised and never claims that an option was applied.

7. A direct human selection is required before a provider-advertised session option is saved. Model-callable MCP tools cannot write, change, or approve workspace settings.

8. The settings screen displays provider-owned names and descriptions rather than translating values into universal labels such as “safe” or “autonomous.” Agent Bridge does not infer the privilege level of an unknown provider value.

9. Selecting a value validates it against a fresh probe of the same profile before saving. A removed option, unavailable value, type mismatch, or provider failure produces an error and leaves the previously saved preference unchanged.

10. Saved choices are written outside the repository under the user configuration directory. The preference record is private to the current user and contains:
    - Schema version.
    - Canonical workspace identity.
    - Per-profile session config values.
    - Preserved runtime overrides imported from a legacy generated configuration.
    - Migration/config-source decisions.
    It never contains credentials or inherited environment values.

11. Workspace trust does not transfer by path alone. Replacing a directory at the same path, redirecting it through a symlink, or opening an unrelated directory with a reused name does not reuse another workspace’s saved settings.

12. Repository content cannot silently broaden worker permissions:
    - Session config in ordinary project `agents.bridge.yaml` is treated as a project request, not user approval.
    - Requested values are visible in settings.
    - Only matching user-owned preferences enter the effective runtime config.
    - `AGENT_BRIDGE_CONFIG` remains an explicit advanced operator override and is reported as such.

13. New workspaces use managed plugin defaults. Users do not receive or edit `.agent-bridge/plugin-agents.yaml` as normal configuration.

14. On every plugin bootstrap, Agent Bridge compiles an effective runtime config from:
    1. Current bundled plugin defaults, or an explicit advanced project base when selected.
    2. Safe project configuration fields.
    3. User-owned workspace preferences.
    The compiled file is disposable, private, and reported by diagnostics.

15. Plugin updates automatically contribute new bundled workers, provider command fixes, adapter paths, defaults, and schema additions to managed workspaces. Existing user session choices remain overlaid by profile ID.

16. If a saved profile no longer exists after an update, its preference remains stored but is reported as unavailable. It does not prevent other profiles from running.

17. If a saved option or value is no longer advertised, only that profile fails before prompting. The error names the stale option/value and the currently advertised choices. Other profiles continue to run.

18. Advanced `agents.bridge.yaml` remains supported. The settings screen clearly labels it as an advanced project base whose provider definitions are maintained by the project. A direct “Use managed plugin defaults” action records the choice outside the repository and leaves the project file untouched.

19. A legacy generated `.agent-bridge/plugin-agents.yaml` is detected once:
    - If it matches generated structure and has no provider-level differences from current managed defaults, runtime limits and existing profile session choices are imported automatically into user preferences.
    - If provider command, argument, environment, dependency, or enforcement fields differ, Agent Bridge does not discard them. Settings reports a migration warning and continues using the legacy base until the user directly chooses managed defaults or keeps advanced configuration.
    - The legacy file is never deleted automatically.

20. Diagnostics report configuration provenance without secret values:
    - Bundled defaults path and build ID.
    - Optional project/explicit base.
    - User preference path.
    - Effective config path and digest.
    - Live daemon build ID/config digest/start time.
    - Whether an update or config restart is pending.

21. Every daemon reports a build ID captured when its process started and the digest of its loaded effective config.

22. When a reloaded plugin finds a stale daemon with no nonterminal tasks, it stops and restarts that daemon automatically before serving the next tool call.

23. When a stale daemon has active or queued tasks:
    - Existing status, wait, result, artifact, event, reply, and cancel operations remain available.
    - Existing tasks are not interrupted or replayed.
    - New task dispatch and configuration writes return an actionable update-pending error rather than running under an unexpected version.
    - Once no nonterminal tasks remain, the next bridge operation restarts the daemon automatically.

24. A daemon restart caused by an update or settings change preserves terminal task history and native conversation recovery exactly as an explicit safe restart does.

25. Saving a setting restarts an idle daemon automatically. If work is active, the setting is saved, marked pending, and takes effect automatically after existing work finishes; the UI shows that state.

26. A failed preference validation never stops the current daemon. A failed replacement-daemon startup returns a bounded diagnostic and leaves durable state/artifacts intact; no task is replayed.

27. The CLI provides the same human workflow for environments without Mod controls:
    - Read-only profile/option discovery.
    - Set or clear one profile option after validation.
    - Select managed defaults or retain advanced project configuration.
    - Inspect preference and update state.
    CLI operations use exact profile and option IDs and print structured JSON suitable for automation.

28. Settings choices survive plugin rebuilds, plugin updates, Claude restarts, daemon restarts, and native ACP session recovery without requiring another setup step.

29. Specialist execution composes with worker settings. A plain worker and a specialized worker bound to the same profile receive the same confirmed effective session config.

30. Existing task permissions remain unchanged:
    - Forwarded permission requests still accept only `allow_once` or `reject_once` through `agents_reply`.
    - Read-only enforcement remains a provider-profile capability, not an instruction claim.
    - Agent Bridge does not edit Claude Code allow rules.

31. Existing workspaces with no saved preferences continue to run with provider defaults. The update does not automatically select a permissive mode.

32. Empty, corrupt, oversized, symlinked, identity-mismatched, or unsupported-version preference files fail closed with a recovery diagnostic. Agent Bridge does not silently reset or overwrite the original file.
