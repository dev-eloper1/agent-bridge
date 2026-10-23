---
name: specialize
description: Create, adapt, save, update, delete, promote or organize specializations — named specialists for external workers — through Agent Bridge in natural language.
argument-hint: "<what to create, adapt, save, update, delete or promote>"
---

Create or manage specialized workers for Agent Bridge using your ordinary file and Git tools. A specialization is declarative behavior and an output contract; a specialized worker is a worker profile plus a specialization plus an assignment. Agent Bridge only validates, discovers, pins and executes specializations — it never writes specialist files, so you do the writing through Read/Write/Edit/Glob/Grep/Git under the user's normal guards and approvals. Discover `specialists_schema`, `specialists_validate`, `specialists_catalog`, `agents_list` and `agents_run`/`agents_spawn` with tool search if deferred. Do not ask the user to run commands, learn references or manage files themselves.

Request: $ARGUMENTS

Get the contract first: call **`specialists_schema`** when you are unsure of the fields. A specialization is declarative data only — format, namespace, id, name, version, description, instructions, delivery, optional providers, requiresReadOnly and acceptanceCriteria. It cannot carry commands, env, credentials, tools, hooks, MCP servers, permission approvals, or model/reasoning settings; capability comes from the worker profile, so never claim a specialization's instructions enforce permissions or sandboxing.

Decide ephemeral vs. saved:
- "For this task", "don't save", "one-off" — draft the specialization, call **`specialists_validate`** (with the chosen worker's agentId to preview binding), then run it inline by passing `specialistSpec` to **`agents_run`**. Nothing is written.
- A plain "create a specialized worker" with no persistence cue — do NOT interrogate about scope. Validate, run ephemerally, and after a useful result offer once to save it.
- "For this project" → `<project>/.specialists`; "personal" or "for me everywhere" → `~/.specialists`; a named team/org catalog → the matching configured root. Resolve actual roots from **`specialists_schema`**'s `availableCatalogs` mapping — it shows every project/global/configured catalog root path, including empty ones. Ask one concise clarification only when genuine ambiguity remains.

Persisted layout: `<catalog>/<namespace>/<id>/specialist.yaml`; the declared `namespace`/`id` must match the directory path. A `catalog.yaml` at the catalog root is optional descriptive metadata — create it when standing up a new shared catalog, but nothing depends on it.

Authoring and adapting:
- From a requirement: draft the smallest honest specialization and validate before running or writing.
- From an existing native/client agent (a Claude subagent, a Hivemind role file, another project's agent): read the source first. Separate portable behavior (role, scope, output contract, evidence rules) from host-specific assumptions (native tools, MCP connectors, model picks, permission modes). Report plainly what carries over and what is lost before proceeding, then validate and run or save.
- Always call **`specialists_validate`** before writing or running a spec you authored; fix what it rejects rather than weakening it.

Update and delete:
- Update: locate the specialist (Glob/`specialists_catalog`), edit with your file tools, re-validate, and show the user a behavioral diff. Conversations already running keep their pinned snapshot; new runs get the new version.
- Delete one specialist: resolve the exact specialist, show what it affects, get explicit confirmation, then delete the directory with your file tools. Pinned conversations are unaffected.
- Delete an entire ecosystem/catalog: enumerate every affected specialist and show the exact catalog path and scope before acting. Distinguish removing the catalog's contents from unregistering a configured `specialistCatalogs` entry (a config edit, not a file deletion). Require one explicit confirmation for the whole destructive operation — never delete a project, global or team catalog from an ambiguous request, and follow the host repo's Git rules.
- Promote/copy to a team or org catalog: normal Git flow — branch, copy the directory, PR, approval. Agent Bridge never does it.

An "ecosystem" is a coherent collection of independent specialists in one catalog (for example, a set of case-triage specialists). Author them consistently; the client orchestrates them — Agent Bridge is not a workflow engine.

After saving, the specialized worker is immediately usable: a user can ask for it by name and `specialists_catalog` will resolve it; you never need to expose its `specialistRef` unless asked.

Failures: if validation, binding or resolution fails, report the concrete error and offer options — never silently run a different specialist or a plain worker.
