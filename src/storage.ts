import {
  existsSync,
  readFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { State, Event } from "./store.js";

export interface StoragePort {
  readonly file: string;
  load(): unknown;
  persist(state: State): void;
  appendEvents(events: Event[]): void;
  readEventsSince(sequence: number): Event[];
  close(): void;
}

export class JsonStorage implements StoragePort {
  readonly file: string;
  constructor(readonly dir: string) {
    this.file = path.join(dir, "state.json");
  }
  load(): unknown {
    return existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : undefined;
  }
  persist(state: State) {
    const tmp = this.file + ".tmp";
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    const d = openSync(this.dir, "r");
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
  }
  appendEvents(events: Event[]) {
    const state = (this.load() ?? {
      version: 1,
      tasks: {},
      sessions: {},
      events: [],
    }) as State;
    state.events.push(...events);
    this.persist(state);
  }
  readEventsSince(sequence: number) {
    return ((this.load() as State | undefined)?.events ?? []).filter(
      (event) => event.cursor > sequence,
    );
  }
  close() {}
}

export class SqliteStorage implements StoragePort {
  readonly file: string;
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(dir: string, Database: typeof DatabaseSync) {
    this.file = path.join(dir, "state.sqlite");
    this.db = new Database(this.file);
    try {
      chmodSync(this.file, 0o600);
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS entities (
          kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY (kind, id)
        );
        CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, json TEXT NOT NULL);
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  load(): unknown {
    const metadata = this.db
      .prepare("SELECT json FROM metadata WHERE id = 1")
      .get();
    if (!metadata) return undefined;
    const state = JSON.parse(metadata.json as string) as State;
    state.tasks = {};
    state.sessions = {};
    for (const row of this.db
      .prepare("SELECT kind, id, json FROM entities")
      .all()) {
      const kind = row.kind as "tasks" | "sessions" | "triggers";
      (state[kind] ??= {} as never)[row.id as string] = JSON.parse(
        row.json as string,
      );
    }
    state.events = this.readEventsSince(0);
    return state;
  }
  persist(state: State) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const upsert = this.db
        .prepare(`INSERT INTO entities (kind, id, json) VALUES (?, ?, ?)
        ON CONFLICT(kind, id) DO UPDATE SET json=excluded.json WHERE json != excluded.json`);
      const remove = this.db.prepare(
        "DELETE FROM entities WHERE kind = ? AND id = ?",
      );
      for (const kind of ["tasks", "sessions", "triggers"] as const) {
        const values = state[kind] ?? {};
        for (const row of this.db
          .prepare("SELECT id FROM entities WHERE kind = ?")
          .all(kind))
          if (!Object.hasOwn(values, row.id as string))
            remove.run(kind, row.id);
        for (const [id, value] of Object.entries(values))
          upsert.run(kind, id, JSON.stringify(value));
      }
      const { tasks, sessions, triggers, events, ...metadata } = state;
      const json = JSON.stringify({
        ...metadata,
        ...(triggers ? { triggers: {} } : {}),
      });
      this.db
        .prepare(
          `INSERT INTO metadata (id, json) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET json=excluded.json WHERE json != excluded.json`,
        )
        .run(json);
      const last = this.db
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events")
        .get()!;
      this.appendEvents(
        events.filter((event) => event.cursor > Number(last.sequence)),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  appendEvents(events: Event[]) {
    this.db.exec("SAVEPOINT append_events");
    try {
      const insert = this.db.prepare(
        "INSERT INTO events (sequence, json) VALUES (?, ?)",
      );
      for (const event of events)
        insert.run(event.cursor, JSON.stringify(event));
      this.db.exec("RELEASE append_events");
    } catch (error) {
      this.db.exec("ROLLBACK TO append_events; RELEASE append_events");
      throw error;
    }
  }
  readEventsSince(sequence: number): Event[] {
    return this.db
      .prepare("SELECT json FROM events WHERE sequence > ? ORDER BY sequence")
      .all(sequence)
      .map((row) => JSON.parse(row.json as string));
  }
  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

export function createStorage(dir: string): StoragePort {
  const backend = process.env.AGENT_BRIDGE_STORAGE ?? "sqlite";
  if (!["json", "sqlite"].includes(backend))
    throw Error(`Unknown AGENT_BRIDGE_STORAGE: ${backend}`);
  if (backend === "json") {
    if (
      existsSync(path.join(dir, "state.sqlite")) &&
      !existsSync(path.join(dir, "state.json"))
    )
      throw Error(
        "Cannot select JSON for a SQLite-only state directory; export or use a separate state directory.",
      );
    return new JsonStorage(dir);
  }
  let Database: typeof DatabaseSync;
  try {
    Database = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
  } catch (error) {
    console.warn(
      `Agent Bridge: node:sqlite unavailable; falling back to JSON storage: ${error}`,
    );
    if (existsSync(path.join(dir, "state.sqlite")))
      throw Error(
        "Cannot fall back to JSON while a SQLite state database exists; use a Node version with node:sqlite support.",
      );
    return new JsonStorage(dir);
  }
  return new SqliteStorage(dir, Database);
}
