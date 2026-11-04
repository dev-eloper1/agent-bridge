import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  readdirSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { serve } from "../dist/server.js";
import { Runtime } from "../dist/runtime.js";
import { schema } from "../dist/config.js";
import { Store } from "../dist/store.js";
import { JsonStorage, SqliteStorage } from "../dist/storage.js";

// Direct runtime calls in this file act as the coordinator.
delete process.env.AGENT_BRIDGE_WORKER;

const empty = () => ({ version: 1, tasks: {}, sessions: {}, events: [] });
const event = (cursor) => ({
  eventId: `evt_${cursor}`,
  cursor,
  taskId: "task",
  agentId: "agent",
  type: "test",
  timestamp: "now",
  summary: "saved",
  requiresReply: false,
  artifactRefs: [],
});
function directory(t) {
  mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });
  const dir = mkdtempSync(path.join(process.cwd(), "tmp", "storage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
for (const [name, Adapter] of [
  ["json", JsonStorage],
  ["sqlite", SqliteStorage],
]) {
  test(`${name}: storage round trip, in-place updates, deletion and event replay`, (t) => {
    const dir = directory(t);
    const storage = new Adapter(dir, DatabaseSync);
    const state = empty();
    state.sessions.agent = {
      agentSessionId: "session",
      agentId: "agent",
      fingerprint: "one",
    };
    state.triggers = { trigger: { enabled: true } };
    state.triggerBudget = { fires: [123] };
    state.events.push(event(1));
    storage.persist(state);
    state.sessions.agent.fingerprint = "two";
    delete state.triggers.trigger;
    state.events.push(event(2));
    storage.persist(state);
    storage.appendEvents([event(3)]);
    if (name === "sqlite") {
      assert.throws(() => storage.appendEvents([event(4), event(3)]));
      assert.deepEqual(storage.readEventsSince(3), []);
    }
    assert.deepEqual(storage.readEventsSince(1), [event(2), event(3)]);
    assert.equal(storage.load().sessions.agent.fingerprint, "two");
    assert.deepEqual(storage.load().triggers, {});
    assert.deepEqual(storage.load().triggerBudget, { fires: [123] });
    storage.close();
    const reopened = new Adapter(dir, DatabaseSync);
    assert.equal(reopened.load().events.length, 3);
    reopened.close();
  });
}
test("sqlite: WAL/FULL, unchanged rows and transaction rollback preserve durable state", (t) => {
  const dir = directory(t);
  let writer;
  class ObservedDatabase extends DatabaseSync {
    constructor(file) {
      super(file);
      writer = this;
    }
  }
  const storage = new SqliteStorage(dir, ObservedDatabase);
  assert.equal(writer.prepare("PRAGMA synchronous").get().synchronous, 2);
  const db = new DatabaseSync(storage.file);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  db.exec(`CREATE TRIGGER reject_session BEFORE INSERT ON entities WHEN NEW.id = 'bad'
    BEGIN SELECT RAISE(ABORT, 'rejected'); END;`);
  const state = empty();
  storage.persist(state);
  state.tasks.changed = { summary: "must roll back" };
  state.sessions.bad = {};
  assert.throws(() => storage.persist(state), /rejected/);
  assert.deepEqual(storage.load(), empty());
  db.exec("DROP TRIGGER reject_session");
  state.sessions = {};
  storage.persist(state);
  db.exec(`CREATE TRIGGER reject_update BEFORE UPDATE ON entities
    BEGIN SELECT RAISE(ABORT, 'unnecessary update'); END;`);
  storage.persist(state);
  db.close();
  storage.close();
});
test("sqlite: migration preserves backups and requires explicit recovery after commit before rename", (t) => {
  const dir = directory(t);
  const previous = process.env.AGENT_BRIDGE_STORAGE;
  process.env.AGENT_BRIDGE_STORAGE = "sqlite";
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_BRIDGE_STORAGE;
    else process.env.AGENT_BRIDGE_STORAGE = previous;
  });
  const file = path.join(dir, "state.json");
  const original = JSON.stringify(
    { ...empty(), triggerBudget: { fires: [42] } },
    null,
    2,
  );
  writeFileSync(file, original);
  let store = new Store(dir, 10000);
  assert.deepEqual(store.state.triggerBudget, { fires: [42] });
  assert.equal(readFileSync(file + ".bak", "utf8"), original);
  assert.equal(existsSync(file), false);
  store.state.triggerBudget.fires.push(43);
  store.save();
  store.close();
  // Simulate a crash after committing the import but before renaming its source.
  writeFileSync(file, original);
  assert.throws(
    () => new Store(dir, 10000),
    (error) => {
      assert.ok(error.message.includes(file));
      assert.ok(error.message.includes(path.join(dir, "state.sqlite")));
      assert.match(error.message, /Neither was changed/);
      return true;
    },
  );
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(readFileSync(file + ".bak", "utf8"), original);
  // The owner explicitly moves the conflicting JSON aside after inspecting both.
  renameSync(file, file + ".recovered");
  store = new Store(dir, 10000);
  assert.deepEqual(store.state.triggerBudget, { fires: [42, 43] });
  store.close();
});

