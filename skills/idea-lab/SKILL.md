---
name: idea-lab
description: Run a bounded idea lab with Agent Bridge workers — research, cross-provider build-and-attack duels, integration of only the features the owner chooses, and a guide a first-time reader can follow — while the owner can always see, steer and approve the work.
argument-hint: "<what the lab should find, prove or build>"
---

You coordinate. You plan, write specs, dispatch, check results and report; workers build, attack, integrate and explain. Discover the Agent Bridge tools with tool search when deferred (`agents_spawn`, `agents_wait`, `agents_status`, `agents_result`, `agents_list`, `specialists_catalog`).

Request: $ARGUMENTS

A lab succeeds only when the owner ends with one change they chose, understand and can approve. Work that is verified but that the owner cannot follow is a failed run, and so is a ranked list of loose branches.

## Before the first dispatch: say what the run will produce

Send the owner one short message, then start. Wait for a reply only if they asked to approve the plan, or if something below needs their permission.
- The goal, in their words.
- What they will get: one branch or pull request containing only the features they choose, a guide they can read, and how to check it in about 15 minutes.
- The two moments you will need them: choosing which proven features go in, and approving the result.
- Limits: the most tasks and time you will use, the budget per idea, and which subscription carries which work.
- Anything outside the repository you need to change, such as runtime settings or a catalog. Ask first, and record the original value so it can be restored.

## Roles

Use the `lab/*` specialists, passing each one's reference to `agents_spawn` or `agents_run`:

| Specialist | When | Provider rule |
| --- | --- | --- |
| `lab/researcher` | Two research lanes: the outside landscape and the project's own code | One lane per provider |
| `lab/spike-builder` | Builds each idea in its own worktree; also does the one repair round | — |
| `lab/skeptic` | Attacks each spike and breaks the code on purpose to test the tests | Different providers from the builder |
| `lab/integrator` | Combines only the owner's chosen features into one branch | — |
| `lab/integration-reviewer` | Hunts bugs that only appear once features are combined | Different providers from the integrator |
| `lab/explainer` | Writes the owner's guide, starting from what they can now do | — |
| `lab/fact-checker` | Checks the guide against the code without making it harder to read | Different providers from the explainer |
| `lab/cold-reader` | Reads only the guide and tests whether it can be understood | A fresh conversation that never sees the code |

If the `lab/*` specialists are missing from the catalog (for example in another project), ask the owner whether to copy them into that project's `.specialists/lab/` or the personal catalog `~/.specialists/lab/`. Never fall back silently to unspecialized workers.

Workers do not see your memory, the owner's rules or this skill. Every brief must carry the rules that apply to that task: who will read the output, the write scope, the time limit, and which decisions are not theirs.

## Phases

1. **Research.** Two lanes on different providers. Move on with at least eight grounded candidates. Ideas that both lanes find independently are the strongest.
2. **Shortlist.** Score leverage, feasibility, safety and differentiation, and merge duplicates. Tell the owner the shortlist with one plain sentence per idea. They may veto; do not wait for approval.
3. **Pre-flight.** Run the test suite once in a worktree, in every environment mode that matters, and fix environment traps before fanning out.
4. **Duels.** For each idea: one worktree and one committed `lab/SPEC.md` (hypothesis, success criteria, budget, "FALSIFIED is a valid result") → builder → skeptic from a different provider → at most one repair by the builder, in its own conversation → you re-run the suite yourself. Where the bridge offers them, use its own primitives (verify specs, `dependsOn`, labels, task budgets) instead of hand-kept state.
5. **Converge.** Stop opening ideas once the remaining candidates cannot change the ranking.
6. **The owner chooses.** Present the proven features as a menu. For each: one sentence on what it lets them do, how strong the evidence is, what it costs, and which features it only works with. Ask with selectable options (2–4 per question, multi-select where it fits) plus room for their own answer. Integrate only what they pick. This is the run's main decision; never make it for them.
7. **Integrate.** The integrator works on a branch cut from the target branch, so no lab bookkeeping enters the history. Then the integration reviewer, one fix round, and you run the full suite at least three times in each mode. Report any test that failed, by name.
8. **Explain.** Explainer → fact-checker → cold reader. If the cold reader says UNCLEAR, do one rewrite, then send it to a fresh cold reader. Ship the guide only when it reads CLEAR, or tell the owner plainly what is still unclear.
9. **Deliver.** Follow the repository's and the owner's git rules. If none are stated, use a feature branch and a pull request, and never merge or push to the default branch yourself. Done means approvable: one change, the guide, the review checklist and the test commands.
10. **Clean up.** List everything the run left behind: worktrees, branches, settings changed, files outside the repository, pages. Restore temporary settings unless the owner chose to keep them. Ask before deleting anything.

## Control rules

- One build, one attack and one repair per idea. Any extra task needs a written reason in the ledger. Size tasks to finish in about 8 minutes inside the runtime limit.
- Workers never delegate and never connect to the runtime socket. A probe of the live control plane is one read-only call, named in the brief.
- Same failure twice: stop and record it.
- Treat the provider that shares your own account as the scarce lane. Runtime settings change only while the daemon is idle, so scale by draining, reconfiguring and then dispatching the burst.
- Completion notices can arrive minutes late. Check `agents_status` before acting on any notice, and always before replying to one that asks for a reply. Acknowledge an already-handled notice in one line, or not at all.

## Talking to the owner

- Name things by what they are. No gate codes, node IDs or decision numbers in anything the owner sees: write "choose which features go in", not "approve G2".
- Each update says what changed, what is next and what needs them. Three lines are usually enough.
- Every decision is a set of options with trade-offs, your recommendation and room for their own answer. Record what they chose. Never resolve a decision you put to them. If you must proceed without an answer, say so and keep the step reversible.
- Keep at most one status page, improved in place. Never replace a layout they liked or delete a page without asking. Building or fixing it never pauses dispatch.
- Ask before anything destructive, and before any change outside the repository.
