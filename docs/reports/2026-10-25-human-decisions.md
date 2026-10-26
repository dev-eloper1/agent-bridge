# Decisions for the owner: no model tool can resolve them

## In plain words

A model can now put a question to you with two to four options and make work wait for your answer, and **no model tool can resolve a decision**. You answer from the worker pane, with an option button or `/workers decide <id> <option>`, or call the question off with `/workers withdraw <id>`. Waiting work then runs with your answer, or stops with a clear reason. **What is not guaranteed:** the answer route is reachable by local processes running as you, including a model's shell. A pane token raises the bar, but it doesn't stop a shell running as you.

## What is guaranteed, and what is not

| | Guaranteed? |
|---|---|
| No MCP tool, `reply`, `steer` or generic `/call` method can resolve, withdraw or expire a decision | **Yes.** Tested, and confirmed by the reviewer. |
| Only a person can resolve a decision | **No.** Any process running as you can read the pane token and call `/human`; that includes the coordinating model through its shell tool, and any worker that isn't sandboxed from the state folder. |
| The recorded surface (`mod-button` / `mod-command`) proves who answered | **No.** It is stored as `claimedSurface`: what the caller said. |
| What you read in the pane is exactly the stored question and options | **Yes.** Control and invisible characters are refused when a decision is opened. |
| A valid answer never makes an accepted task fail on prompt size | **Yes.** The room for the longest possible answer is reserved when the task is spawned. |

## What changed

```
model ──agents_decision_open──▶ decision: open ──(timer)──▶ expired ─┐
model ──agents_decision_status─▶ read one, or list the open ones     │
model ──agents_spawn waitsOnDecisions:[id]──▶ task stays queued      │
                                                                     ▼
pane button ──┐                                         waiting tasks fail
/workers ... ─┴─▶ POST /human + pane token ──▶ resolved ─▶ task runs; answer fenced in its prompt
                                            └▶ withdrawn ─▶ waiting tasks fail
every step ──▶ decision.opened / .resolved / .withdrawn / .expired ──▶ /events watchers
```

### The decision record (`src/store.ts`, `src/storage.ts`)

- A decision holds:
  - an ID and the question;
  - 2–4 options, each with a label and a one-line trade-off;
  - whether free text is allowed, and if so the longest answer allowed (`maxFreeTextChars`, default 500, at most 2,000);
  - a status: `open`, `resolved`, `withdrawn` or `expired`;
  - who opened it (a task ID, or `coordinator`) and an optional expiry time;
  - the resolution: the option or text, the **claimed surface**, and when.
- It is saved through the existing storage port. In SQLite, decisions are their own `decisions` rows, next to tasks, sessions and triggers, and the checks that run when stored state is loaded include decisions.

### Safe text and labels (`src/runtime.ts`)

- When a decision is opened, the question, labels and trade-offs are refused if they contain control or invisible formatting characters: escape sequences, bell, zero-width and bidi characters, and line or paragraph separators. Ordinary line breaks are allowed in the question only.
- Labels must be distinct **as displayed**, after Unicode normalisation (NFKC), collapsing spaces and ignoring case. They also can't be numbers in that form, so "２" counts as "2".
- Before this, `"ship\u001b[31m"` and `"ship"` both passed and looked identical in the pane. The reviewer reproduced that; it is now refused.
- A typed label is matched in the same displayed form: `ship  IT` selects "Ship it".
- Free-text answers over the decision's limit, or containing control or invisible characters, are refused. They used to be silently cut to 2,000 characters.

### The answer budget (`src/runtime.ts`)

- When a task is spawned with `waitsOnDecisions`, the runtime builds the fenced prompt with the **longest answer each decision could accept**: the longest label, or `maxFreeTextChars` if free text is allowed. It refuses the spawn if that would exceed the 16,000-character limit.
- Before this, a valid answer could push an already-accepted task over the limit, so it failed after you answered. The reviewer reproduced that too.

### Work that waits

- `agents_spawn` takes `waitsOnDecisions`, a separate field from `dependsOn` (see Choices).
- While a decision is open, the task stays queued with `queueReason: "waiting_on_decision"`, and unrelated work keeps running.
- **Resolved:** when the task starts, it gets the question and answer inside the existing untrusted-input fence, labelled `source=decision:<id>`.
- **Withdrawn or expired:** queued dependents fail without starting, with the message "Decision … was withdrawn/expired; this task needed a person's answer". New spawns against a closed decision are refused.
- Expiry happens only on a timer. After a restart, timers are set up again for open decisions, and a decision whose expiry passed while the runtime was down expires right away.

### MCP tools: open and read only

- **`agents_decision_open`** opens a decision.
- **`agents_decision_status`** reads one decision, or lists the open ones when no ID is given.
- MCP generates one tool per entry in the runtime's `inputs` table. Resolve and withdraw are not in it, so they never become tools.
- The tool descriptions now say what is guaranteed: no model tool can resolve, withdraw or expire a decision, and a claimed surface is not proof that a person answered.

### The human route and pane token (`src/server.ts`, `src/cli.ts`)

- `POST /human` takes `{ action: "decide" | "withdraw", decisionId, option? | text?, surface }`. `surface` must be `mod-button` or `mod-command`, and it is stored as `claimedSurface`.
- **New:** the daemon creates `<state folder>/pane-token`, a random 64-character hex token with file mode 0600. It is reused across restarts, so a pane started before a daemon restart keeps working.
- `/human` requires the token in the `x-agent-bridge-pane-token` header, compared in constant time. A missing or wrong token is refused, and the decision stays open.
- `plugin-bootstrap`, which the Mod already runs at session start, now returns `paneToken`.
- **What the token does and doesn't do:** it stops a caller that only knows the socket path, for example something that guesses the protocol. It does **not** stop a shell running as you: the token file and `plugin-bootstrap` are readable by any process with your permissions.
- The MCP server only ever calls `POST /call`, which rejects `decide`, `withdraw`, `human` and `resolve`.

