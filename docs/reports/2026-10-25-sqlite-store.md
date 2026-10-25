In plain words

Agent Bridge now saves runtime state in SQLite by default without changing how callers use Store. Existing JSON history is imported once and kept as a backup, and graceful shutdown finishes pending saves before closing the database. Users can still select the original JSON store explicitly.

## What changed

- Added a storage port for loading state, persisting changes, appending events and reading events after a sequence, with JSON and SQLite adapters. No dependencies or lockfile changes.
- SQLite uses Node's built-in `node:sqlite`, WAL and `synchronous=FULL`. Each save commits entity changes, metadata/budgets and new events in one transaction. Entity JSON is keyed by collection and ID; unchanged rows are not rewritten and deleted entities are removed.
- Events are append-only rows with a global integer sequence matching the existing cursor. Replay after a sequence and strictly increasing cursors across restart are tested on both stores.
- Store retains state validation, mutable state, save/event calls and bounded artifact handling. Runtime task/trigger persistence calls retain their existing pattern; the daemon's exclusive lock remains the single-writer boundary.
- Graceful Runtime.close() now returns an idempotent promise: it stops scheduling, interrupts workers/verifiers, drains in-flight calls and execution callbacks, saves, and explicitly closes storage. Read-only status/history access remains available after stop. The server waits for database shutdown before removing its lock.
- Updated ARCHITECTURE.md and ADR-001-runtime.md with selection, migration, shutdown and recovery details.

## Migration and recovery

On first SQLite startup, a valid `state.json` is validated and imported in one transaction. Only after commit is that file renamed to `state.json.bak`; its bytes are preserved exactly. An existing backup is kept and a unique suffix is used for the next one. A committed SQLite database is authoritative if startup stopped between commit and rename, so stale JSON cannot overwrite newer database history.

An import interrupted before commit rolls back, including partially written entities and events. Its JSON source remains available and the next startup can retry the full import. Corrupt JSON is preserved with a recovery diagnostic; repair it or restore a valid source before retrying. Database errors do not silently switch the daemon to an empty store.

To recover an existing SQLite history, first stop the daemon and preserve its entire state directory. Restart with a Node release that supports `node:sqlite`. Keep any remaining WAL with the database: it can contain committed state needed for SQLite's recovery. Closing the last connection normally checkpoints and removes the WAL; shutdown tests observed this and reopened the database with a successful integrity check.

To run the old JSON backup instead, copy `state.json.bak` to `state.json` in a **separate state directory**, copy the matching `artifacts/` if needed, point `runtime.stateDir` at that directory, and start with `AGENT_BRIDGE_STORAGE=json`. This returns to the history present at migration time; it does **not** include later SQLite changes. Keep the original SQLite directory for recovery of newer history. There is no automatic export back to JSON.

## How it was tested

Installed Node: **v26.2.0**. package.json requires **Node >=24**. SQLite is built in; no npm dependency was added.

Observed successful full runs in round 2, both including the TypeScript build:

- `GIT_CEILING_DIRECTORIES="$PWD/tmp" TMPDIR="$PWD/tmp" npm test`: **226 passing, 0 failing, 0 skipped**.
- `GIT_CEILING_DIRECTORIES="$PWD/tmp" TMPDIR="$PWD/tmp" AGENT_BRIDGE_STORAGE=json npm test`: **226 passing, 0 failing, 0 skipped**.

Focused checks run during this round:

- `node --test test/storage.test.mjs`: **11 passing, 0 failing** before adding the four shutdown tests.
- `npm run build` followed by `GIT_CEILING_DIRECTORIES="$PWD/tmp" TMPDIR="$PWD/tmp" node --test test/storage.test.mjs test/budget-pools.test.mjs test/depends-on.test.mjs test/trigger-to-task.test.mjs`: **50 passing, 0 failing** after shutdown fixes.
- `git diff --check`: no whitespace errors.

The final suite includes 15 storage tests covering:

- Both adapters' persistence, in-place changes, deletions, budgets and ordered replay.
- WAL/FULL settings, save rollback, unchanged-row writes and atomic append rollback.
- Exact backup preservation and repeat startup after commit before source rename.
- A child process killed with SIGKILL after writing import entities but before commit; recovery observes zero committed entity, metadata or event rows and successfully imports the full source once.
- An SQL-trigger failure on the second imported event, rollback of partial writes, and a successful retry.
- Corrupt-source preservation and successful import after repair, using a fixture containing tasks, sessions, triggers, budgets and events.
- A module-load hook making `node:sqlite` unavailable: JSON fallback and warning, plus refusal to abandon an existing database.
- Invalid adapter selection and refusal of JSON for a SQLite-only directory.
- Increasing, nonduplicated event IDs/cursors across close and reopen on both adapters.
- Shutdown during a blocked worker and active verification, draining late callbacks, idempotent stop, final persisted outcomes, database closure, WAL checkpoint and successful reopen.

Initial round-2 full runs exposed test cleanup that deleted directories before the new asynchronous shutdown completed, and new verification tests initially inherited worker-mode restrictions. Cleanup now awaits shutdown, and direct coordinator tests explicitly clear the worker marker, matching existing coordinator fixtures. Final full runs above have zero failures and no reported asynchronous activity after tests ended. Local listeners and daemon/worker processes were started only by tests; full suites needed sandbox permission for listeners. Git discovery is bounded because required scratch files are inside this worktree.

Existing test changes are limited to persistence assumptions and shutdown ordering. Verification-recovery and persisted-label-validation fixtures use Store instead of assuming state.json exists. Recovery now reopens Store after awaiting runtime shutdown to restore its crash snapshot. Budget, dependency, trigger, verification and seatbelt cleanup/restart fixtures await close before deleting directories or reopening state. The startup-error fixture has a shorter scratch prefix to fit macOS Unix socket limits. Existing behavior assertions were retained.

## Choices I made

- Used `AGENT_BRIDGE_STORAGE=json|sqlite` instead of adding a configuration field, keeping storage selection out of runtime task/trigger logic.
- Kept the owner's approved conservative SQLite-to-JSON refusal. Explicit JSON selection refuses a SQLite-only directory; automatic module-load fallback also refuses an existing SQLite database. Recovery through the old backup is documented above rather than adding export tooling.
- Only module-load failure triggers JSON fallback with a warning. Database open, validation and persistence failures remain errors.
- Kept JSON entity rows and an in-memory state scan for this first version. Unchanged database rows are not rewritten, but scanning work still grows with retained history.
- Shutdown awaits in-flight callbacks instead of closing SQLite while worker or verifier callbacks can still save. The exclusive daemon lock is held through that drain.

## Risks and what is left

All requested PR 2 work is complete. Migration, fallback/selection, shutdown and event-sequence tests are in place; both adapter suites are green; architecture, ADR and this report are finalized.

Events remain unpruned and fully loaded into memory for facade compatibility. Save scans still grow with retained state. Artifacts remain outside the state transaction. Graceful stop waits for in-flight operations to settle; forced termination relies on SQLite recovery. The SIGKILL and transaction-failure tests do not prove survival of every power-loss or filesystem-failure scenario. The JSON backup predates all post-migration SQLite changes, and no SQLite-to-JSON export is included. Live event push and decision records remain for later PRs.
