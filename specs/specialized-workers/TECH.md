# Specialized Workers — Implementation Plan

## Context

Implements [PRODUCT.md](PRODUCT.md). This supersedes the earlier registry and agent-repo drafts (`specs/local-agent-registry/`, `specs/agent-repos/`): there is no separate management plugin, and nothing from those drafts shipped — no released-user migration.

Terminology: **worker profile** = Devin/Codex/Pi configuration and capabilities; **specialization** = provider-independent behavior/requirements/output contract; **specialized worker** = profile + specialization + assignment; **catalog** = read-only view over `.specialists` folders; **one-off specialization** = inline `specialistSpec`, no files.

## Proposed changes — Agent Bridge

### 1. `src/specialists.ts`

Exports:

- `specialistSpecDefinition`: the strict declarative fields (`format`, `namespace`, `id`, `name`, `version`, `description`, `instructions`, `delivery`, `providers?`, `requiresReadOnly?`, `acceptanceCriteria?`).
- `specialistRef`: `<namespace>/<id>` or `<catalog>:<namespace>/<id>`.
- `specialistSnapshot` / `SpecialistSnapshot`: definition plus `catalog`, `reference`, `source`, `digest`.
- `catalogRoots(config)`: `project` → `<root>/.specialists`, `global` → `~/.specialists`, then configured `specialistCatalogs` roots. Reserved names: `project`, `global`, `inline`.
- `resolveSpecialist`, `listSpecialists`, `specialistMetadata`, `validateSpecialistBinding`, `inlineSpecialist`.
- Persisted layout `<catalog>/<namespace>/<id>/specialist.yaml`; optional `catalog.yaml` ignored in v1.
- Fail-closed file protections, bounded listing (≤100 per catalog), per-entry bounded errors, ambiguity-with-qualified-matches failure, instructions omitted in broad listings — all unchanged from the prior draft.
- Inline snapshot: `catalog: "inline"`, `reference: "inline:<namespace>/<id>"`, `source: "inline"`, same strict schema/digest/binding.

### 2. Configuration: `specialistCatalogs`

```yaml
specialistCatalogs:
  channels:
    path: /absolute/or/config-relative/path-to-.specialists
```

Defaults `{}`, `~/` expansion, config-relative resolution, reserved IDs rejected. `src/project-config.ts` preserves the resolved map. No compatibility for the unshipped `registries`/`agentRepos` keys.

### 3. Runtime and store

- Inputs add `specialists_schema` (empty object), `specialists_validate` (`{specialistSpec, agentId?}`), `specialists_catalog` (`{query?, reference?, agentId?}`).
- `agents_run`/`agents_spawn` accept exactly one of `template` (legacy), `specialistRef`, `specialistSpec` — mutual exclusivity enforced before launch.
- `specialists_schema` returns a bounded explicit contract: required/optional fields, allowed delivery values, project/global/configured/inline locations and path layout, a bounded `availableCatalogs` mapping of actual resolved catalog roots (so authoring can target empty configured catalogs), the declarative-data prohibition, and the statement that provider/model/tools/permissions belong to worker profiles — never Zod internals.
- `specialists_validate` performs no writes: builds the inline snapshot, returns metadata/digest plus `binding` or `bindingError`; unknown `agentId` is an error.
- `specialists_catalog` keeps the existing discovery semantics.
- Inline specs resolve, validate, pin and merge criteria identically to persisted ones; `repo`-style metadata is `catalog: "inline"`.
- Persisted session field `specialistSnapshot`; task exposes compact `specialist` metadata `{reference, namespace, id, name, version, digest, catalog, delivery}`. Legacy `template` fields untouched; existing released state without the fields stays loadable.
- Pinning, follow-up reuse, differing ref/spec rejection, criteria merging and instruction delivery are unchanged.

### 4. MCP surface

- Register `specialists_schema`, `specialists_validate`, `specialists_catalog` with those exact names (the generic `agents_*` loop must not produce `agents_specialists_*`; register explicitly or prefix-map).
- `agents_run`/`agents_spawn` descriptions: exactly one of `template` | `specialistRef` | `specialistSpec`; natural language, no commands.
- Total tools: 17 (14 generic + 3 specialist). No create/update/delete/publish specialist tools — management is the client's file tools plus the `specialize` skill.
- Plugin recursion (`AGENT_BRIDGE_WORKER=1`) still disables all tools.

### 5. Skills

