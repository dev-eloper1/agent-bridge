# Decisions only a person can resolve

## In plain words

A model can now put a question to you with two to four options, and make work wait for your answer, but it has no way to answer the question itself. You answer from the worker pane, either by pressing an option button or with `/workers decide <id> <option>`, or you call it off with `/workers withdraw <id>`. Work waiting on that answer then runs with your choice, or stops with a clear reason. Each step is pushed to live-event watchers as a `decision.*` event.

## What changed

```
model ──agents_decision_open──▶ decision: open ──(timer)──▶ expired ─┐
model ──agents_decision_status─▶ read one, or list the open ones     │
model ──agents_spawn waitsOnDecisions:[id]──▶ task stays queued      │
                                                                     ▼
pane button ──┐                                         waiting tasks fail
/workers ... ─┴─▶ POST /human ──▶ resolved ─▶ task runs; answer fenced in its prompt
                               └▶ withdrawn ─▶ waiting tasks fail
every step ──▶ decision.opened / .resolved / .withdrawn / .expired ──▶ /events watchers
```

### The decision record (`src/store.ts`, `src/storage.ts`)

- A decision holds:
  - an ID and the question;
  - 2–4 options, each with a label and a one-line trade-off;
  - whether free text is allowed;
  - a status: `open`, `resolved`, `withdrawn` or `expired`;
  - who opened it (a task ID, or `coordinator`) and an optional expiry time;
  - the resolution: the option or text, the **surface** that gave it, and when.
- It is saved through the existing storage port. In SQLite, decisions are their own `decisions` rows, next to tasks, sessions and triggers. The checks that run when stored state is loaded now include decisions.

### Work that waits (`src/runtime.ts`)

- `agents_spawn` takes `waitsOnDecisions`, a separate field from `dependsOn` (see Choices).
- While a decision is open, the task stays queued with `queueReason: "waiting_on_decision"`, and unrelated work keeps running.
- **Resolved:** when the task starts, it gets the question and answer inside the existing untrusted-input fence (`buildHandoffPrompt`), labelled `source=decision:<id>`.
- **Withdrawn or expired:** queued dependents fail without starting, with the message "Decision … was withdrawn/expired; this task needed a person's answer". New spawns against a closed decision are refused.
- Expiry happens only on a timer, which is set up again for open decisions after a restart.

### MCP tools: open and read only

- **`agents_decision_open`** opens a decision.
- **`agents_decision_status`** reads one decision, or lists the open ones when no ID is given. The pane uses the list, so no extra tool was needed.
- MCP generates one tool per entry in the runtime's `inputs` table. Resolving and withdrawing are deliberately left out of that table, so they never become tools.

### The human route (`src/server.ts`, `src/runtime.ts`)

- A new `POST /human` route on the runtime socket takes `{ action: "decide" | "withdraw", decisionId, option? | text?, surface }`.
- `surface` must be `mod-button` or `mod-command`, and it is recorded with the resolution.
- The MCP server only ever calls `POST /call`. `/call` rejects `decide`, `withdraw`, `human` and `resolve` as unknown methods.

### The pane (`hooks/register.js`)

- Whenever a decision is open, an **"INPUT REQUIRED · decisions only you can make"** box appears above the worker navigation on every screen. Open decisions come first, numbered.
- Each decision shows its question, then one button per option labelled `1 · label — trade-off`.
- A free-text field and a "Submit answer" button appear only when the decision allows free text.
- `/workers decide <short-id> <option-number-or-label>` and `/workers withdraw <short-id>` are new (the full ID also works), and both are listed in `/workers help`.
- The pane talks to `/human` only through a dedicated helper, never through `/call`. The existing permission and reply controls are unchanged.

### Events

- The four events `decision.opened`, `decision.resolved`, `decision.withdrawn` and `decision.expired` each carry a typed `kind` and go through the existing live-event stream.
- As agreed, events now name a task, a decision, or both. Stored-state validation stays strict: every event must name an existing task or an existing decision, and an event naming neither is rejected at load.
- `decision.opened` is marked `requiresReply: true`. Decision events have no transcript artifact.

## How it was tested

- **`npm test`: 255 tests, 255 pass, 0 fail.** The baseline was 247 at the start of PR 4; 8 tests are new in `test/decisions.test.mjs`.
- **`npm run test:mod`: 47 pass, 0 fail.** It was 43 before; 4 tests are new in `hooks/bridge.test.ts`. It runs fine in this environment.