function select(t, backend) {
  const previous = process.env.AGENT_BRIDGE_STORAGE;
  if (backend === undefined) delete process.env.AGENT_BRIDGE_STORAGE;
  else process.env.AGENT_BRIDGE_STORAGE = backend;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_BRIDGE_STORAGE;
    else process.env.AGENT_BRIDGE_STORAGE = previous;
  });
}
function migrationState() {
  return {
    ...empty(),
    sessions: {
      agent: {
        agentSessionId: "session",
        agentId: "agent",
        fingerprint: "original",
      },
    },
    tasks: {
      task: {
        taskId: "task",
        agentId: "agent",
        agentSessionId: "session",
        status: "completed",
        createdAt: "now",
        summary: "done",
        acceptanceCriteria: [],
        verification: "pending",
        followups: [],
        steeringCount: 0,
      },
    },
    events: [event(1), event(2)],
    triggers: {
      timer: {
        id: "timer",
        definition: {
          kind: "timer",
          intervalMs: 1000,
          agentId: "agent",
          prompt: "ping",
          workspace: { mode: "project" },
          overlap: "skip",
          maxFires: 6,
          windowMs: 3600000,
          maxConsecutiveFailures: 3,
        },
        enabled: true,
        seen: [],
        skipped: 0,
        fires: [42],
        consecutiveFailures: 0,
      },
    },
    triggerBudget: { fires: [42] },
  };
}

