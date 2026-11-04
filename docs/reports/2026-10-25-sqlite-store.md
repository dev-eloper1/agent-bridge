In plain words

Agent Bridge saves runtime state in SQLite by default while keeping the existing Store calls. It preserves the old JSON backup and now stops with a clear message when both stores contain potentially different histories. Shutdown cancels questions, waits a bounded time for pending work, then saves and closes storage.

## What changed

- Added a storage port for load, persist, append events and replay after a sequence, with SQLite and original atomic JSON adapters. No dependencies or lockfile changes.
- SQLite uses Node's built-in `node:sqlite`, WAL and `synchronous=FULL`. Each save commits entity changes, budgets and new events in one transaction. Entity JSON is keyed by collection and ID; unchanged rows are not rewritten. Events are append-only with a global integer sequence matching the existing cursor.
- Store retains validation, mutable state, save/event calls and bounded artifact handling. Runtime task/trigger persistence calls retain their existing pattern and the daemon retains its exclusive writer lock.
- JSON selection inspects any existing SQLite database and refuses it if any table contains rows, even if `state.json` is present. An initialized database with no rows permits explicit JSON selection after inspection. Unknown, unreadable or unavailable SQLite state is not silently abandoned.
- SQLite startup refuses to choose between an existing committed database and `state.json`. The diagnostic names both files; neither history is automatically archived, replaced or discarded.
- Database creation uses mode 0600, and an existing file is tightened to 0600 before SQLite opens it or writes schema/data. Tests check the database before its SQLite constructor and check database/WAL/SHM permissions under a permissive umask.
- Runtime.close() cancels all pending input/permission questions and drains in-flight calls and worker/verifier callbacks for up to five seconds. It warns on timeout, then attempts the final save and closes storage even if saving fails. Closed Store instances reject late saves on both adapters. Shutdown remains idempotent.
- The server catches a rejected shutdown promise, logs the failure, and still removes its socket and lock. Cleanup failures are also logged rather than becoming unhandled rejections.
- Architecture and ADR documentation describe selection, persistence, shutdown and recovery.

## Migration and recovery

On first SQLite startup, a valid `state.json` is validated and imported transactionally, then renamed to `state.json.bak`. Backup bytes are preserved exactly. Existing backup names are never overwritten: a collision gives the new backup a unique suffix.

An import interrupted before commit rolls back all partial writes; the JSON source remains available for retry. Corrupt JSON produces a diagnostic naming `state.json`, rather than incorrectly naming the database. A newly created database and its sidecars are removed after a failed import, so that failed attempt does not block JSON recovery. Pre-existing database files are preserved.

If startup stops after commit but before the source rename, the next startup sees **both files** and refuses to choose a history. The same refusal applies if someone restores an old JSON backup beside newer SQLite state. This repair deliberately replaces the previous behavior that automatically archived the JSON source and continued from SQLite.

For recovery:

1. Stop the daemon and preserve the whole state directory, including any database WAL, the JSON source, backups and artifacts.
2. If both `state.sqlite` and `state.json` exist, inspect both histories before choosing. To resume SQLite, move the JSON source to a separate recovery location without deleting it, then restart with SQLite. To use that JSON history, copy it into a separate state directory as `state.json` and select JSON there. Keep the SQLite directory for recovery of newer or different history.
3. To run the pre-migration backup, copy `state.json.bak` into a **separate state directory** as `state.json`, copy the matching artifacts if needed, point `runtime.stateDir` at that directory, and start with `AGENT_BRIDGE_STORAGE=json`. That backup excludes every change saved to SQLite after migration. Restoring it alongside a populated SQLite database does not bypass the refusal.
4. If `node:sqlite` is unavailable for an existing database, restart with a Node release supporting SQLite. Automatic fallback warns and only uses JSON when no database exists; it cannot safely inspect an existing database without SQLite support. Do not delete a database or WAL to force fallback. No SQLite-to-JSON export is included.

