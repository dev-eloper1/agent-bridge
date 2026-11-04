import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { remote, serve } from "../dist/server.js";
import { Runtime } from "../dist/runtime.js";
import { loadConfig } from "../dist/config.js";
import { Store, eventKind } from "../dist/store.js";
import { streamEvents } from "../dist/event-stream.js";

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "ev-"));
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    runtime: { stateDir: path.join(dir, "s"), maxConcurrentTasks: 1 },
    providers: { mock: {
      command: process.execPath,
      args: [path.join(process.cwd(), "scripts/mock-acp.mjs")],
      readOnlyEnforced: true,
    } },
    agents: { one: { provider: "mock", description: "test", workspace: "read-only" } },
  }));
  return loadConfig(file);
}
function connect(config, since) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: config.socket, path: "/events?since=" + since, agent: false }, (res) => {
      let body = "";
      const events = [];
      res.on("data", (chunk) => {
        body += chunk;
        let end;
        while ((end = body.indexOf("\n")) >= 0) {
          events.push(JSON.parse(body.slice(0, end)));
          body = body.slice(end + 1);
        }
      });
      resolve({ req, res, events });
    });
    req.on("error", reject);
  });
}
async function until(fn) {
  const deadline = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > deadline) throw Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("private socket replays, delivers live, and reconnects without gaps or duplicates", async (t) => {
  const config = fixture(t);
  const daemon = await serve(config);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.res.destroy();
    daemon.stop();
    await daemon.runtime.close();
    await until(() => !existsSync(path.join(config.stateDir, "lock")));
    rmSync(config.root, { recursive: true, force: true });
  });
  const store = daemon.runtime.store;
  const task = { taskId: "example", agentId: "one" };
  store.event(task, "task.queued", "queued");
  store.event(task, "task.started", "started");
  // Simulate a pre-PR-3 record: no stored kind.
  delete store.state.events[0].kind;
  store.save();
  const replay = await remote(config, "events", {});
  assert.deepEqual(replay.events.map((event) => event.kind), ["task.queued", "task.started"]);
  assert.equal(store.state.events[0].kind, undefined, "read must not rewrite history");
  const first = await connect(config, 1);
  clients.push(first);
  assert.equal(first.res.headers["content-type"], "application/x-ndjson");
  assert.equal(statSync(config.socket).mode & 0o777, 0o600);
  await until(() => first.events.length === 1);
  assert.equal(first.events[0].cursor, 2);
  store.event(task, "task.question", "input", true);
  await until(() => first.events.length === 2);
  assert.equal(first.events[1].kind, "task.needs_input");
  first.res.destroy();
  store.event(task, "task.completed", "done");
  const second = await connect(config, 3);
  clients.push(second);
  await until(() => second.events.length === 1);
  store.event(task, "verification.passed", "passed");
  await until(() => second.events.length === 2);
  assert.deepEqual([...first.events, ...second.events].map((e) => e.cursor), [2, 3, 4, 5]);
  assert.equal(second.events[1].kind, "verification.result");
  const invalid = await connect(config, "-1");
  clients.push(invalid);
  assert.equal(invalid.res.statusCode, 400);
});

test("stalled watcher is dropped with a bounded buffer and its subscription removed", async (t) => {
  const config = fixture(t);
  const store = new Store(config.stateDir, 100000);
  t.after(() => { store.close(); rmSync(config.root, { recursive: true, force: true }); });
  store.event({ taskId: "example", agentId: "one" }, "task.started", "started");
  class SlowResponse extends EventEmitter {
    writes = 0;
    writeHead() {}
    flushHeaders() {}
    write() { this.writes++; return false; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  const res = new SlowResponse();
  assert.equal(store.listenerCount, 0);
  streamEvents(store, res, 0);
  assert.equal(store.listenerCount, 1);
  for (let i = 0; i < 20; i++)
    store.event({ taskId: "example", agentId: "one" }, "task.progress", "progress");
  assert.equal(res.writes, 1);
  await until(() => res.destroyed);
  assert.equal(store.listenerCount, 0);
  store.save();
  assert.equal(res.writes, 1);
  assert.equal(res.listenerCount("drain"), 0);
});

test("wait ignores started and wakes early on needs-input, with the compatible shape", async (t) => {
  const config = fixture(t);
  const r = new Runtime(config);
  t.after(async () => { await r.close(); rmSync(config.root, { recursive: true, force: true }); });
  const task = await r.call("spawn", { agentId: "one", prompt: "hello", labels: ["watch"] });
  // Keep execution controlled: no provider is needed to test state notifications.
  r.schedule = () => {};
  const waiting = r.call("wait", { label: "watch", timeoutMs: 8000 });
  const current = r.store.task(task.taskId);
  current.status = "blocked_on_input";
  r.store.event(current, "task.question", "input", true);
  const result = await waiting;
  assert.equal(result.timedOut, false);
  assert.equal(result.tasks[0].status, "blocked_on_input");
  assert.equal(result.group.label, "watch");
  current.status = "queued";
  r.store.save();
  let returned = false;
  const waitingForInput = r.call("wait", { taskIds: [task.taskId], timeoutMs: 8000 })
    .then((result) => { returned = true; return result; });
  current.status = "running";
  r.store.event(current, "task.started", "started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false, "started must not settle wait");
  current.status = "blocked_on_input";
  r.store.event(current, "task.blocked", "permission", true);
  const needsInput = await waitingForInput;
  assert.equal(needsInput.timedOut, false);
  assert.equal(needsInput.tasks[0].status, "blocked_on_input");
});

test("one label wait settles six tasks despite intermediate starts and completions", async (t) => {
  const config = fixture(t);
  const r = new Runtime(config);
  r.schedule = () => {};
  t.after(async () => { await r.close(); rmSync(config.root, { recursive: true, force: true }); });
  const tasks = [];
  for (let i = 0; i < 6; i++) {
    const task = await r.call("spawn", { agentId: "one", prompt: "hello", labels: ["batch"] });
    tasks.push(r.store.task(task.taskId));
  }
  let returned = false;
  const waiting = r.call("wait", { label: "batch", timeoutMs: 8000 })
    .then((result) => { returned = true; return result; });
  for (const task of tasks) {
    task.status = "running";
    r.store.event(task, "task.started", "started");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returned, false);
  }
  for (const task of tasks.slice(0, -1)) {
    task.status = "completed";
    r.store.event(task, "task.completed", "done");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returned, false);
  }
  tasks.at(-1).status = "completed";
  r.store.event(tasks.at(-1), "task.completed", "done");
  const result = await waiting;
  assert.equal(result.timedOut, false);
  assert.equal(result.group.byStatus.completed, 6);
  assert.equal(result.tasks.length, 6);
  assert.equal(r.store.listenerCount, 0);
});

test("normalized vocabulary retains the original event type", () => {
  for (const type of ["task.queued", "task.started", "task.completed", "task.failed", "task.cancelled"])
    assert.equal(eventKind(type), type);
  assert.equal(eventKind("task.blocked"), "task.needs_input");
  assert.equal(eventKind("task.timed_out"), "task.failed");
  assert.equal(eventKind("verification.failed"), "verification.result");
  assert.equal(eventKind("agent.recovered"), "task.updated");
});