test("sqlite: killed import rolls back all rows and retry imports the complete source once", (t) => {
  select(t, "sqlite");
  const dir = directory(t);
  const state = migrationState();
  const source = JSON.stringify(state);
  writeFileSync(path.join(dir, "state.json"), source);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from 'node:sqlite';
    import { Store } from './dist/store.js';
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'COMMIT') {
        console.log(this.prepare('SELECT COUNT(*) AS n FROM entities').get().n);
        process.kill(process.pid, 'SIGKILL');
      }
      return exec.call(this, sql);
    };
    new Store(${JSON.stringify(dir)}, 10000);
  `,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.equal(
    child.stdout.trim(),
    "3",
    "interruption occurred after entities were written",
  );
  assert.equal(readFileSync(path.join(dir, "state.json"), "utf8"), source);
  const db = new DatabaseSync(path.join(dir, "state.sqlite"));
  for (const table of ["entities", "metadata", "events"])
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  db.close();
  let store = new Store(dir, 10000);
  assert.deepEqual(store.state, state);
  store.close();
  store = new Store(dir, 10000);
  assert.deepEqual(store.state, state);
  assert.deepEqual(store.readEventsSince(1), [event(2)]);
  assert.equal(readFileSync(path.join(dir, "state.json.bak"), "utf8"), source);
  store.close();
});

test("sqlite: failed partial import preserves source and a repaired retry succeeds", (t) => {
  select(t, "sqlite");
  const dir = directory(t);
  const storage = new SqliteStorage(dir, DatabaseSync);
  storage.close();
  const db = new DatabaseSync(path.join(dir, "state.sqlite"));
  db.exec(`CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN NEW.sequence = 2
    BEGIN SELECT RAISE(ABORT, 'import interrupted'); END;`);
  const state = migrationState();
  const source = JSON.stringify(state);
  const file = path.join(dir, "state.json");
  writeFileSync(file, source);
  assert.throws(
    () => new Store(dir, 10000),
    (error) => /import interrupted/.test(String(error.cause)),
  );
  assert.equal(readFileSync(file, "utf8"), source);
  assert.equal(existsSync(file + ".bak"), false);
  for (const table of ["entities", "metadata", "events"])
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  db.exec("DROP TRIGGER reject_event");
  db.close();
  const store = new Store(dir, 10000);
  assert.deepEqual(store.state, state);
  store.close();
});

test("sqlite: corrupt migration input is preserved, then a repaired source can be imported", (t) => {
  select(t, "sqlite");
  const dir = directory(t);
  const file = path.join(dir, "state.json");
  writeFileSync(file, '{"version":1');
  assert.throws(
    () => new Store(dir, 10000),
    (error) => {
      assert.ok(
        error.message.startsWith(`Invalid Agent Bridge state: ${file}.`),
      );
      assert.match(error.message, /Original file preserved/);
      return true;
    },
  );
  assert.equal(existsSync(path.join(dir, "state.sqlite")), false);
  process.env.AGENT_BRIDGE_STORAGE = "json";
  assert.throws(
    () => new Store(dir, 10000),
    /Original file preserved/,
    "no empty database blocks JSON recovery",
  );
  process.env.AGENT_BRIDGE_STORAGE = "sqlite";
  assert.equal(readFileSync(file, "utf8"), '{"version":1');
  assert.equal(existsSync(file + ".bak"), false);
  writeFileSync(file, JSON.stringify(migrationState()));
  const store = new Store(dir, 10000);
  assert.deepEqual(store.state, migrationState());
  store.close();
});

test("selection rejects unknown values and JSON for a SQLite-only directory", (t) => {
  const dir = directory(t);
  select(t, "invalid");
  assert.throws(
    () => new Store(dir, 10000),
    /Unknown AGENT_BRIDGE_STORAGE: invalid/,
  );
  assert.equal(existsSync(path.join(dir, "state.sqlite")), false);
  process.env.AGENT_BRIDGE_STORAGE = "sqlite";
  const store = new Store(dir, 10000);
  store.save();
  store.close();
  process.env.AGENT_BRIDGE_STORAGE = "json";
  assert.throws(() => new Store(dir, 10000), /Cannot select JSON/);
});

test("unavailable node:sqlite warns and falls back to JSON, but refuses an existing database", (t) => {
  const dir = directory(t);
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'node:sqlite') throw Error('sqlite disabled for test');
      return next(specifier, context);
    }});
    const { Store } = await import('./dist/store.js');
    const store = new Store(${JSON.stringify(dir)}, 10000);
    store.save();
    console.log(store.file);
    store.close();
  `;
  const run = () =>
    spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, AGENT_BRIDGE_STORAGE: "sqlite" },
    });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    /node:sqlite unavailable; falling back to JSON storage.*sqlite disabled for test/,
  );
  assert.equal(result.stdout.trim(), path.join(dir, "state.json"));
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(dir, "state.json"))),
    empty(),
  );
  const db = new DatabaseSync(path.join(dir, "state.sqlite"));
  db.close();
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Cannot fall back to JSON while a SQLite state database exists/,
  );
});

for (const backend of ["sqlite", "json"]) {
  test(`${backend}: event sequences strictly increase across restart`, (t) => {
    select(t, backend);
    const dir = directory(t);
    let store = new Store(dir, 10000);
    store.state = migrationState();
    store.save();
    store.event(store.task("task"), "before", "before restart");
    const before = store.readEventsSince(0);
    store.close();
    store = new Store(dir, 10000);
    store.event(store.task("task"), "after", "after restart");
    store.event(store.task("task"), "after", "another event");
    const after = store.readEventsSince(0);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.deepEqual(
      after.map((item) => item.cursor),
      [1, 2, 3, 4, 5],
    );
    assert.equal(new Set(after.map((item) => item.eventId)).size, 5);
    assert.deepEqual(store.readEventsSince(3), after.slice(3));
    store.close();
  });
}