- `skills/specialize/SKILL.md`: the natural-language authoring contract — ephemeral-first, scope inference from `specialists_schema`'s `availableCatalogs` (covers empty configured roots), adapt-existing-agent flow with portable-vs-lost report, `specialists_validate` before write/run, update with diff, single-specialist and whole-ecosystem/catalog deletion with enumerated impact + explicit confirmation (contents deletion vs. configured-catalog unregistration distinguished), promotion via normal Git/PR, ecosystem = independent specialists orchestrated by the client, Bridge never writes, never claim instructions enforce permissions.
- `skills/delegate/SKILL.md`: persisted `specialistRef` via `specialists_catalog`, inline `specialistSpec` via `specialists_validate`; ordinary delegation skips catalog; no silent fallback.
- `skills/status/SKILL.md`: update only if terminology leaks into status output.

### 6. Docs and tests

- Terminology across `README.md`, `docs/CLAUDE_PLUGIN.md`, `docs/USAGE.md`, `docs/WORKER_SETTINGS.md`, `docs/ROADMAP.md`, `docs/PLAN.md`, `docs/SPECIALIZED_AGENTS.md`, `src/cli.ts` help: specialized worker, specialization, catalog, `.specialists`, `specialistCatalogs`. Legacy saved definitions named as compatibility only.
- `test/specialists.test.mjs` covers: project/global/configured roots; reserved names including `inline`; strict safety/path mismatch/ambiguity/bounds; catalog list/query/exact/binding; schema contract through runtime and MCP; validate digest/metadata/bindingError with no filesystem writes; persisted `specialistRef` run/pin/edit-delete-restart; inline `specialistSpec` run/pin/criteria/restart; all exclusivity pairs and all three; differing follow-up rejection; legacy templates unchanged; broad listing omits instructions; tool count 17.
- `test/plugin.test.mjs` fixture `.specialists/<ns>/<id>/specialist.yaml`, exact `specialists_*` tool names.
- Style rule: no `//` comments added in source or tests (project policy).

## Proposed changes — Hivemind (ctk worktree)

- Move the pilot specialist to `.specialists/hivemind/triage-investigator/specialist.yaml` (same approved content; file renamed, `agents/` level removed).
- Update `toolkit/commands/hivemind/case.md` and `toolkit/skills/hivemind-triage/SKILL.md`: same routing policy, new path/reference wording; `allowed-tools` uses `specialists_catalog`/`specialists_validate`/`specialists_schema` instead of the draft `agents_catalog`; execution tools unchanged.
- Update `toolkit/hooks/external_write_guard.py` allowlist for the specialist tool names; keep `agents_define` and `agents_dashboard` blocked (the only approved protected-file edit).
- Update `toolkit/tests/test_ctk.py` contract test, `.gitignore` and `GUIDE.md` wording to the settled terminology.

## Verification

Agent Bridge (this worktree, `node_modules` symlink recreated then removed):

```sh
npm test
git diff --check
```

Hivemind (ctk worktree):

```sh
python3 -m unittest toolkit.tests.test_ctk.TestInitAndHook.test_external_write_guard
python3 -m unittest toolkit.tests.test_ctk.TestCommandNamespace
python3 -m unittest discover -s toolkit/tests -p 'test_ctk.py'
git diff --check
```

Cross-schema: validate the moved Hivemind `specialist.yaml` against `specialistSpecDefinition` via `dist/specialists.js` + `yaml.parse` (success marker, exit 0). No live daemon or provider smoke without separate approval.

## Risks

| Risk | Mitigation |
|---|---|
| `specialize` skill writes outside intended catalogs | Host guards/approvals govern file tools; Bridge has no write path at all |
| Inline specs bypass file checks | Same strict schema + digest; marked `catalog: "inline"` so provenance is explicit |
| Adapted specialists silently lose host capabilities | Mandatory portable-vs-lost compatibility report before writing or running |
| Tool-name prefix collisions (`agents_specialists_*`) | Explicit registration/name mapping; plugin test asserts exact tool list count and names |
| Destructive deletes | Exact resolve + impact summary + explicit confirmation; pinned conversations survive |
| Tool allowlist drift in Hivemind guard | Focused guard test covers allowed and blocked tool names |
| Comments added during pivot | Policy reminder: no new `//` comments in source/tests |

## Sequencing

Work proceeds sequentially across the existing worktrees: Agent Bridge first (this worktree, `scratch/devin/local-agent-registry`), then Hivemind (`tool/2026-10-22-bhus-add-agent-bridge-local-agent-registry-integration` in the ctk worktree), since Hivemind's specialist path, allowed tools and contract test depend on the settled Bridge API. Neither repo vendors or commits the other. The stale backup worktrees remain untouched.
