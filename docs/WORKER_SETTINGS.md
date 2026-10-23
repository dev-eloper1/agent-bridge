# Worker customization and recovery

The bridge reuses local harnesses and their existing authentication. It controls the task, workspace and process lifecycle; it does not currently expose every harness setting through Claude.

| Control                 | Available now                                                                                                                                         | Boundary                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Harness/provider        | Select a configured profile such as codex-worker or devin-worker                                                                                      | A named conversation is a session of that profile, not a separate CLI installation                          |
| Task instructions       | Scope, project rules, acceptance criteria, review-only instruction                                                                                    | Other CLIs do not automatically inherit Claude's complete conversation or permission configuration          |
| Specializations         | Declarative instructions, provider restrictions, required read-only and acceptance criteria from `.specialists/` catalogs or an inline ephemeral spec | Specializations cannot select provider, model, tools or permissions; they restrict but never grant          |
| Working folder          | Project, existing directory, temporary folder, explicit worktree                                                                                      | Same-conversation follow-ups keep the original folder                                                       |
| Startup settings        | Provider command, argument array, explicit environment and inherited variable allowlist in YAML                                                       | Supported arguments/settings depend on the installed harness                                                |
| Model                   | Discover provider-reported current model and choices; native defaults/startup flags can affect new workers                                            | No universal model-switch tool or panel selector yet; advertised choices do not prove entitlement           |
| Reasoning/mode settings | Trusted `agents.<id>.sessionConfig` applied to provider-advertised ACP session config options after session new/load                                  | Unsupported options/values fail the task before prompting; only values the provider advertises are accepted |
| Tools/extensions/MCP    | Harness configuration; Pi's shipped wrapper enforces read tools and disables extensions/MCP                                                           | Not a universal configurable tool sandbox; arbitrary per-session MCP injection is not exposed               |
| Limits                  | Concurrent tasks, runtime deadline, inline result size, artifact byte budget                                                                          | Provider quotas/billing remain outside the bridge; blocked-on-input time pauses the deadline                |
| Permissions             | Forwarded ACP permission requests block for an explicit once-only decision                                                                            | Harnesses may handle some actions internally without an ACP callback                                        |

Use project `agents.bridge.yaml` for explicit project configuration, or inspect the generated `.agent-bridge/plugin-agents.yaml`. The root checkout's agents.yaml is the template, not a live settings UI for an already initialized project. Startup/config changes require a runtime restart to reload; `node dist/cli.js plugin-doctor` reports resolved config and daemon state without starting it, and `plugin-restart` performs a safe restart only when no nonterminal task exists — it never cancels work. `agents_doctor` (CLI `doctor`) reports the same sanitized live state, including environment variable names as `set`/`unset` and never their values. The bridge fingerprints provider/profile configuration and rejects incompatible conversation reuse rather than silently changing an existing session. Use a fresh conversation after such changes. It does not edit global harness settings on your behalf. Additional specialist catalogs can be declared under `specialistCatalogs:` in the YAML (`<name>: { path: <.specialists root> }`); `project`, `global` and `inline` are reserved names and paths resolve relative to the config file, with `~/` expanded.

`agents.<id>.sessionConfig` is trusted operator configuration, applied in insertion order through ACP `session/set_config_option` (v1 `id` or v2 `configId` selectors, grouped options and booleans) after every session/new or session/load and before the first prompt. Example:

```yaml
agents:
  devin-worker:
    provider: devin
    description: Devin local implementation worker
    workspace: project
    sessionConfig:
      mode: bypass
```

Each key/value is validated against the values the provider actually advertises; unsupported keys or values fail the task before prompting with an actionable error — the bridge never silently claims application. For compatibility, `mode` falls back to `session/set_mode` only when no `mode` config option is advertised and legacy modes advertise the value. The applied result is exposed as `sessionConfig.effective` on tasks and conversations (`requested` mirrors the profile), and `agents_list` shows `configuredSession`. ACP environment/CLI permission settings of a harness may not control its ACP session state; trusted sessionConfig is the reliable mechanism. Use separate profiles for different trust levels rather than per-task escalation: spawn/run inputs deliberately have no sessionConfig field. While a task waits on a permission question, its runtime budget is paused and queued tasks for the same profile stay queued (`queueReason: agent_waiting_for_permission`); other profiles keep scheduling normally. Persistent permission decisions remain forbidden through `agents_reply`.

## Models and provider settings

The bridge normalizes legacy ACP models metadata and modern categorized configOptions for model discovery and applies trusted `sessionConfig` against provider-advertised [session configuration options](https://agentclientprotocol.com/protocol/v1/session-config-options) (select, grouped and boolean values). It still does not offer an interactive settings editor: changes come from deliberately edited profile YAML plus a runtime restart, and unsupported settings stay unavailable rather than masquerading as applied.

Shipped Copilot uses an explicit bridge-local auto model to avoid a previously rejected saved custom model. Other profiles generally use native defaults unless their command/config specifies otherwise. Pi's previously rejected default was fixed by the user in Pi; no global model override was retained by this project.

## Login and errors today

- `available` in worker listings means executable/dependency discovery, not a successful authentication/entitlement check.
- Existing CLI login or explicitly configured credential environment is reused. The bridge does not currently initiate ACP authentication, run an interactive browser login, or offer a guided sign-in/retry panel. ACP defines an [authentication flow](https://agentclientprotocol.com/protocol/v1/authentication), but that is not yet implemented here.
- Protocol errors, process exits, refused/non-success stop reasons, timeouts and artifact limits fail the task with bounded sanitized diagnostics. Other workers can continue. A provider that swallows errors can still make generic handling unreliable: Pi has a specific RPC error guard and Copilot has a guard for its known execution-error output.
- A forwarded permission request is different from a login failure: it becomes a pending question with provider-supplied choices. Claude handles it under the user's authorization/approval rules; no blanket allow-all policy is introduced.
- Cancellation terminates the worker process group. A later explicit follow-up can restore the native conversation when supported. Runtime restart does not replay interrupted prompts; queued tasks remain queued and interrupted tasks fail explicitly.
- Fix authentication in the native CLI, then explicitly ask Claude to retry. A retry is a new task, not an automatic replay of potentially side-effecting work. Resume the old conversation only if its native session exists and remains compatible; otherwise use a fresh conversation and preserve the failed task for inspection.

## Next features

Richer option discovery UI, current model visibility, and actionable login/quota/network diagnostics are planned. Session permission changes stay a trusted-profile decision (`sessionConfig`) separate from model selection and never a per-task escalation path. These features should operate on a named conversation, preserve its history, avoid global settings changes and expose unsupported operations clearly.
