# Integration I1

Branch: `lab/integration`, starting at `447c418`. No delegation, pushes, or manual operations in other worktrees.

## Merge order

Each feature used `git merge --no-ff lab/<name> -m "integrate: <name>"`. Each merge has two parents.

| Order | Feature | Merge commit | Immediate lab removal commit | Post-merge green suite |
| --- | --- | --- | --- | --- |
| 1 | lab/hermetic-tests | 9653651 | 9fecb0e | 139/139 |
| 2 | lab/verify-verdict | e73c65a | 828f9da | 152/152 |
| 3 | lab/handoff-inputs | 9ce6a07 | da4d99d | 160/160 |
| 4 | lab/depends-on | 03c1d11 | f39c554 | 170/170 |

The entire `lab/` directory was removed with `git rm -r lab` and committed immediately after each merge. No `lab/` directory remains.

## Conflicts and integration fixes

There were **no Git conflicts** in any merge, including no `lab/` conflicts. Git automatically combined `src/runtime.ts` for handoff-inputs and depends-on, and `src/store.ts` for depends-on. Both verification and handoff behavior were retained alongside dependency scheduling. There are therefore no textual conflict resolutions to enumerate.

The test gates exposed these integration issues, fixed before proceeding to the next feature:

- `scripts/mock-acp.mjs:260` (25f5503): the first suite initially passed 138/139. The reused-worker stderr-budget test observed `completed` instead of `failed` because ACP stdout completion could arrive before the independent stderr pipe. Keep the deliberate stderr-burst mock prompt active for 100 ms so the existing budget enforcement can observe the burst. The full rerun passed 139/139.
- `test/lab-verify-verdict.test.mjs:25` (320fac8): removing `lab/` exposed fixture creation under its missing parent (`ENOENT`). Move fixtures to `.verify-test-*` in this worktree. At `test/lab-verify-verdict.test.mjs:19`, explicitly establish coordinator context; existing worker-guard tests still opt into the worker marker. The full rerun passed 152/152.
- `test/lab-depends-on.test.mjs:21` (34e87cb): the same removed-parent issue affected dependency fixtures. Move them to `.depends-on-*` in this worktree. The full rerun passed 170/170.

An initial D11 build caught TypeScript's narrowing of the locally assigned `running` status across an async call. `src/runtime.ts:1224` reads the authoritative stored task status when detecting post-completion verification errors; both final builds pass.

## D11 design

- `src/runtime.ts:254`: a dependency is ready only when its task is completed and either it has no verify spec or its verification is passed. Queue reporting (`src/runtime.ts:273`) and scheduling (`src/runtime.ts:1077`) use the same predicate. Completed tasks with pending verification keep dependents queued and consume no dependent execution slot.
- `src/runtime.ts:1043`: failed verification fails queued dependents even when the dependency worker itself completed. The reason includes the dependency task ID, worker status, verification verdict, and verification result reason. Existing propagation handles transitive dependents and unsuccessful worker outcomes.
- `src/runtime.ts:1220`: exceptions after worker completion settle pending verification as failed with reason `error`, persist a verification failure event, and let the scheduler fail dependents. Error details are sanitized and bounded. The error result references retained worker output when verification artifact persistence itself fails.
- `src/lab-verify-verdict.ts:50`: extend verification result reasons with `error` for unexpected verification exceptions; ordinary command failures retain their existing reasons.
- Tasks without a verify spec still release dependents on completed, even though their verification remains pending.

Three new tests in `test/lab-depends-on.test.mjs`:

1. Line 251: passed verification releases the dependent; a spare scheduler slot cannot release it while the completed dependency is pending verification.
2. Line 271: nonzero exit, tampering, missing verifier, and injected verification artifact errors fail dependents with the dependency ID and verification result; transitive dependents fail too.
3. Line 310: no-verify dependencies retain release-on-completed behavior with a pending verdict.

## Final validation

Both commands exited 0 on the final code. Each ran the TypeScript build and the entire test suite.

