# Specialized Workers

## Summary

Agent Bridge runs specialized workers through ordinary natural-language delegation, without ever owning specialist files. A **specialization** is a declarative definition — role, behavior, output contract and compatibility requirements — independent of any provider. A **specialized worker** is a worker profile plus a specialization plus an assignment. The Claude plugin ships a `specialize` skill so Claude itself creates, adapts, saves, updates, deletes, promotes and organizes specializations using its normal file and Git tools under the host client's guards and approvals. A `.specialists` catalog is a plain folder contract — `<catalog>/<namespace>/<id>/specialist.yaml` — used only when persistence, reuse or sharing is wanted. One-off specialization is ephemeral and needs no files at all.

## Problem

Reusable specialized behavior previously lived in bridge-specific definition storage, making a generic execution bridge look like the owner of domain agents and forcing users to learn references and commands before they could delegate. There was also no natural way to ask for a bespoke specialist for a single task.

## Goals

- Keep Agent Bridge a provider-neutral execution runtime: it validates, discovers, pins, binds and executes; it never writes specialist files.
- Make specialization feel like a conversation, not a management surface — no skill names, refs, IDs or commands in normal use.
- Support ephemeral one-off specialists as first-class: most specialization should not create files.
- Let clients and users persist and share specialists through ordinary Git workflows they already own.
- Preserve ordinary provider delegation and all legacy saved definitions/templates.
- Keep specialist behavior strictly separate from provider model, tools, permissions and authentication.

## Non-goals

- A mandatory management plugin, hosted marketplace or remote publishing service.
- Agent Bridge performing any file write, edit, delete, copy, commit, push, clone or publish on specialist files or catalogs.
- Installing executable code, hooks, tools, credentials, MCP servers or permission approvals from a specialization.
- Turning Agent Bridge into a workflow engine; a client orchestrates collections of specialists itself.
- Runtime model/reasoning settings or dependency resolution in v1.
- Migration for released users (the earlier registry/agent-repo drafts were never committed); legacy template users remain fully compatible.

## Behavior

1. Specializations are declarative data.
   - Fields: `format`, `namespace`, `id`, `name`, semver `version`, `description`, `instructions`, `delivery`, optional `providers`, `requiresReadOnly`, `acceptanceCriteria`.
   - A specialization cannot define or grant commands, environment variables, credentials, executable tools, hooks, MCP servers, permission approvals, model or reasoning settings.
   - Unknown fields fail strict validation.

2. A `.specialists` catalog is an optional folder contract.
   - Persisted specialists live at `<catalog>/<namespace>/<id>/specialist.yaml`; `namespace` and `id` must match the directory path.
   - `<catalog>/catalog.yaml` is optional descriptive metadata; runtime discovery never depends on it.
   - Standard roots: `project` → `<project>/.specialists`, `global` → `~/.specialists`, and configured team/org catalogs via `specialistCatalogs` in Agent Bridge configuration. `project`, `global` and `inline` are reserved catalog names.
   - No catalog is required to specialize or run — one-off specializations run inline.

3. Natural authoring behavior.
   - "For this task" / "don't save" → Claude drafts the specialization, validates it, and runs it inline and ephemerally.
   - A plain "create a specialized worker" with no persistence cue → ephemeral run first, then offer to save after a useful result — never a scope interrogation up front.
   - "For this project" → project catalog; "personal / for me everywhere" → global catalog; a team/org/catalog name → that configured catalog. Claude asks one concise clarification only when genuine ambiguity remains.
   - Users never invoke skill names or know about `specialistRef`, `specialistSpec` or storage paths unless they ask.

4. Create and adapt.
   - Claude can author a specialization from a plain-language requirement, or adapt an existing native/client agent.
   - When adapting, Claude reads the source, separates portable behavior from host-specific tools/MCP/models/permissions, and reports what carries over and what is lost before proceeding.
   - Claude validates through `specialists_validate` (digest, metadata, compatible binding or concrete `bindingError`) and writes files only when persistence was requested — using its own Read/Write/Edit tools under host guards and approvals. The new or adapted specialist can run immediately.