for (const backend of ["sqlite", "json"]) {
  for (const verifying of [false, true]) {
    test(`${backend}: shutdown drains ${verifying ? "verification" : "worker"} callbacks before closing storage`, async (t) => {
      select(t, backend);
      const dir = directory(t);
      const config = {
        ...schema.parse({
          version: 1,
          runtime: { maxRuntimeMs: 5000 },
          providers: {
            mock: {
              command: process.execPath,
              args: [path.join(process.cwd(), "scripts/mock-acp.mjs")],
              env: { MOCK_STATE: path.join(dir, "mock.json") },
              readOnlyEnforced: true,
            },
          },
          agents: {
            agent: {
              provider: "mock",
              description: "shutdown test",
              workspace: "read-only",
            },
          },
        }),
        root: dir,
        stateDir: path.join(dir, "state"),
        socket: path.join(dir, "unused.sock"),
        sourceFile: path.join(dir, "unused.yaml"),
        configDigest: "shutdown-test",
      };
      const runtime = new Runtime(config);
      t.after(() => runtime.close());
      const task = await runtime.call("spawn", {
        agentId: "agent",
        prompt: verifying ? "ping" : "ASK shutdown",
        ...(verifying
          ? {
              verify: {
                argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
                timeoutMs: 15000,
              },
            }
          : {}),
      });
      const deadline = Date.now() + 5000;
      while (
        verifying
          ? !runtime.active.get(task.agentSessionId)?.verificationAbort
          : runtime.store.task(task.taskId).status !== "blocked_on_input"
      ) {
        assert.ok(Date.now() < deadline, "worker reached shutdown boundary");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const closing = runtime.close();
      assert.equal(runtime.close(), closing, "shutdown is idempotent");
      await closing;
      assert.equal(runtime.active.size, 0);
      await assert.rejects(
        runtime.call("spawn", { agentId: "agent", prompt: "late" }),
        /Runtime closed/,
      );
      if (backend === "sqlite") {
        assert.throws(() => runtime.store.save(), /not open/);
        assert.equal(
          existsSync(path.join(config.stateDir, "state.sqlite-wal")),
          false,
          "last connection close checkpointed WAL",
        );
        const db = new DatabaseSync(path.join(config.stateDir, "state.sqlite"));
        assert.equal(
          db.prepare("PRAGMA integrity_check").get().integrity_check,
          "ok",
        );
        db.close();
      }
      const reopened = new Store(config.stateDir, 10000);
      const saved = reopened.task(task.taskId);
      assert.equal(saved.status, verifying ? "completed" : "failed");
      if (verifying) {
        assert.equal(saved.verification, "failed");
        assert.equal(saved.verificationResult.reason, "aborted");
      }
      const count = reopened.state.events.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        reopened.readEventsSince(0).length,
        count,
        "no callbacks wrote after shutdown",
      );
      reopened.close();
    });
  }
}

test("selection refuses stale JSON alongside committed SQLite, preserving both histories", (t) => {
  select(t, "sqlite");
  const dir = directory(t);
  const file = path.join(dir, "state.json");
  const store = new Store(dir, 10000);
  store.state.triggerBudget = { fires: [99] };
  store.save();
  store.close();
  const stale = JSON.stringify({ ...empty(), triggerBudget: { fires: [42] } });
  writeFileSync(file, stale);
  process.env.AGENT_BRIDGE_STORAGE = "json";
  assert.throws(
    () => new Store(dir, 10000),
    (error) => {
      assert.match(error.message, /Cannot select JSON/);
      assert.ok(error.message.includes(path.join(dir, "state.sqlite")));
      assert.ok(error.message.includes(file));
      return true;
    },
  );
  process.env.AGENT_BRIDGE_STORAGE = "sqlite";
  assert.throws(() => new Store(dir, 10000), /Neither was changed/);
  assert.equal(readFileSync(file, "utf8"), stale);
  assert.equal(existsSync(file + ".bak"), false);
  const storage = new SqliteStorage(dir, DatabaseSync);
  assert.deepEqual(storage.load().triggerBudget, { fires: [99] });
  storage.close();
});