| Command | Tests | Pass | Fail | Cancelled | Skipped | Todo | Duration (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `env -u AGENT_BRIDGE_WORKER npm test` | 173 | 173 | 0 | 0 | 0 | 0 | 16348.96675 |
| `AGENT_BRIDGE_WORKER=1 npm test` | 173 | 173 | 0 | 0 | 0 | 0 | 16787.272667 |

`git diff --check` also passed. Full final command outputs are recorded below. This review-only file is intended to be removed before merging to main.

<details>
<summary>env -u AGENT_BRIDGE_WORKER npm test</summary>

```text

> agent-bridge@0.5.2 test
> npm run build && node --test test/*.test.mjs


> agent-bridge@0.5.2 build
> tsc -p tsconfig.json

✔ artifact reads and appends reject symlinked task directories (2.508333ms)
✔ artifact I/O rejects hard-linked files and replacement artifact roots (2.093375ms)
✔ descriptor-based artifact I/O preserves append, pagination and byte budgets (1.889167ms)
✔ computeBuildId is deterministic for identical content and order (1.8235ms)
✔ computeBuildId changes when any required module changes (0.582ms)
✔ computeBuildId fails with an actionable error when files are unreadable (0.557541ms)
✔ dashboard binds loopback, requires a capability token and rejects cross-origin/host requests (23.808709ms)
✔ dashboard creates definitions with explicit origin, preserves existing data and renders safe Markdown (36.764625ms)
✔ Markdown rendering escapes raw HTML and refuses unsafe links without executing extensions (0.280042ms)
✔ new workspaces compile managed defaults without creating plugin-agents.yaml (54.366417ms)
✔ project sessionConfig is stripped unless matching user preference exists (88.052542ms)
✔ useManagedDefaults records the choice outside the project file (79.388417ms)
✔ AGENT_BRIDGE_CONFIG remains a trusted explicit base (26.415583ms)
✔ managed defaults track the current bundled config (89.870875ms)
✔ runtime preferences overlay bounded fields only (84.937792ms)
✔ matching legacy generated config imports choices once and uses managed defaults (69.275125ms)
✔ legacy provider differences keep the legacy base with a warning and no env copy (91.719292ms)
✔ a safe legacy import stays managed when bundled defaults change (165.862042ms)
✔ advanced project config resolves root and state inside the workspace (58.242125ms)
✔ an advanced project config keeps an intentional external workspaceRoot (60.876375ms)
✔ nested git directories resolve the repository root (425.414917ms)
✔ a replacement directory at the same path does not reuse preferences (74.177125ms)
✔ a symlinked .agent-bridge directory or effective leaf is rejected (56.779084ms)
✔ native CLI discovery prefers installed binary to npm-bundled shadow and checks execute permission (2.362458ms)
✔ Pi wrapper disables executable extensions and write tools and preserves explicit RPC flags (229.788125ms)
✔ Pi model errors cannot become successful empty ACP turns (223.629542ms)
✔ lab: fan-out/join waits for BOTH mock tasks and starts after completion (1561.166834ms)
✔ lab: mock provider crash fails dependents transitively with dependency IDs (496.685834ms)
✔ lab: cancelling a queued dependency fails its join (230.159125ms)
✔ lab: cancelling a running dependency fails its join (444.669875ms)
✔ lab: unknown dependency rejected atomically; schema validates task IDs (354.143291ms)
✔ lab: dependency wait consumes no slot and does not block unrelated queued work (1212.106ms)
✔ lab: failed dependencies propagate even with all slots occupied (492.559459ms)
✔ lab: delayed queued-cancel wakes dependents without unrelated scheduler activity (634.127334ms)
✔ lab: status explains dependency waits and clears reason after readiness (872.9415ms)
✔ lab: restart preserves queued dependency graph and resumes in dependency order (652.94ms)
✔ D11: passed verification releases dependents only after the verdict (1020.822208ms)
✔ D11: failed, tampered and errored verification fail dependents with the dependency and verdict (1741.159042ms)
✔ D11: dependencies without verify still release on completed with a pending verdict (646.438125ms)
✔ B receives A's output in a fenced untrusted provenance block, maxChars enforced (925.549042ms)
✔ unknown and non-completed sources are rejected at spawn without creating a task (2451.514583ms)
✔ content containing a forged closing delimiter cannot break out (0.247333ms)
✔ combined prompt respects the 16000 prompt cap (0.224042ms)
✔ schema rejects out-of-range maxChars even for a valid completed source (796.308542ms)
✔ fence token comes from the random source (fails if the nonce is constant) (1.148042ms)
✔ forced collision: a token present in the content is rejected and regenerated (0.157125ms)
✔ truncation never splits a surrogate pair (0.13975ms)
✔ X3: mock completes, check passes in task cwd, verdict persists and artifact is exposed (690.151792ms)
✔ X3: nonzero check keeps completed, records exit code and bounded stdout/stderr tail (675.344291ms)
✔ X3: argv is literal, no shell substitution, redirection, or metacharacter execution (525.544375ms)
✔ X3: timeout SIGKILLs check and records failed(timeout), completion stays completed (664.994583ms)
✔ X3: invalid argv/timeouts/extra options rejected; spawn and run expose the same verify schema (0.957708ms)
✔ X3: worker output cannot create or override verify or forge its verdict (850.669916ms)
✔ X3: worker-context callers cannot submit verify; missing executable fails separately (458.996209ms)
✔ X3: actual MCP tools/list advertises verify on spawn/run; worker surface exposes no tools (365.165834ms)
✔ X3: excessive output has a bounded artifact and fails with output_limit (423.321333ms)
✔ X3 repair R1: environment allowlist excludes secrets and worker marker; explicit envNames opts in (777.612208ms)
✔ X3 repair R2: timeout kills sleeping grandchild process group and returns promptly (734.179333ms)
✔ X3 repair R4: worker-style package.json test rewrite is failed(tampered), explicit override records change (648.800084ms)
✔ X3 repair R4: pins lockfiles and recursive test listing plus contents (400.597375ms)
✔ model discovery supports categorized grouped select options without assuming universal model APIs (0.741834ms)
✔ project init works without Git, preserves adapters outside target folder, and never overwrites existing config (26.74775ms)
✔ Claude plugin autostarts one project daemon, reconnects to persistent task, and restarts after daemon death (1673.247209ms)
✔ specialist tools expose .specialists specs through MCP without instructions in listings (538.058333ms)
✔ external Claude worker cannot recursively activate the plugin daemon or delegation tools (155.354666ms)
✔ a stale daemon defers the update while tasks run and restarts once they finish (1311.919708ms)
✔ plugin MCP calls follow a changed effective config to a new socket (799.198166ms)
Unknown agent "nope" (configured: fixture, gone, deps)
Agent Bridge settings cannot change /var/folders/g3/8vwglwy12f14n12g0hb_hyvh0000gn/T/ab-plugin-explicit-IFVIrs/trusted.yaml: it is an explicit operator-managed config (AGENT_BRIDGE_CONFIG). Edit that file directly; workspace preferences are ignored for it.
Agent Bridge settings cannot change /var/folders/g3/8vwglwy12f14n12g0hb_hyvh0000gn/T/ab-plugin-explicit-IFVIrs/trusted.yaml: it is an explicit operator-managed config (AGENT_BRIDGE_CONFIG). Edit that file directly; workspace preferences are ignored for it.
Agent Bridge settings cannot change /var/folders/g3/8vwglwy12f14n12g0hb_hyvh0000gn/T/ab-plugin-explicit-IFVIrs/trusted.yaml: it is an explicit operator-managed config (AGENT_BRIDGE_CONFIG). Edit that file directly; workspace preferences are ignored for it.
✔ plugin-settings reports provenance, probes and a preferences path before save (721.501083ms)
✔ plugin-settings returns probes with a bounded readiness error when the daemon cannot start (302.8995ms)
✔ plugin-settings with an unknown profile fails before starting a daemon (215.730167ms)
Session option "mode" must be one of: ask, bypass
Session option "not-an-option" is not advertised (available: mode, review, telemetry)
Unknown agent "ghost" (configured: demo, devin-worker, cursor-worker, codex-worker, claude-worker, opencode-worker, pi-reviewer, copilot-worker)
✔ an explicit AGENT_BRIDGE_CONFIG is read-only for settings operations (921.265916ms)
Cannot configure "gone": provider is unavailable (Provider executable unavailable: nonexistent-agent-bridge-binary)
Cannot configure "deps": provider is unavailable (Missing provider dependencies: nonexistent-agent-bridge-dep)
✔ plugin-configure validates, saves and clears without changing bytes on failure (2465.697125ms)
✔ plugin-configure refuses unavailable advanced profiles without spawning them (358.866667ms)
✔ plugin-configure saves while tasks run and reports update_pending (873.563792ms)
✔ plugin-migrate-managed switches bases without touching source files (1345.919334ms)
✔ preferences save and load atomically under the user config directory (23.945916ms)
✔ identity mismatch, unsupported fields and corrupt files fail closed with the original preserved (28.433833ms)
✔ symlinked leaf or ancestors are rejected on load and save (22.792ms)
✔ insecure directories and leaves are rejected (19.52675ms)
✔ a symlinked config home is rejected on load and save (10.870083ms)
✔ a failed save cleans up its temporary file (41.650916ms)
✔ save over an insecure or non-regular leaf rejects and preserves it (45.975625ms)
✔ repeated saves replace the file atomically and keep it private (71.74375ms)
✔ save writes private files and rejects mismatched records (15.117ms)
✔ configured session options apply on new and loaded sessions, and bypass avoids the permission question (1815.956334ms)
✔ grouped select, boolean and mode options apply in insertion order (1032.630334ms)
✔ an unconfirmed set_config_option response fails before prompting (251.720375ms)
✔ unsupported or unadvertised session config fails before prompting (920.096291ms)
✔ spawn schema rejects dynamic sessionConfig escalation (92.951875ms)
✔ permission question exposes a bounded sanitized toolCall and allow_session stays refused (725.135958ms)
✔ a reply after an exhausted budget times out without emitting task.replied (375.922208ms)
✔ blocked time does not consume the runtime budget (1940.628792ms)
✔ a permission-blocked profile queues same-agent work while other profiles still run (1097.849291ms)
✔ agents_wait returns the lean bounded task shape (301.03975ms)
✔ doctor reports sanitized configuration without environment values (40.825958ms)
Refusing to restart: 1 nonterminal task(s) still active (task_729cac72-121b-4961-ae18-3aff532187eb). Cancel or finish them first; plugin-restart never cancels work.
✔ plugin doctor reports reachability and restart refuses while work is active (1437.865042ms)
✔ plugin doctor flags a live daemon that predates the doctor method (210.726375ms)
✔ direct CLI doctor works through the generic runtime path (481.857209ms)
✔ config digest is stable for identical resolved config and differs on change (2.647416ms)
✔ ensureRuntime reuses matching, restarts stale idle, and replaces doctorless daemons (548.151542ms)
✔ a doctorless legacy daemon is replaced as stale (276.959625ms)
✔ a stale daemon with active work defers updates then restarts once terminal (442.970583ms)
✔ config validates multiple providers and fails closed on exploration claims (36.269791ms)
✔ internal agents are hidden from list but still run directly (586.634959ms)
✔ background question/reply, bounded results, continuity, steering, inbox replay and durable load (1617.761083ms)
✔ serial ownership, concurrency, cancel, runtime deadline and provider death (2137.615667ms)
✔ worktree isolation, explicit permission options and read-only denial (923.886708ms)
✔ unsupported recovery fails without silently replacing conversation; budget is terminal (761.117042ms)
✔ actual daemon crash preserves history/queue and MCP reconnect does not own workers (1071.077125ms)
✔ non-success backend stop reasons do not report task completion (252.498666ms)
✔ configured provider execution-error output cannot masquerade as successful end_turn (193.824ms)
✔ project default runs in a non-Git folder; isolated worktrees are explicit and never silently fall back (588.074625ms)
✔ workspace selection isolates conversations, serializes one worker, and restores native context on folder switches (860.879292ms)
✔ temporary folders need no Git, remain distinct, and resume the same workspace after runtime restart (930.057792ms)
✔ live status exposes bounded tool activity and public output; terminal events do not contain report fragments (347.398416ms)
✔ stderr budget failure on a reused worker interrupts the current task, not the previous task (315.01125ms)
✔ persisted conversations reject directory replacement after runtime restart without launching a worker (662.744834ms)
✔ workspace identity is pinned at dispatch and detects replacement while a task waits in the queue (96.944292ms)
✔ unrelated tasks in the same folder get fresh context while explicit follow-ups restore the original conversation (715.711375ms)
✔ foreground MCP call returns report from the beginning, supports exact continuation and cancels on caller abort (2815.998542ms)
✔ disconnecting an in-flight foreground MCP call cancels its worker; background lifetime remains independent (275.100542ms)
✔ artifact symlinks cannot redirect reads or appends to another file (251.698208ms)
✔ semantic conversation names persist across follow-ups, restart and legacy migration without losing reports (652.4385ms)
✔ modern ids, configIds, grouped choices, booleans, categories and order normalize (0.877667ms)
✔ legacy modes normalize only when no modern mode option exists (0.129833ms)
✔ malformed options and choices are skipped without discarding the catalog (1.159042ms)
✔ options are only accepted with real state and IDs dedupe first-wins (0.122625ms)
✔ legacy mode requires a valid current mode among its choices (0.095875ms)
✔ bounds drop oversized fields and cap option and choice counts (0.203708ms)
✔ validateSessionSetting enforces exact option, value and type (0.352458ms)
✔ catalog roots cover project, global and configured paths; reserved names fail (22.802042ms)
✔ project and configured specialists resolve; ambiguity and path mismatch fail closed (63.795375ms)
✔ redirected, oversized, malformed and unknown-field specialists fail closed without hiding valid entries (144.915083ms)
✔ binding validation rejects incompatible providers and unenforced read-only (22.213666ms)
✔ catalog lists, queries, inspects and reports binding compatibility (86.072916ms)
✔ schema returns the authoring contract, actual catalog roots and validate writes nothing (82.909291ms)
✔ inline specialistSpec validates to an inline snapshot (0.252875ms)
✔ specialistRef execution pins the spec, merges criteria and survives edits and restart (1121.623125ms)
✔ inline specialistSpec executes, pins and survives restart without touching the filesystem (917.087875ms)
✔ exactly one of template, specialistRef and specialistSpec is accepted (57.880292ms)
✔ listing stays bounded at one hundred specialist directories per catalog (436.934041ms)
✔ specialize skill encodes the approved authoring contract (0.253583ms)
✔ invalid or truncated state fails with a recovery diagnostic and preserves original bytes (31.323333ms)
✔ daemon spawn errors report their cause promptly rather than an eight-second generic timeout (19.445ms)
✔ saved definitions refuse ambiguous project/global names and create never overwrites (59.127584ms)
✔ definition validation rejects executable fields, traversal and redirected files/directories (77.794042ms)
✔ required provider/tool restrictions fail closed instead of degrading into instructions (62.58475ms)
✔ task-instruction definitions persist immutable context through edits, deletion and native reload (1080.652792ms)
✔ experimental native system append reaches new and load requests with no user-message substitution (940.215833ms)
✔ a required system prompt fails before native session creation on an unsupported backend (332.697792ms)
✔ up-to-date clean main runs install/build/update without merging (1.091833ms)
✔ behind dirty main warns, fast-forwards once and reports changed (0.290708ms)
✔ non-main refuses before fetch, merge or npm (0.560708ms)
✔ ahead-only and diverged local main refuse before merge or npm (0.174417ms)
✔ a failed ff-only merge propagates and stops before npm (0.270292ms)
✔ missing npm and claude fail with actionable errors (1.212416ms)
✔ missing plugin prints the exact install command and never updates (0.269833ms)
✔ plugin missing or disabled after update fails (0.455875ms)
✔ Node engine warnings: 20 warns, 24 silent, malformed warns (0.261083ms)
✔ command errors are bounded, name the command and redact secrets (0.217625ms)
✔ nodeMajor parses versions and rejects malformed input (0.057417ms)
✔ pluginBlock extracts only the named plugin's entry (0.074834ms)
✔ malformed rev-list and HEAD output refuse before merge and npm (0.858125ms)
✔ probe reports normalized options without prompting and kills the worker (188.927541ms)
✔ probeAll skips internal profiles while direct probe still works (361.449875ms)
✔ legacy harnesses surface a legacy_mode option (137.923583ms)
✔ unavailable executables, missing dependencies and handshake failures stay isolated (85.5305ms)
✔ a hung provider times out bounded and is always killed (301.323541ms)
✔ configured and inherited env values are redacted from errors regardless of key name (35.391209ms)
✔ probeAll preserves config order and isolates per-profile failures (201.553416ms)
✔ outside absolute paths, parent traversal and initial symlink aliases are intentional directory selections (3.213541ms)
✔ workspace identity rejects both a symlink redirection and a new directory at the same canonical path (1.970208ms)
✔ workspace verification rejects a directory replaced with a regular file (1.836292ms)
ℹ tests 173
ℹ suites 0
ℹ pass 173
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 16348.96675
```

</details>

<details>
<summary>AGENT_BRIDGE_WORKER=1 npm test</summary>

```text

> agent-bridge@0.5.2 test
> npm run build && node --test test/*.test.mjs


> agent-bridge@0.5.2 build
> tsc -p tsconfig.json

✔ artifact reads and appends reject symlinked task directories (4.090125ms)
✔ artifact I/O rejects hard-linked files and replacement artifact roots (1.711167ms)
✔ descriptor-based artifact I/O preserves append, pagination and byte budgets (2.879875ms)
✔ computeBuildId is deterministic for identical content and order (1.174666ms)
✔ computeBuildId changes when any required module changes (0.22125ms)
✔ computeBuildId fails with an actionable error when files are unreadable (0.226291ms)
✔ dashboard binds loopback, requires a capability token and rejects cross-origin/host requests (29.875792ms)
✔ dashboard creates definitions with explicit origin, preserves existing data and renders safe Markdown (42.070375ms)
✔ Markdown rendering escapes raw HTML and refuses unsafe links without executing extensions (0.299334ms)
✔ new workspaces compile managed defaults without creating plugin-agents.yaml (64.720792ms)
✔ project sessionConfig is stripped unless matching user preference exists (139.138542ms)
✔ useManagedDefaults records the choice outside the project file (102.28025ms)
✔ AGENT_BRIDGE_CONFIG remains a trusted explicit base (29.225417ms)
✔ managed defaults track the current bundled config (76.106625ms)
✔ runtime preferences overlay bounded fields only (61.421417ms)
✔ matching legacy generated config imports choices once and uses managed defaults (95.404917ms)
✔ legacy provider differences keep the legacy base with a warning and no env copy (105.563125ms)
✔ a safe legacy import stays managed when bundled defaults change (177.225375ms)
✔ advanced project config resolves root and state inside the workspace (56.837625ms)
✔ an advanced project config keeps an intentional external workspaceRoot (70.036458ms)
✔ nested git directories resolve the repository root (483.031041ms)
✔ a replacement directory at the same path does not reuse preferences (81.078125ms)
✔ a symlinked .agent-bridge directory or effective leaf is rejected (81.759375ms)
✔ native CLI discovery prefers installed binary to npm-bundled shadow and checks execute permission (5.126375ms)
✔ Pi wrapper disables executable extensions and write tools and preserves explicit RPC flags (257.554166ms)
✔ Pi model errors cannot become successful empty ACP turns (231.407166ms)
✔ lab: fan-out/join waits for BOTH mock tasks and starts after completion (1738.201209ms)
✔ lab: mock provider crash fails dependents transitively with dependency IDs (567.182375ms)
✔ lab: cancelling a queued dependency fails its join (173.943292ms)
✔ lab: cancelling a running dependency fails its join (517.117ms)
✔ lab: unknown dependency rejected atomically; schema validates task IDs (391.918875ms)
✔ lab: dependency wait consumes no slot and does not block unrelated queued work (1250.307834ms)
✔ lab: failed dependencies propagate even with all slots occupied (509.161166ms)
✔ lab: delayed queued-cancel wakes dependents without unrelated scheduler activity (566.204416ms)
✔ lab: status explains dependency waits and clears reason after readiness (931.592459ms)
✔ lab: restart preserves queued dependency graph and resumes in dependency order (602.942334ms)
✔ D11: passed verification releases dependents only after the verdict (1058.632375ms)
✔ D11: failed, tampered and errored verification fail dependents with the dependency and verdict (1764.16175ms)
✔ D11: dependencies without verify still release on completed with a pending verdict (603.410833ms)
✔ B receives A's output in a fenced untrusted provenance block, maxChars enforced (1065.559375ms)
✔ unknown and non-completed sources are rejected at spawn without creating a task (2542.14875ms)
✔ content containing a forged closing delimiter cannot break out (0.225542ms)
✔ combined prompt respects the 16000 prompt cap (0.149833ms)
✔ schema rejects out-of-range maxChars even for a valid completed source (761.555083ms)
✔ fence token comes from the random source (fails if the nonce is constant) (1.066875ms)
✔ forced collision: a token present in the content is rejected and regenerated (0.134166ms)
✔ truncation never splits a surrogate pair (0.138209ms)
✔ X3: mock completes, check passes in task cwd, verdict persists and artifact is exposed (775.433166ms)
✔ X3: nonzero check keeps completed, records exit code and bounded stdout/stderr tail (723.923375ms)
✔ X3: argv is literal, no shell substitution, redirection, or metacharacter execution (649.1435ms)
✔ X3: timeout SIGKILLs check and records failed(timeout), completion stays completed (627.633417ms)
✔ X3: invalid argv/timeouts/extra options rejected; spawn and run expose the same verify schema (1.008208ms)
✔ X3: worker output cannot create or override verify or forge its verdict (888.926542ms)
✔ X3: worker-context callers cannot submit verify; missing executable fails separately (514.480209ms)
✔ X3: actual MCP tools/list advertises verify on spawn/run; worker surface exposes no tools (407.256542ms)
✔ X3: excessive output has a bounded artifact and fails with output_limit (461.360083ms)
✔ X3 repair R1: environment allowlist excludes secrets and worker marker; explicit envNames opts in (791.521458ms)
✔ X3 repair R2: timeout kills sleeping grandchild process group and returns promptly (760.81ms)
✔ X3 repair R4: worker-style package.json test rewrite is failed(tampered), explicit override records change (647.254583ms)
✔ X3 repair R4: pins lockfiles and recursive test listing plus contents (444.169416ms)
✔ model discovery supports categorized grouped select options without assuming universal model APIs (0.7895ms)
✔ project init works without Git, preserves adapters outside target folder, and never overwrites existing config (31.45325ms)
✔ Claude plugin autostarts one project daemon, reconnects to persistent task, and restarts after daemon death (1866.31925ms)
✔ specialist tools expose .specialists specs through MCP without instructions in listings (569.666ms)
✔ external Claude worker cannot recursively activate the plugin daemon or delegation tools (169.426459ms)
✔ a stale daemon defers the update while tasks run and restarts once they finish (1366.8385ms)
✔ plugin MCP calls follow a changed effective config to a new socket (830.607209ms)
Unknown agent "nope" (configured: fixture, gone, deps)
Agent Bridge settings cannot change /var/folders/g3/8vwglwy12f14n12g0hb_hyvh0000gn/T/ab-plugin-explicit-uKBVzR/trusted.yaml: it is an explicit operator-managed config (AGENT_BRIDGE_CONFIG). Edit that file directly; workspace preferences are ignored for it.
Agent Bridge settings cannot change /var/folders/g3/8vwglwy12f14n12g0hb_hyvh0000gn/T/ab-plugin-explicit-uKBVzR/trusted.yaml: it is an explicit operator-managed config (AGENT_BRIDGE_CONFIG). Edit that file directly; workspace preferences are ignored for it.
Agent Bridge settings cannot change /var/folders/g3/8vwglwy12f14n12g0hb_hyvh0000gn/T/ab-plugin-explicit-uKBVzR/trusted.yaml: it is an explicit operator-managed config (AGENT_BRIDGE_CONFIG). Edit that file directly; workspace preferences are ignored for it.
✔ plugin-settings reports provenance, probes and a preferences path before save (749.25ms)
✔ plugin-settings returns probes with a bounded readiness error when the daemon cannot start (301.697541ms)
✔ plugin-settings with an unknown profile fails before starting a daemon (197.702083ms)
Session option "mode" must be one of: ask, bypass
Session option "not-an-option" is not advertised (available: mode, review, telemetry)
Unknown agent "ghost" (configured: demo, devin-worker, cursor-worker, codex-worker, claude-worker, opencode-worker, pi-reviewer, copilot-worker)
✔ an explicit AGENT_BRIDGE_CONFIG is read-only for settings operations (1035.748209ms)
Cannot configure "gone": provider is unavailable (Provider executable unavailable: nonexistent-agent-bridge-binary)
Cannot configure "deps": provider is unavailable (Missing provider dependencies: nonexistent-agent-bridge-dep)
✔ plugin-configure validates, saves and clears without changing bytes on failure (2564.814833ms)
✔ plugin-configure refuses unavailable advanced profiles without spawning them (385.121209ms)
✔ plugin-configure saves while tasks run and reports update_pending (885.3575ms)
✔ plugin-migrate-managed switches bases without touching source files (1418.960292ms)
✔ preferences save and load atomically under the user config directory (25.698834ms)
✔ identity mismatch, unsupported fields and corrupt files fail closed with the original preserved (22.987917ms)
✔ symlinked leaf or ancestors are rejected on load and save (18.10675ms)
✔ insecure directories and leaves are rejected (16.340083ms)
✔ a symlinked config home is rejected on load and save (2.65225ms)
✔ a failed save cleans up its temporary file (14.001625ms)
✔ save over an insecure or non-regular leaf rejects and preserves it (22.848417ms)
✔ repeated saves replace the file atomically and keep it private (70.072459ms)
✔ save writes private files and rejects mismatched records (2.348709ms)
✔ configured session options apply on new and loaded sessions, and bypass avoids the permission question (2104.942125ms)
✔ grouped select, boolean and mode options apply in insertion order (1037.697625ms)
✔ an unconfirmed set_config_option response fails before prompting (249.919625ms)
✔ unsupported or unadvertised session config fails before prompting (893.966ms)
✔ spawn schema rejects dynamic sessionConfig escalation (192.903208ms)
✔ permission question exposes a bounded sanitized toolCall and allow_session stays refused (558.068708ms)
✔ a reply after an exhausted budget times out without emitting task.replied (461.776625ms)
✔ blocked time does not consume the runtime budget (1943.086708ms)
✔ a permission-blocked profile queues same-agent work while other profiles still run (1178.976167ms)
✔ agents_wait returns the lean bounded task shape (317.972583ms)
✔ doctor reports sanitized configuration without environment values (27.824708ms)
Refusing to restart: 1 nonterminal task(s) still active (task_54cf4852-01bb-4e2d-9ede-0c47d95fff80). Cancel or finish them first; plugin-restart never cancels work.
✔ plugin doctor reports reachability and restart refuses while work is active (1604.564916ms)
✔ plugin doctor flags a live daemon that predates the doctor method (219.199375ms)
✔ direct CLI doctor works through the generic runtime path (525.991459ms)
✔ config digest is stable for identical resolved config and differs on change (5.841584ms)
✔ ensureRuntime reuses matching, restarts stale idle, and replaces doctorless daemons (546.045666ms)
✔ a doctorless legacy daemon is replaced as stale (356.215666ms)
✔ a stale daemon with active work defers updates then restarts once terminal (595.713708ms)
✔ config validates multiple providers and fails closed on exploration claims (25.282834ms)
✔ internal agents are hidden from list but still run directly (628.890875ms)
✔ background question/reply, bounded results, continuity, steering, inbox replay and durable load (1779.449834ms)
✔ serial ownership, concurrency, cancel, runtime deadline and provider death (2158.903208ms)
✔ worktree isolation, explicit permission options and read-only denial (957.996625ms)
✔ unsupported recovery fails without silently replacing conversation; budget is terminal (827.35875ms)
✔ actual daemon crash preserves history/queue and MCP reconnect does not own workers (1099.542083ms)
✔ non-success backend stop reasons do not report task completion (230.916833ms)
✔ configured provider execution-error output cannot masquerade as successful end_turn (211.966167ms)
✔ project default runs in a non-Git folder; isolated worktrees are explicit and never silently fall back (685.9435ms)
✔ workspace selection isolates conversations, serializes one worker, and restores native context on folder switches (812.944375ms)
✔ temporary folders need no Git, remain distinct, and resume the same workspace after runtime restart (918.3725ms)
✔ live status exposes bounded tool activity and public output; terminal events do not contain report fragments (308.591583ms)
✔ stderr budget failure on a reused worker interrupts the current task, not the previous task (310.8305ms)
✔ persisted conversations reject directory replacement after runtime restart without launching a worker (658.976542ms)
✔ workspace identity is pinned at dispatch and detects replacement while a task waits in the queue (108.9745ms)
✔ unrelated tasks in the same folder get fresh context while explicit follow-ups restore the original conversation (762.147458ms)
✔ foreground MCP call returns report from the beginning, supports exact continuation and cancels on caller abort (2809.121416ms)
✔ disconnecting an in-flight foreground MCP call cancels its worker; background lifetime remains independent (271.336792ms)
✔ artifact symlinks cannot redirect reads or appends to another file (264.664083ms)
✔ semantic conversation names persist across follow-ups, restart and legacy migration without losing reports (665.302542ms)
✔ modern ids, configIds, grouped choices, booleans, categories and order normalize (0.870208ms)
✔ legacy modes normalize only when no modern mode option exists (0.148458ms)
✔ malformed options and choices are skipped without discarding the catalog (1.030042ms)
✔ options are only accepted with real state and IDs dedupe first-wins (0.26825ms)
✔ legacy mode requires a valid current mode among its choices (0.198167ms)
✔ bounds drop oversized fields and cap option and choice counts (0.439375ms)
✔ validateSessionSetting enforces exact option, value and type (0.750375ms)
✔ catalog roots cover project, global and configured paths; reserved names fail (18.481541ms)
✔ project and configured specialists resolve; ambiguity and path mismatch fail closed (84.2405ms)
✔ redirected, oversized, malformed and unknown-field specialists fail closed without hiding valid entries (151.2435ms)
✔ binding validation rejects incompatible providers and unenforced read-only (25.42625ms)
✔ catalog lists, queries, inspects and reports binding compatibility (79.614ms)
✔ schema returns the authoring contract, actual catalog roots and validate writes nothing (89.747ms)
✔ inline specialistSpec validates to an inline snapshot (0.271667ms)
✔ specialistRef execution pins the spec, merges criteria and survives edits and restart (1266.597875ms)
✔ inline specialistSpec executes, pins and survives restart without touching the filesystem (887.890125ms)
✔ exactly one of template, specialistRef and specialistSpec is accepted (82.949708ms)
✔ listing stays bounded at one hundred specialist directories per catalog (107.405084ms)
✔ specialize skill encodes the approved authoring contract (0.281ms)
✔ invalid or truncated state fails with a recovery diagnostic and preserves original bytes (49.248ms)
✔ daemon spawn errors report their cause promptly rather than an eight-second generic timeout (20.48ms)
✔ saved definitions refuse ambiguous project/global names and create never overwrites (81.647958ms)
✔ definition validation rejects executable fields, traversal and redirected files/directories (104.478792ms)
✔ required provider/tool restrictions fail closed instead of degrading into instructions (55.284792ms)
✔ task-instruction definitions persist immutable context through edits, deletion and native reload (1261.60925ms)
✔ experimental native system append reaches new and load requests with no user-message substitution (1049.81575ms)
✔ a required system prompt fails before native session creation on an unsupported backend (317.889625ms)
✔ up-to-date clean main runs install/build/update without merging (1.132208ms)
✔ behind dirty main warns, fast-forwards once and reports changed (0.295666ms)
✔ non-main refuses before fetch, merge or npm (0.561709ms)
✔ ahead-only and diverged local main refuse before merge or npm (0.181209ms)
✔ a failed ff-only merge propagates and stops before npm (0.26925ms)
✔ missing npm and claude fail with actionable errors (1.693458ms)
✔ missing plugin prints the exact install command and never updates (0.24375ms)
✔ plugin missing or disabled after update fails (0.380541ms)
✔ Node engine warnings: 20 warns, 24 silent, malformed warns (0.264375ms)
✔ command errors are bounded, name the command and redact secrets (0.206ms)
✔ nodeMajor parses versions and rejects malformed input (0.059041ms)
✔ pluginBlock extracts only the named plugin's entry (0.073166ms)
✔ malformed rev-list and HEAD output refuse before merge and npm (0.292459ms)
✔ probe reports normalized options without prompting and kills the worker (201.478625ms)
✔ probeAll skips internal profiles while direct probe still works (380.855125ms)
✔ legacy harnesses surface a legacy_mode option (135.156417ms)
✔ unavailable executables, missing dependencies and handshake failures stay isolated (82.814417ms)
✔ a hung provider times out bounded and is always killed (310.46875ms)
✔ configured and inherited env values are redacted from errors regardless of key name (19.060875ms)
✔ probeAll preserves config order and isolates per-profile failures (213.443542ms)
✔ outside absolute paths, parent traversal and initial symlink aliases are intentional directory selections (2.471208ms)
✔ workspace identity rejects both a symlink redirection and a new directory at the same canonical path (3.175084ms)
✔ workspace verification rejects a directory replaced with a regular file (1.022542ms)
ℹ tests 173
ℹ suites 0
ℹ pass 173
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 16787.272667
```

</details>

# I2

Branch: `lab/integration`, starting at `9057ded`. Work stayed in the current integration worktree, without delegation or pushes. All three requested merges completed within the nine-minute limit.

## Merge order and test gates

| Order | Feature | `--no-ff` merge (two parents) | Immediate lab removal commit | Green post-merge coordinator suite |
| --- | --- | --- | --- | --- |
| 1 | `lab/lineage-labels` | `3043daf` | `af68db3` | 178/178 |
| 2 | `lab/budget-pools` | `b23572b` | `823d91c` | 184/184 |
| 3 | `lab/trigger-to-task` | `20ab36f` | `d26e67f` | 198/198 |

Each merge was followed immediately by a commit removing the entire `lab/` directory with `git rm -r lab`. The lineage fixtures already used the system temporary directory. Budget fixtures moved to `.budget-pools-*` (`test/lab-budget-pools.test.mjs:40`); preference fixtures moved to `.budget-prefs-*` (`test/lab-budget-pools.test.mjs:255`). Trigger fixtures moved to `.trigger-test-*` (`test/lab-trigger-to-task.test.mjs:10`), all outside `lab/`.

The first budget test gate was red (183/184): a second fixture prefix, `lab/.budget-prefs-*`, still required the removed parent. Commit `7e15d70` relocated it; the full gate then passed 184/184 before the trigger merge began. No later feature merge proceeded past a red suite.

## Every textual conflict resolution

References below use final I2 source line numbers.

Lineage merge (`3043daf`), three conflict blocks:

- `src/runtime.ts:134`: retain the full existing `inputsFrom` handoff schema and append `labels` and `parentTaskId` at lines 145–146. Existing dependency and verification schemas remain intact.
- `src/runtime.ts:943`: retain `dependsOn` in each new task and also persist deduplicated labels and the parent task ID at lines 944–945.
- `src/store.ts:71`: retain dependency IDs and add both lineage fields at lines 72–73. Persisted lineage validation at `src/store.ts:178`, self-parent rejection, and the passed/failed verification enum at `src/store.ts:174` all survive.

Budget merge (`b23572b`), six conflict blocks:

- `src/runtime.ts:111`: preserve `dependsOn` and append `budgetLabel` at line 118; verification, handoff and lineage inputs remain available together.
- `src/runtime.ts:778`: keep atomic unknown-dependency rejection and then validate configured task-budget existence/exhaustion at line 781. Existing task-key retry lookup precedes both, so retries do not spend budget again.
- `src/runtime.ts:943`: keep dependency and lineage task fields and append `budgetLabel` at line 946.
- `src/runtime.ts:1226`: combine dependency readiness (including D11 verification) AND per-agent capacity at line 1227, while retaining conversation serialization and permission suppression at lines 1228–1229. Global capacity is checked at line 1208; no scheduling condition was replaced.
- `src/store.ts:71`: keep dependencies, labels and parent IDs, and add `budgetLabel` at line 74.
- `src/mcp.ts:75`: combine the verification tool description with the new global/per-agent concurrency description, preserving both public contracts.

Trigger merge (`20ab36f`), one conflict block:

- `src/runtime.ts:1209`: retain effective per-agent cap calculation and active count at line 1213; append the trigger interactive-slot reserve at line 1219. The reserve skips unattended tasks when only the final global slot remains, then the combined predicate at lines 1225–1229 enforces queued status, dependency readiness/D11, agent caps, conversation serialization and permission suppression. With global capacity one, trigger work stays queued.

Automatic merges were reviewed too: `src/runtime.ts:932` persists `triggerId` beside all existing task metadata; `src/store.ts:58` and `src/store.ts:192` retain trigger identity and registry state alongside dependency/lineage/budget/verification state. The dependency failure sweep at `src/runtime.ts:1177` still propagates failed worker outcomes and failed verification even when all execution slots are occupied. `src/runtime.ts:298` still requires completed plus passed verification for verified dependencies, while unverified dependencies release on completion. Bounded label waits still cap returned tasks at ten (`src/runtime.ts:59`, `src/runtime.ts:333`) and count the entire group.

Preference override and clamp behavior also remains: `src/effective-config.ts:266` prefers the workspace agent cap over its configured default; `src/config.ts:105` clamps the requested cap to global capacity and reports the requested/effective values. Existing budget tests cover preference override, global reductions, diagnostics, retained budgets and retry idempotence.

## Cross-feature regression

`test/lab-depends-on.test.mjs:319` adds one real mock-ACP regression combining:

- Three labelled fan-out tasks across two agents, each capped at one, sharing a task budget of three; a fourth budgeted spawn is rejected.
- Parent IDs on children and join, bounded label-group wait/counts, explicit task-start ordering, and cap observations at every dispatch (global two, per-agent one).
- A real event trigger queued while its agent is idle because the final slot is reserved; interactive fan-out work bypasses it and uses that slot.
- A join depending on all three fan-out tasks with an independent delayed verify spec, plus a downstream task proving that worker completion with pending verification cannot release dependencies into a spare slot.

## Final validation

Both final commands exited 0, including TypeScript builds and the complete suite on the final source and test code:

| Command | Tests | Pass | Fail | Cancelled | Skipped | Todo | Duration (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `env -u AGENT_BRIDGE_WORKER npm test` | 199 | 199 | 0 | 0 | 0 | 0 | 21157.731084 |
| `AGENT_BRIDGE_WORKER=1 npm test` | 199 | 199 | 0 | 0 | 0 | 0 | 20700.317167 |

The I2 cross-feature regression passed in both modes (2102.720041 ms and 2108.215208 ms, respectively). `git diff --check` passed. Final source has no conflict markers and no `lab/` directory or tracked paths under it. All work is committed locally; nothing was pushed.

# I3

Branch: `lab/integration`, starting at `df7d5ac`. Merged `lab/worker-seatbelt` with `git merge --no-ff lab/worker-seatbelt -m "integrate: worker-seatbelt"` as `6c2ebe6` (parents `df7d5ac` and the worker-seatbelt branch tip). Immediate follow-up `656994a` removed all of `lab/` and relocated the seatbelt fixture prefix to `.sb-*` in this worktree (`test/lab-worker-seatbelt.test.mjs:24`). No other worktree was operated on, no live lab socket was contacted, and nothing was pushed. All requested work completed within eight minutes.

## Conflicts and retained behavior

There were four modify/delete documentation conflicts, resolved by accepting the feature versions for the merge and removing them in the immediate follow-up, consistent with the requested merge-then-remove sequence. Their file:line references are to merge commit `6c2ebe6`, since these files intentionally do not exist in the final tree:

- `lab/DAG.md:1`: accepted the worker-seatbelt version for the merge, then removed in `656994a`.
- `lab/LEDGER.md:1`: accepted the worker-seatbelt version for the merge, then removed in `656994a`.
- `lab/PROCESS_JOURNAL.md:1`: accepted the worker-seatbelt version for the merge, then removed in `656994a`.
- `lab/state.json:1`: accepted the worker-seatbelt version for the merge, then removed in `656994a`.

There were no textual source conflicts. Reviewed automatic merges retain all previous behavior:

- `src/config.ts:67`: `isolation` and `providerSandbox` coexist with `maxConcurrent` at line 70 in the strict agent schema. Seatbelt validation at line 88 remains alongside the global/per-agent cap helper at `src/config.ts:135`; preference override and scheduler capacity checks remain unchanged.
- `src/acp.ts:82`: opt-in seatbelt rejects unsupported platforms or nested provider sandboxes; the generated profile wraps both worker guardian and provider at `src/acp.ts:93`, using canonical state/socket paths. Non-seatbelt workers keep the original launch behavior.
- `src/runtime.ts:1463` and `src/worker-settings.ts:83`: both normal execution and settings probes pass the agent configuration into the worker, so isolation applies to both paths. The combined I2 scheduler predicate and D11 verification dependency gating remain intact.
- `src/seatbelt.ts:4`: SBPL path quoting, canonical/alias state denial, relocated socket directories, both `/tmp` spellings, and rename-bypass defenses are retained. Tests create their own local servers and sockets; they never connect to the prohibited live lab socket.

The existing runtime seatbelt regression now explicitly configures `maxConcurrent: 1` alongside `isolation: seatbelt` and `providerSandbox: none`, asserts all three survive schema parsing, and completes a real mock-ACP task (`test/lab-worker-seatbelt.test.mjs:243`). This supplements the retained I2 cross-feature scheduling test and existing cap/preference/clamp tests.

## Final validation

Both final commands exited 0, including the TypeScript build and all tests on the final source/test code. The initial post-removal coordinator gate also passed 208/208 before the combined-schema assertions were added.

| Command | Tests | Pass | Fail | Cancelled | Skipped | Todo | Duration (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `env -u AGENT_BRIDGE_WORKER npm test` | 208 | 208 | 0 | 0 | 0 | 0 | 21896.06675 |
| `AGENT_BRIDGE_WORKER=1 npm test` | 208 | 208 | 0 | 0 | 0 | 0 | 21390.3775 |

Real macOS sandbox tests ran in both modes: state and alias reads, state writes, relocated socket connections, and socket/parent rename bypasses returned EPERM; fixture servers observed zero sandboxed connections. Workspace/HOME reads and wrapped mock ACP/runtime execution succeeded. The I2 cross-feature regression passed in both modes. `git diff --check` passed; `lab/` is absent and no tracked `lab/` paths remain. Work is committed locally, with no push.

# Reviewer checklist

- **hermetic-tests:** Temporary fixture configuration, state, homes and mock providers; restored environment; deterministic stderr-budget observation; both worker-marker modes pass without using live daemons or sockets.
- **verify-verdict:** Strict coordinator-only verification input; literal argv without a shell; timeout/process-group termination, output bounds and environment allowlist; tamper detection; durable verdict/artifact separate from worker completion.
- **handoff-inputs:** Known completed sources only; bounded source count, character limits and combined prompt; random collision-resistant provenance fences resist forged delimiters; Unicode truncation stays valid.
- **depends-on:** Atomic ID validation; fan-out/join order; waiting consumes no execution slot or blocks unrelated work; cancellation/failure propagates transitively even at full capacity; persisted graphs resume correctly and explain queue reasons.
- **D11:** Verified dependencies release only after a passed verdict; failed/tampered/error verification fails dependents; pending verification cannot use a spare dependent slot; tasks without verify retain release-on-completed behavior.
- **lineage-labels:** Safe bounded labels, deduplication, valid existing parent IDs and persisted validation; lineage visible in results/status; event filtering; label waits count the whole group while returning at most ten tasks with open work first.
- **budget-pools:** Global, per-agent, conversation and permission limits compose; omitted caps retain parallelism; preference overrides and global clamps report diagnostics; cross-agent task budgets count retained terminal tasks, survive reload, and preserve idempotent task-key retries.
- **trigger-to-task:** Real timer/event tasks; explicit workspace and trusted trigger identity; durable registry, restart handling, overlap suppression, event dedupe, fire budgets and failure circuit breaker; unattended tasks preserve the final interactive slot, including at global capacity one.
- **worker-seatbelt:** Opt-in macOS isolation and explicit provider sandbox disablement, Codex full-access requirement, incompatible worktree rejection; guardian/provider and probes wrapped; quoted canonical/alias state and relocated socket/parent protections cover rename bypasses and both tmp spellings; ordinary workspace/HOME access works; seatbelt fields coexist with agent caps.
