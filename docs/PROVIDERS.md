# Provider research and live results

**Current addition:** GitHub Copilot CLI 1.0.100 is now included. All seven providers pass conversation continuity and native recovery; six pass scoped coding tests, and Pi passes read-only review. The original six-provider results below remain the baseline.

Validated on this Mac on 2026-10-19 using existing local CLI installations and authentication. All six passed live ACP turns, same-conversation recall and native load after runtime/provider replacement. Five completed a scoped code edit with independent tests; Pi completed read-only review.

## Installed versions and transport choice

| Provider    | Installed CLI tested           | ACP launch/profile                                                                           | Reused adapter license                      |
| ----------- | ------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Pi          | 1.3.0                          | `pi-acp` 0.0.34 → restricted wrapper → `pi --mode rpc`                                       | MIT                                         |
| Codex       | 0.163.0                        | `@agentclientprotocol/codex-acp` 2.2.2 → installed Codex via CODEX_PATH                      | Apache-2.0                                  |
| Claude Code | 2.1.304                        | `@agentclientprotocol/claude-agent-acp` 0.94.0 → installed Claude via CLAUDE_CODE_EXECUTABLE | Apache-2.0                                  |
| OpenCode    | 2.0.32                         | `opencode acp`                                                                               | Native installed CLI; no additional adapter |
| Cursor      | 2026.10.18-ea085cb             | `agent acp`                                                                                  | Native installed CLI; no additional adapter |
| Devin       | 3000.11.92, build 7f4e64980e22 | `devin acp`                                                                                  | Native installed CLI; no additional adapter |

The provider-neutral runtime still uses pinned ACP SDK 2.0.0 stable v1. Adapter dependencies are production dependencies, so production installs retain them. Their internal SDK versions can differ: they communicate across the ACP wire boundary rather than sharing runtime types.

The first milestone's inventory is historical: Devin and Cursor were not visible then. This pass finds the installations under `.local/bin`, OpenCode under `.opencode/bin`, and Pi/Codex under the Node installation. Bare CLI resolution also searches common user bin directories and prefers installed CLIs to npm's dependency `.bin` shadow. Explicit adapter paths remain pinned. No global CLI installs or user configuration files were changed by the bridge.

## Actual test matrix

| Provider    | Initialize/model discovery                               | Two sequential prompts | Same native ID after reload | Independent acceptance check                                            |
| ----------- | -------------------------------------------------------- | ---------------------- | --------------------------- | ----------------------------------------------------------------------- |
| Pi          | Passed; 9 model entries                                  | Passed                 | Passed                      | Read-only inspection proposed correct addition; fixture files unchanged |
| Codex       | Passed; 40 model/effort entries                          | Passed                 | Passed                      | Edited only answer.js; independent node tests passed                    |
| Claude Code | Passed; 13 model entries via config options              | Passed                 | Passed                      | Edited only answer.js; independent node tests passed                    |
| OpenCode    | Passed; 27 model entries via config options              | Passed                 | Passed                      | Edited only answer.js; independent node tests passed                    |
| Cursor      | Passed; 46 model/effort entries                          | Passed                 | Passed                      | Edited only answer.js; independent node tests passed                    |
| Devin       | Passed; 1 account-visible model entry via config options | Passed                 | Passed                      | Edited only answer.js; independent node tests passed                    |

`docs/provider-smoke.json` contains task IDs, versions, timings, selected models where initially reported, native IDs, outcomes, independent test output and temporary artifact paths. Modern configuration-based model discovery was then implemented and independently probed for Claude, OpenCode and Devin in `docs/provider-probes.json`, without model prompts. Counts represent advertised entries, not proof of entitlement for every entry. The live suite used the provider's chosen default, except the temporary Pi workaround described below; the final Pi test uses the user's corrected default.

Observed defaults: final Pi `openai-codex/gpt-5.6-luna`; Codex `gpt-6.1-sol[medium]`; Cursor `default[]`. Separate discovery probes reported Claude `opus`, OpenCode `opencode/minimax-m3.1-flash-free`, and Devin `swe-1-6-slow`. These are observations of this account/configuration at test time, not recommendations or hardcoded universal model IDs.

The coding fixture replaced a throwing `sum(a,b)` stub. The coordinator then ran independent Node assertions for positive, negative and zero inputs, and checked the tracked diff contained only answer.js. These tiny tests establish integration and persistence, not correctness on complex software changes. Dispatch took roughly 8–18 ms in the recorded live suite; model-task durations are recorded separately and are not a general benchmark.

## Compatibility issues found and addressed