test("selection permits JSON beside an initialized database that has no committed state", (t) => {
  select(t, "json");
  const dir = directory(t);
  new SqliteStorage(dir, DatabaseSync).close();
  writeFileSync(path.join(dir, "state.json"), JSON.stringify(empty()));
  const store = new Store(dir, 10000);
  store.save();
  assert.equal(store.file, path.join(dir, "state.json"));
  store.close();
});

test("sqlite: database is private before SQLite opens it, including a permissive existing file", (t) => {
  const dir = directory(t);
  class CheckedDatabase extends DatabaseSync {
    constructor(file) {
      assert.equal(
        statSync(file).mode & 0o777,
        0o600,
        "private before SQLite constructor",
      );
      super(file);
    }
  }
  const previous = process.umask(0);
  try {
    for (const existing of [false, true]) {
      if (existing)
        writeFileSync(path.join(dir, "state.sqlite"), "", { mode: 0o666 });
      const storage = new SqliteStorage(dir, CheckedDatabase);
      storage.persist(empty());
      for (const name of [
        "state.sqlite",
        "state.sqlite-wal",
        "state.sqlite-shm",
      ])
        assert.equal(statSync(path.join(dir, name)).mode & 0o777, 0o600, name);
      storage.close();
      rmSync(path.join(dir, "state.sqlite"));
    }
  } finally {
    process.umask(previous);
  }
});

test("migration backup collision retains the old backup and gives the new backup a suffix", (t) => {
  select(t, "sqlite");
  const dir = directory(t);
  const file = path.join(dir, "state.json");
  const source = JSON.stringify(migrationState(), null, 2);
  const previous = "previous backup bytes";
  writeFileSync(file, source);
  writeFileSync(file + ".bak", previous);
  new Store(dir, 10000).close();
  assert.equal(readFileSync(file + ".bak", "utf8"), previous);
  const backups = readdirSync(dir).filter((name) =>
    name.startsWith("state.json.bak."),
  );
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(dir, backups[0]), "utf8"), source);
  assert.equal(existsSync(file), false);
});

function shutdownConfig(dir) {
  return {
    ...schema.parse({
      version: 1,
      providers: {
        mock: {
          command: process.execPath,
          args: [path.join(process.cwd(), "scripts/mock-acp.mjs")],
          readOnlyEnforced: true,
        },
      },
      agents: {
        agent: {
          provider: "mock",
          description: "shutdown",
          workspace: "read-only",
        },
      },
    }),
    root: dir,
    stateDir: path.join(dir, "state"),
    socket: path.join(dir, "s"),
    sourceFile: path.join(dir, "unused.yaml"),
    configDigest: "shutdown-test",
  };
}

for (const backend of ["sqlite", "json"]) {
  test(`${backend}: shutdown deadline closes storage and prevents a stalled call from saving later`, async (t) => {
    select(t, backend);
    const dir = directory(t);
    const runtime = new Runtime(shutdownConfig(dir));
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    runtime.workspace = async () => {
      await gate;
      return dir;
    };
    const pending = runtime.call("spawn", {
      agentId: "agent",
      prompt: "stalled",
      verify: { argv: [process.execPath, "-e", ""] },
    });
    const rejected = assert.rejects(pending, /not open/);
    const warnings = t.mock.method(console, "warn", () => {});
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let stopped = false;
    const closing = runtime.close().then(() => {
      stopped = true;
    });
    t.mock.timers.tick(4999);
    await Promise.resolve();
    assert.equal(stopped, false);
    t.mock.timers.tick(1);
    await closing;
    t.mock.timers.reset();
    assert.match(
      warnings.mock.calls[0].arguments[0],
      /shutdown drain timed out after 5000ms/,
    );
    assert.throws(() => runtime.store.save(), /not open/);
    const reopened = new Store(runtime.config.stateDir, 10000);
    assert.deepEqual(reopened.state.tasks, {});
    release();
    await rejected;
    assert.deepEqual(reopened.state.tasks, {});
    assert.deepEqual(reopened.readEventsSince(0), []);
    reopened.close();
  });
}

