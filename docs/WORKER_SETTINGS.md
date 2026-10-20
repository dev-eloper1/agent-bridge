# Worker customization and recovery

The bridge reuses local harnesses and their existing authentication. It controls the task, workspace and process lifecycle; it does not currently expose every harness setting through Claude.

| Control                 | Available now                                                                                              | Boundary                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Harness/provider        | Select a configured profile such as codex-worker or devin-worker                                           | A named conversation is a session of that profile, not a separate CLI installation                 |
| Task instructions       | Scope, project rules, acceptance criteria, review-only instruction                                         | Other CLIs do not automatically inherit Claude's complete conversation or permission configuration |
| Working folder          | Project, existing directory, temporary folder, explicit worktree                                           | Same-conversation follow-ups keep the original folder                                              |
| Startup settings        | Provider command, argument array, explicit environment and inherited variable allowlist in YAML            | Supported arguments/settings depend on the installed harness                                       |
| Model                   | Discover provider-reported current model and choices; native defaults/startup flags can affect new workers | No universal model-switch tool or panel selector yet; advertised choices do not prove entitlement  |
| Reasoning/mode settings | Harness-native startup configuration where supported                                                       | Full ACP config options are not yet exposed by bridge tools                                        |
| Tools/extensions/MCP    | Harness configuration; Pi's shipped wrapper enforces read tools and disables extensions/MCP                | Not a universal configurable tool sandbox; arbitrary per-session MCP injection is not exposed      |
| Limits                  | Concurrent tasks, runtime deadline, inline result size, artifact byte budget                               | Provider quotas/billing remain outside the bridge                                                  |
| Permissions             | Forwarded ACP permission requests block for an explicit once-only decision                                 | Harnesses may handle some actions internally without an ACP callback                               |

Use project `agents.bridge.yaml` for explicit project configuration, or inspect the generated `.agent-bridge/plugin-agents.yaml`. The root checkout's agents.yaml is the template, not a live settings UI for an already initialized project. Startup/config changes require a runtime restart to reload; stop only after active work is finished or intentionally cancelled. The bridge fingerprints provider/profile configuration and rejects incompatible conversation reuse rather than silently changing an existing session. Use a fresh conversation after such changes. It does not edit global harness settings on your behalf.

## Models and provider settings

The bridge normalizes legacy ACP models metadata and modern categorized configOptions for model discovery. It currently retains model metadata, not a complete editable settings catalog. ACP's [session configuration options](https://agentclientprotocol.com/protocol/v1/session-config-options) can expose models, modes, reasoning levels and provider-specific selectors; the bridge still needs tools and controls to discover all options, validate values and apply settings with provider capability checks. Unsupported settings should remain unavailable instead of claiming a universal control.

Shipped Copilot uses an explicit bridge-local auto model to avoid a previously rejected saved custom model. Other profiles generally use native defaults unless their command/config specifies otherwise. Pi's previously rejected default was fixed by the user in Pi; no global model override was retained by this project.

## Login and errors today

- `available` in worker listings means executable/dependency discovery, not a successful authentication/entitlement check.
- Existing CLI login or explicitly configured credential environment is reused. The bridge does not currently initiate ACP authentication, run an interactive browser login, or offer a guided sign-in/retry panel. ACP defines an [authentication flow](https://agentclientprotocol.com/protocol/v1/authentication), but that is not yet implemented here.
- Protocol errors, process exits, refused/non-success stop reasons, timeouts and artifact limits fail the task with bounded sanitized diagnostics. Other workers can continue. A provider that swallows errors can still make generic handling unreliable: Pi has a specific RPC error guard and Copilot has a guard for its known execution-error output.
- A forwarded permission request is different from a login failure: it becomes a pending question with provider-supplied choices. Claude handles it under the user's authorization/approval rules; no blanket allow-all policy is introduced.
- Cancellation terminates the worker process group. A later explicit follow-up can restore the native conversation when supported. Runtime restart does not replay interrupted prompts; queued tasks remain queued and interrupted tasks fail explicitly.
- Fix authentication in the native CLI, then explicitly ask Claude to retry. A retry is a new task, not an automatic replay of potentially side-effecting work. Resume the old conversation only if its native session exists and remains compatible; otherwise use a fresh conversation and preserve the failed task for inspection.

## Next features

Provider-advertised configuration inspection and session-scoped model/setting changes, current model visibility, and actionable login/quota/network diagnostics are planned. Session permission changes need explicit handling separate from model selection; a settings control must not silently broaden tool access. These features should operate on a named conversation, preserve its history, avoid global settings changes and expose unsupported operations clearly.