New runtime tests (`test/decisions.test.mjs`):
- **Waiting and release:** the dependent stays queued while unrelated work completes. After the decision is resolved it runs, and its output contains the fenced `source=decision:` block with the answer.
- **Answers:** free text, option by number or by label, surface recorded. Refusals: unknown option, free text when not allowed, bad surface, deciding twice.
- **Withdraw and expiry:** both fail dependents without starting them. A 50 ms expiry fires from the timer, and the decision can't be decided after that.
- **Restart:** the decision, its options and expiry time, the task's `waitsOnDecisions`, and a later resolution all survive two restarts.
- **No MCP resolution:**
  - no `inputs` key, and so no tool, mentions decide, resolve, withdraw, expire or answer;
  - `decision_open` rejects a pre-filled `status` or `resolution`, numeric-only labels, and duplicate labels;
  - `/call` rejects the settling verbs;
  - the live MCP tool list in `test/plugin.test.mjs` has no tool name matching decide, resolve, withdraw or expire.
- **Route and events, against a real daemon socket:**
  - **replay:** a watcher that connects after `decision.opened` still receives it;
  - **live:** `decision.resolved`, `decision.withdrawn` and the timer's `decision.expired` arrive while the watcher is connected, with consecutive cursors and no duplicates;
  - **surfaces:** `/human` with `surface: "mcp"` is rejected (400), and `mod-button` is recorded.
- **Stored events:** an event opened by a task carries both IDs. A stored event naming neither a task nor a decision makes startup refuse the state.

New Mod-host tests (`hooks/bridge.test.ts`):
- the decision box, its numbered option labels with trade-offs, and a button press posting to `/human` with `mod-button`;
- free text appears only when allowed;
- `/workers decide <short-id> json` and `/workers withdraw <id>` use `mod-command`; a list position (`decide 1 …`) and an ambiguous short ID are refused;
- the permission Allow button still sends the same `reply` call while a decision box is showing.

### Existing tests changed

- `test/runtime.test.mjs` and `test/plugin.test.mjs` asserted exactly **18** MCP tools. This change adds two on purpose, so both now expect **20**.
- `hooks/bridge.test.ts`: the shared fake runtime in `setup()` now answers `decision_status` and records `/human` calls. No existing assertion changed.

## Choices I made

- **A separate `waitsOnDecisions` field instead of reusing `dependsOn`.** `dependsOn` means "that task finished and passed", and it carries no input. A decision is released by a person and carries an answer that has to be fenced into the prompt. Keeping them apart keeps both sets of rules and error messages simple.
- **Withdraw is human-only, like resolve.** Models get no withdraw tool.
- **Labels can't look like positions.** `agents_decision_open` refuses labels that are only digits, and labels that repeat each other (ignoring case and spaces). Otherwise a model could label options "2" and "1", so that `/workers decide <id> 2` picks a different option than the one you read. This came from an automated security review.
- **Commands use a fixed short ID, not a list position.** The pane shows each decision's short ID (8 characters), and `/workers decide` and `/workers withdraw` accept that or the full ID, refusing a short ID that matches two open decisions. List positions can shift when another decision expires, which could land your answer on a different question. This also came from the security review; buttons were already tied to their decision.
- **Free text only from the pane field.** `/workers decide` takes an option number or label, so a mistyped label is refused instead of silently becoming a free-text answer.
- **The two surfaces are a fixed list**, `mod-button` and `mod-command`; anything else is rejected.
- **Expiry is capped at 7 days**, and a decision never expires unless an expiry is set.
- **Open decisions are listed through `agents_decision_status` with no ID**, not a new tool. The tool count stays at 20.
- **The `/workers` argument hint is unchanged**, so an existing test didn't have to be edited. The new commands are listed in `/workers help`.

## Risks and honest limits

- **Any local process running as you can call `/human` directly.** That includes **the coordinating model itself, through its shell tool**, and any worker process that isn't sandboxed from the runtime socket. The socket is private to your user account (mode 0600), but nothing proves a request came from a person pressing a button. This PR removes the model's *tool* path (MCP tools and `/call`); it does not stop a model that can run shell commands. Real enforcement needs an operating-system boundary later, for example a separate socket or per-session secret that only the pane host can reach, with the surface decided by the server instead of claimed by the caller. An automated security review flagged this as high severity; it stays open, as scoped.
- The recorded surface is what the caller claims. It is honest for the pane, but a local process could claim `mod-button`.
- If a resolved decision's dependent also has a `dependsOn` task that fails, the dependent still fails, under the existing `dependsOn` rules.

## What is left

Nothing from the assignment is open. Possible follow-ups:
- an operating-system boundary for `/human`;
- showing who opened a decision in the pane;
- a dashboard view of decision history.