test("shutdown cancels orphaned input and permission questions and clears persisted question metadata", async (t) => {
  select(t, "sqlite");
  const dir = directory(t);
  const runtime = new Runtime(shutdownConfig(dir));
  runtime.store.state = migrationState();
  runtime.store.state.tasks.task.question = {
    questionId: "input",
    artifactRef: "artifact",
    kind: "input",
    summary: "pending",
  };
  const answers = ["input", "permission"].map(
    (kind) =>
      new Promise((resolve) => {
        runtime.questions.set(kind, {
          taskId: "task",
          kind,
          request: {},
          resolve,
        });
      }),
  );
  await runtime.close();
  assert.deepEqual(await Promise.all(answers), [
    { action: "cancel" },
    { outcome: { outcome: "cancelled" } },
  ]);
  assert.equal(runtime.questions.size, 0);
  const reopened = new Store(runtime.config.stateDir, 10000);
  assert.equal(reopened.task("task").question, undefined);
  reopened.close();
});

test("daemon stop reports a failed final save and still removes its socket and lock", async (t) => {
  select(t, "sqlite");
  const dir = directory(t);
  const config = shutdownConfig(dir);
  const { runtime, server, stop } = await serve(config);
  t.after(async () => {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await runtime.close().catch(() => {});
  });
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(runtime.store, "save", () => {
    throw Error("injected final save failure");
  });
  const serverClosed = new Promise((resolve) => server.once("close", resolve));
  stop();
  await serverClosed;
  const deadline = Date.now() + 2000;
  while (existsSync(path.join(config.stateDir, "lock"))) {
    assert.ok(Date.now() < deadline, "lock removed after failed save");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(config.socket), false);
  assert.match(
    errors.mock.calls[0].arguments[0],
    /shutdown failed:.*injected final save failure/,
  );
  assert.throws(() => runtime.store.readEventsSince(0), /not open/);
});

for (const backend of ["sqlite", "json"]) {
  test(`${backend}: throwing listeners cannot roll back saved events or skip other listeners`, (t) => {
    select(t, backend);
    const dir = directory(t);
    const store = new Store(dir, 10000);
    store.state = migrationState();
    store.save();
    const notified = [];
    store.subscribe(() => { throw Error("broken watcher"); });
    store.subscribe(() => notified.push(store.state.events.at(-1).cursor));
    assert.doesNotThrow(() => store.event(store.task("task"), "task.started", "started"));
    assert.doesNotThrow(() => store.event(store.task("task"), "task.completed", "completed"));
    assert.deepEqual(notified, [3, 4]);
    assert.deepEqual(store.state.events, store.readEventsSince(0));
    const saved = structuredClone(store.state.events);
    store.close();
    const reopened = new Store(dir, 10000);
    assert.deepEqual(reopened.state.events, saved);
    reopened.close();
  });

  test(`${backend}: failed event persistence rolls back memory without notifying and retry preserves sequence`, (t) => {
    select(t, backend);
    const dir = directory(t);
    const store = new Store(dir, 10000);
    store.state = migrationState();
    store.save();
    const before = structuredClone(store.state.events);
    let notifications = 0;
    store.subscribe(() => notifications++);
    const persist = store.storage.persist;
    store.storage.persist = () => { throw Error("injected save failure"); };
    assert.throws(() => store.event(store.task("task"), "task.started", "failed save"), /injected save failure/);
    assert.deepEqual(store.state.events, before);
    assert.deepEqual(store.readEventsSince(0), before);
    assert.equal(notifications, 0);
    store.storage.persist = persist;
    store.event(store.task("task"), "task.started", "retry");
    assert.equal(notifications, 1);
    assert.equal(store.state.events.at(-1).cursor, 3);
    const saved = structuredClone(store.state.events);
    store.close();
    const reopened = new Store(dir, 10000);
    assert.deepEqual(reopened.state.events, saved);
    reopened.close();
  });
}