### The pane (`hooks/register.js`)

- The box heading is now **"INPUT REQUIRED · decisions for you"**, followed by a dim line: "No model tool can resolve these; the answer route is reachable by local processes running as you." The old heading, "decisions only you can make", claimed more than is true.
- Each decision shows its fixed short ID and question, then one button per option labelled `1 · label — trade-off`, plus a free-text field and "Submit answer" button only when free text is allowed.
- `/workers decide <short-id> <option-number-or-label>` and `/workers withdraw <short-id>`; the full ID also works.
- The pane sends the token on every `/human` call. The permission and reply controls are unchanged.

### Events

- `decision.opened`, `decision.resolved`, `decision.withdrawn` and `decision.expired` each carry a typed `kind` and go through the live-event stream.
- Events name a task, a decision, or both. Stored-state validation still refuses an event that names neither, or names one that doesn't exist.
- The resolved event's summary says "Decided (claimed surface mod-button): …".

## How it was tested

The final results, from runs this round:

- **`npm test`: 259 tests, 259 pass, 0 fail.** That is 4 more than the reviewed commit's 255.
- **`npm run test:mod`: 47 pass, 0 fail.**

New or extended this round:
- **Safe text:**
  - refused: an escape sequence in a label (the reproduced case), a zero-width space, a bidi override, a bell in a trade-off, a terminal-title escape in the question;
  - refused as duplicates or numbers: a full-width label equal to another, labels equal after collapsing spaces and case, a full-width "２";
  - accepted: a question with an ordinary line break.
- **Displayed-form matching and free-text cap:** `ship  IT` selects "Ship it". An 11-character answer to a 10-character limit is refused, and so is an answer containing an escape sequence.
- **Answer budget:**
  - the test probes for the longest prompt that spawn accepts with a 2,000-character free-text decision, and checks that the 2,000 characters are reserved;
  - a task accepted right at that limit still **completes** when the longest allowed answer is given;
  - mutation check: with the spawn-time check disabled in the built code, this test fails.
- **Expiry restored after a restart:**
  - one decision is still open across the restart, and one passed its expiry while the runtime was down;
  - with no calls touching them, both expire on the restored timers, and the waiting task fails;
  - mutation check: with the restore loop removed from the built code, this test fails. That is the mutation the reviewer found surviving.
- **Pane token, against a real daemon:** the token file is mode 0600, and `/human` is refused with no token, an empty token or a wrong token, after which the decision is still open. `test/plugin.test.mjs` checks that a real `plugin-bootstrap` returns the same token as the file.
- **Mod host:** the pane shows the new heading and limit line, and button calls carry the pane token.
- The tests from earlier rounds still cover: waiting and release, withdraw, expiry, restart persistence, no MCP resolution, `/call` refusing the settling verbs, events on replay and live, and stored-event validation.

The mutation checks edited `dist/runtime.js` temporarily. `dist/` was rebuilt from source afterwards, and both suites were run again after that rebuild.

### Existing tests changed

- PR 4's own tests now read `resolution.claimedSurface` instead of `resolution.surface`, and expect the new pane heading. These are deliberate changes to this PR's behaviour, not fixes to make tests pass.
- From earlier rounds: the MCP tool count went from 18 to 20 in `test/runtime.test.mjs` and `test/plugin.test.mjs`, because two tools were added.

## Choices I made

- **A separate `waitsOnDecisions` field instead of reusing `dependsOn`.** `dependsOn` means "that task finished and passed", and it carries no input. A decision is released by a person and carries an answer that is fenced into the prompt.
- **`resolution.surface` is renamed `resolution.claimedSurface`**, so nothing reading the record can mistake it for proof of who answered. No released data used the old name.
- **The pane token is stable per state folder**, not new on each daemon start. That keeps a running pane working across daemon restarts. To rotate it, stop the runtime and delete the file.
- **Free text defaults to at most 500 characters** (2,000 at most) when a decision allows it, so ordinary prompts still fit under the budget.
- **Free text that is too long is refused, not cut short**, so the answer you see recorded is the one you typed.
- **Withdraw is human-only, like resolve.** Labels can't look like positions, and commands use a fixed short ID instead of a list position (both from the earlier security review).
- **Free text only from the pane field**, so a mistyped label in `/workers decide` is refused instead of becoming a free-text answer.
- **Expiry is capped at 7 days**, and there is no expiry unless one is set. Open decisions are listed through `agents_decision_status`, keeping the tool count at 20.

## Risks and honest limits

- **The human route is reachable by local processes running as you.** That includes the coordinating model through its shell tool. The pane token raises the bar, but anything that can read your files can read it. This PR removes the model's tool path; it does not stop a shell running as you. Real enforcement needs an operating-system boundary, for example a socket or credential that only the pane host process can reach, with the server deciding the surface.
- Workers inside the opt-in seatbelt sandbox can't reach the runtime socket. Workers outside it can.
- If the stored prompt changes length during secret redaction (the redaction runs before the budget check), the budget is computed on the redacted text, which is the text the task actually runs with.
- If a resolved decision's dependent also has a `dependsOn` task that fails, the dependent still fails, under the existing rules.

## What is left

Nothing from the assignment is open. Possible follow-ups:
- an operating-system boundary for `/human`;
- rotating the pane token;
- showing who opened a decision in the pane.