Closing the last SQLite connection normally checkpoints and removes its WAL. If a crash or another connection leaves the WAL present, keep it with the database so SQLite can recover committed transactions.

## How it was tested

Installed Node: **v26.2.0**; package.json requires **Node >=24**. No npm dependency was added.

Observed full runs in this repair round, including the TypeScript build and the stacked PR 1 catalog tests:

- `GIT_CEILING_DIRECTORIES="$PWD/tmp" TMPDIR="$PWD/tmp" npm test`: **238 passing, 0 failing, 0 skipped**.
- `GIT_CEILING_DIRECTORIES="$PWD/tmp" TMPDIR="$PWD/tmp" AGENT_BRIDGE_STORAGE=json npm test`: **238 passing, 0 failing, 0 skipped**.

Focused build/regression command: `npm run build` followed by `GIT_CEILING_DIRECTORIES="$PWD/tmp" TMPDIR="$PWD/tmp" node --test test/storage.test.mjs`: **23 passing, 0 failing**. This repair adds eight tests to the prior stacked suite. No asynchronous activity failures were reported in the successful full runs. Full suites and the daemon cleanup regression required sandbox permission for local test listeners. Scratch stayed in this worktree and was removed before completion. `git diff --check` reported no whitespace errors.

The 23 storage tests cover both adapters' persistence, changes, deletions, budgets and replay; WAL/FULL; transaction and append rollback; unchanged-row writes; SIGKILL before import commit; SQL-trigger failure during partial import; exact backup retention; corrupt-source recovery; module-load fallback and warning; invalid selection; strictly increasing event sequences across restart; worker/verifier shutdown; and successful reopen/WAL checkpoint.

Repair-specific assertions cover refusal with stale JSON beside populated SQLite and preservation of both histories; explicit JSON selection beside a truly empty initialized database; private permissions before SQLite opens the file and on its sidecars; backup-name collision suffixes; a five-second timeout on each adapter that still performs the final save and rejects a resumed late save; cancellation of orphaned input and permission questions; and socket/lock cleanup after an injected final-save failure.

Existing test changes are deliberate: the post-commit/pre-rename migration test now expects explicit conflict recovery rather than automatic archival. Its recovery fixture preserves the conflicting JSON under another name before retrying. The selection test now writes committed state before asserting refusal, since an empty initialized database is allowed. The corrupt-source test checks the correct filename and absence of a newly created empty database. Earlier PR tests continue to use Store rather than assume state.json exists, await asynchronous cleanup before directory removal/restart, and use a shorter startup fixture prefix for macOS Unix socket limits. Existing task behavior assertions were retained.

## Choices I made

- Kept `AGENT_BRIDGE_STORAGE=json|sqlite` instead of adding a configuration field.
- Applied the owner's conservative refusal to every populated SQLite database, regardless of a neighboring JSON source. Ambiguous dual histories require explicit recovery; automatic archival is no longer used in that case.
- Preserve pre-existing database files, including empty ones, rather than delete user files during recovery. Explicit JSON selection can inspect and accept an empty database when SQLite is available; module-load fallback cannot make that determination and refuses any existing database.
- Used a fixed five-second asynchronous drain deadline. A timeout is visible in the warning; final persistence and close are still attempted. Disk operations themselves are synchronous and are not bounded by that timer.
- Kept JSON entity rows and in-memory state scans for this first version. Database writes skip equal rows, but scanning work still grows with retained history.

## Risks and what is left

The requested repair is complete. Both full adapter suites have zero failures, and regression tests cover each review finding.

Events remain unpruned and fully loaded into memory. Artifacts remain outside state transactions. On drain timeout, unfinished operations are abandoned for persistence and late saves reject; the last successful transaction remains the recovery boundary if the final save fails. The shutdown deadline does not bound a blocked filesystem operation. SIGKILL and injected transaction failures do not prove survival of every power-loss or filesystem-failure scenario. JSON backups omit later SQLite changes, and comparing or reconciling divergent histories remains manual. Live event push, decision records and export tooling are outside this PR.