1. **npm shadowing Codex.** The adapter brings a compatible Codex dependency. npm prepends its binary directory, which initially selected bundled 0.160.1 instead of installed 0.163.0. Native discovery now prefers the user's installation and CODEX_PATH points to it. Codex was retested successfully with 0.163.0.
2. **Pi's initial default was not entitled.** The account rejected `gpt-5.5`, while pi-acp 0.0.34 reported an ordinary end-turn without text. Only this run's newly created Pi session log was inspected to identify that error; credentials were not printed. A temporary bridge-only model override proved the transport. The user fixed Pi's default; the override was removed and final continuity/recovery/review passed with `openai-codex/gpt-5.6-luna`. The bridge does not edit global Pi settings.
3. **Pi errors swallowed by the adapter.** The thin restricted RPC wrapper detects assistant model-error messages and fails the process rather than accepting an empty successful result. Deterministic tests cover this. Runtime also rejects non-success stop reasons such as refusal instead of marking tasks completed.
4. **Modern model catalogs.** Some providers return categorized `configOptions` instead of the older `models` field. Both forms now normalize to the same bounded roster metadata, including grouped options.
5. **CLI state is outside the repo.** OpenCode, Devin, Pi, Claude and Codex need their normal log/session directories even when model work is in a disposable repo. Live tests ran with access to those directories after workspace sandbox failures; no separate auth files were created or tokens copied into this project.
6. **Pi tool permissions differ.** The adapter's normal local tools do not guarantee a bridge permission callback. Pi is therefore a read-only reviewer with executable extensions and MCP disabled. Writable Pi support was not enabled or claimed.

## Permissions and remaining limits

The live coding tasks did not send ACP permission requests: providers allowed their scoped file edits under their own configuration. This verifies writing in isolated worktrees, not real-provider approval dialogs. Permission/form questions, once-only choices, cancellation, deadlines and crash handling have deterministic mock tests. Live mid-turn cancellation, live elicitation, large-task reliability, automatic coordinator wake-up and quota relief are not established by this suite.

Native session load was exercised after replacing runtime and backend processes. It does not imply an interrupted shell operation can resume or that retrying its side effects is safe. Events remain a polling inbox; no private Claude messaging protocol is used.

## Primary research sources

- [Pi ACP adapter](https://github.com/svkozak/pi-acp): wraps installed Pi RPC, session-map persistence, local-tool limitations and command override; installed 0.0.34 source was inspected.
- [Pi source](https://github.com/earendil-works/pi): installed Pi's help validates read-tool allowlisting, extension/MCP disabling, RPC and model flags.
- [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp): separate stdio adapter with installed-binary override. [OpenAI CLI reference](https://developers.openai.com/codex/cli/reference/) distinguishes native Codex commands from ACP adapter functionality.
- [Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp): SDK-based ACP adapter; installed source confirms CLAUDE_CODE_EXECUTABLE override and modern session configuration.
- [OpenCode ACP documentation](https://opencode.ai/docs/acp/): native ACP support. Installed v2.0.32 help confirms `opencode acp`.
- [Cursor ACP documentation](https://cursor.com/docs/cli/acp): native `agent acp`, session load, updates, permissions and cancellation.
- [Devin CLI reference](https://docs.devin.ai/cli/reference/commands): `devin acp` local mode; installed help distinguishes the separate `--cloud` flag, which was never used.
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk): negotiated capabilities and stable v1 connection/session APIs.

No overlapping orchestration framework was added. Existing adapters, SDK schemas and the original small daemon remain the transport and lifecycle owners. See [architecture](ARCHITECTURE.md) and [usage](USAGE.md).

## GitHub Copilot CLI addition

Installed CLI 1.0.100 exposes native ACP over stdio: `copilot --acp --stdio`. The profile disables automatic CLI update for reproducibility and sets `--model auto` only for bridge sessions. No allow-all permission flags are used. Existing login is reused; tokens are inherited only through the configured names.

The initial saved custom Ollama model was rejected by the ACP route with an execution-error text but a normal end_turn. The bridge now has a configured errorOutputPrefixes guard for that known CLI error shape, covered by a deterministic test. Retesting with the advertised auto model passed initialization/model discovery (two entries), two-turn exact-label recall, native load with the same session ID, a scoped file edit and independent Node tests. Copilot requested permission for the edit; the harness selected allow_once only after checking every location was the explicitly authorized answer.js. Thus Copilot additionally provides a real-provider permission round-trip test, not just a mock test.

Evidence is in provider-smoke.json. The global Copilot model/config was not changed, and no hosted orchestration service was used. [GitHub's ACP reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) documents this native server as public preview; installed help and live tests verify the actual CLI here.