5. Update, delete, promote.
   - Update resolves the persisted spec, edits it with normal host file tools, re-validates, and shows a behavioral diff. Conversations already running keep their pinned snapshot.
   - Delete resolves the exact specialist, shows impact, requires explicit confirmation, then deletes through host file tools. Pinned conversations are unaffected.
   - Deleting an entire ecosystem or catalog enumerates every affected specialist and the exact catalog path/scope first, distinguishes removing catalog contents from unregistering a configured `specialistCatalogs` entry, and requires one explicit confirmation for the whole destructive operation. A project, global or team catalog is never deleted on an ambiguous request. Host Git/repo rules apply.
   - Promoting or copying a specialist to a team/org catalog is normal Git work — branch, copy, PR, approval — done by the client or user, never by Agent Bridge.

6. Execution uses exactly one specialization source per call.
   - `agents_run`/`agents_spawn` accept a legacy `template`, a persisted `specialistRef` (`<namespace>/<id>` or `<catalog>:<namespace>/<id>`), or an inline `specialistSpec` — never more than one.
   - An unqualified ref resolves only when exactly one available catalog contains it; ambiguity fails listing the qualified matches.
   - The specialization supplies domain behavior and acceptance criteria; the worker profile supplies provider, model, native tools, permissions, environment and authentication. Incompatible bindings (provider restriction, unenforced `requiresReadOnly`) fail before launch.
   - Specialization instructions never satisfy a required restriction by themselves.

7. Discovery is read-only and bounded.
   - `specialists_catalog` with no arguments returns bounded metadata from all catalogs; `query` matches reference, namespace, id/name and description case-insensitively; an exact `reference` returns the full spec including instructions; optional `agentId` reports binding compatibility.
   - Broad listings omit instructions. Invalid entries surface as bounded error entries and never hide valid specialists.
   - `specialists_schema` describes the field, location and capability contract so clients can author correctly.
   - Filesystem protections stay fail-closed: regular files only, no symlinked ancestors or symlinked spec file, bounded size, strict YAML, path identity match.

8. Conversations pin the effective specialist snapshot.
   - A new conversation resolves current content and pins it by digest; follow-ups reuse the pin and reject a differing `specialistRef` or `specialistSpec`. Editing or deleting the file cannot change a running dialogue.
   - Task and conversation metadata expose the qualified reference, version, digest and catalog.
   - A fresh conversation sees current content.

9. Failures are explicit.
   - Missing catalogs, unknown or ambiguous refs, invalid specs, incompatible profiles and provider failures produce distinct actionable errors.
   - Agent Bridge never silently drops spec instructions and runs a plain worker; Claude never silently falls back after a specialization or external-execution failure — it reports and offers options.

10. Ordinary delegation and existing integrations are unchanged.
    - "Ask Devin to review this repository" still runs plain delegation with no catalog call.
    - Legacy saved definitions/templates keep working untouched; an empty catalog is a valid state; no `.specialists` folder needs to exist.
    - Hivemind's native agents remain the default. The pilot specialist moves to `hivemind/.specialists/hivemind/triage-investigator/specialist.yaml` and is used only when the user naturally asks for Devin, Agent Bridge or the external investigator — never as a silent fallback.
    - `requiresReadOnly: false` on the pilot means the no-edit requirement is instruction-scoped and coordinator-verified, not provider-enforced.

## Natural-language examples

| What the user says | What happens |
|---|---|
| "Ask Devin to review this repo" | Ordinary delegation; no specialist involved. |
| "Have Devin use the team's Hivemind triage investigator" | Catalog match, compatibility check, pinned run. |
| "For this task, have Devin act as a strict API-contract reviewer" | Ephemeral inline `specialistSpec`, validated and run; nothing saved. |
| "Create a specialized Devin worker that audits our Terraform" | Ephemeral run first; after a useful result, offer to save it. |
| "Save that specialist for this project" | Written to `<project>/.specialists/…`. |
| "Save it for me everywhere" | Written to `~/.specialists/…`. |
| "Publish it to the team catalog" | Git branch/PR/approval flow owned by the client. |
| "Adapt our triage-investigator agent for Devin" | Claude reads the native agent, reports portable vs. lost, validates, optionally saves, runs. |
| "Create an ecosystem of case-triage specialists" | A coherent collection of independent specialists in one catalog; the client orchestrates. |
