import { Store } from "../dist/store.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Runtime } from "../dist/runtime.js";
import { loadConfig } from "../dist/config.js";
const root = process.cwd();
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-lab-"));
  const state = path.join(dir, "state");
  mkdirSync(state);
  const config = {
    version: 1,
    runtime: { stateDir: state, maxConcurrentTasks: 3, maxRuntimeMs: 5000, maxInlineChars: 500, maxArtifactBytes: 1000000 },
    providers: {
      mock: {
        command: process.execPath,
        args: [path.join(root, "scripts/mock-acp.mjs")],
        env: { MOCK_STATE: path.join(state, "mock.json"), MOCK_PID_FILE: path.join(state, "worker.pid") },
        readOnlyEnforced: true,
      },
    },
    agents: { one: { provider: "mock", description: "test", workspace: "read-only" } },
  };
  const file = path.join(dir, "agents.yaml");
  writeFileSync(file, JSON.stringify(config));
  return loadConfig(file);
}
const terminal = ["completed", "failed", "cancelled", "timed_out"];
// wait now returns on intermediate state changes; these scenarios need a settled group.
async function settledGroup(r, label) {
  const deadline = Date.now() + 8000;
  while (true) {
    const result = await r.call("wait", { label, timeoutMs: Math.max(0, deadline - Date.now()) });
    if (result.timedOut || result.group.total === Object.entries(result.group.byStatus)
      .filter(([status]) => terminal.includes(status))
      .reduce((sum, [, count]) => sum + count, 0)) return result;
  }
}
test("lab: labels filter events, parentTaskId persists, wait-by-label settles the group", async () => {
  const r = new Runtime(fixture());
  try {
    const parent = await r.call("spawn", { agentId: "one", prompt: "ping", labels: ["exp-a"] });
    const child = await r.call("spawn", { agentId: "one", prompt: "ping", labels: ["exp-a", "x2"], parentTaskId: parent.taskId });
    const other = await r.call("spawn", { agentId: "one", prompt: "ping", labels: ["exp-b"] });
    assert.equal(child.parentTaskId, parent.taskId);
    const waited = await settledGroup(r, "exp-a");
    assert.equal(waited.timedOut, false);
    assert.equal(waited.tasks.length, 2);
    assert.ok(waited.tasks.every((t) => terminal.includes(t.status) || t.status === "blocked_on_input"));
    assert.equal((await r.call("status", { taskId: child.taskId })).parentTaskId, parent.taskId);
    assert.equal((await r.call("result", { taskId: child.taskId })).parentTaskId, parent.taskId);
    assert.deepEqual((await r.call("status", { taskId: child.taskId })).labels, ["exp-a", "x2"]);
    const a = await r.call("events", { label: "exp-a", limit: 50 });
    const ids = new Set(a.events.map((e) => e.taskId));
    assert.ok(a.events.length > 0);
    assert.deepEqual([...ids].sort(), [parent.taskId, child.taskId].sort());
    const b = await r.call("events", { label: "exp-b", limit: 50 });
    assert.ok(b.events.length > 0 && b.events.every((e) => e.taskId === other.taskId));
    const all = await r.call("events", { limit: 50 });
    assert.ok(all.events.length >= a.events.length + b.events.length);
    console.log(`events: all=${all.events.length} exp-a=${a.events.length} exp-b=${b.events.length}`);
  } finally {
    r.close();
  }
});
test("lab: labels are validated and parentTaskId must exist", async () => {
  const r = new Runtime(fixture());
  try {
    const bad = [["Upper"], ["has space"], ["a/b"], ["x".repeat(49)], [""], Array.from({ length: 9 }, (_, i) => `l${i}`)];
    for (const labels of bad)
      await assert.rejects(r.call("spawn", { agentId: "one", prompt: "ping", labels }), undefined, JSON.stringify(labels));
    await assert.rejects(r.call("events", { label: "Bad Label" }));
    await assert.rejects(r.call("spawn", { agentId: "one", prompt: "ping", parentTaskId: "task_00000000-0000-0000-0000-000000000000" }));
    await assert.rejects(r.call("wait", { timeoutMs: 0 }), /exactly one/);
    await assert.rejects(r.call("wait", { label: "nobody", timeoutMs: 0 }), /No tasks/);
  } finally {
    r.close();
  }
});
test("lab: wait-by-label is not capped at 10 task ids", async () => {
  const r = new Runtime(fixture());
  try {
    for (let i = 0; i < 12; i++) await r.call("spawn", { agentId: "one", prompt: "ping", labels: ["bulk"] });
    const w = await settledGroup(r, "bulk");
    assert.equal(w.timedOut, false);
    assert.equal(w.tasks.length, 10);
    assert.deepEqual(
      { total: w.group.total, returned: w.group.returned, truncated: w.group.truncated },
      { total: 12, returned: 10, truncated: true },
    );
    assert.equal(w.group.byStatus.completed, 12);
    assert.ok(w.tasks.every((t) => terminal.includes(t.status)));
    console.log(`bulk wait: total=${w.group.total} returned=${w.tasks.length} timedOut=${w.timedOut}`);
  } finally {
    r.close();
  }
});
test("lab: wait-by-label stays bounded over thousands of retained tasks", async () => {
  const r = new Runtime(fixture());
  try {
    const seed = { agentId: "one", agentSessionId: "x", createdAt: new Date().toISOString(), summary: "s", acceptanceCriteria: [], verification: "pending", followups: [], steeringCount: 0, labels: ["big"] };
    for (let i = 0; i < 5000; i++) {
      const taskId = `task_${randomUUID()}`;
      r.store.state.tasks[taskId] = { ...seed, taskId, status: i === 4999 ? "running" : "completed" };
    }
    const t0 = performance.now();
    const w = await r.call("wait", { label: "big", timeoutMs: 0 });
    const ms = performance.now() - t0;
    const bytes = JSON.stringify(w).length;
    console.log(`5000-task wait: ms=${ms.toFixed(1)} bytes=${bytes} returned=${w.tasks.length}`);
    assert.equal(w.timedOut, true);
    assert.equal(w.tasks.length, 10);
    assert.equal(w.group.total, 5000);
    assert.equal(w.group.byStatus.running, 1);
    assert.equal(w.tasks[0].status, "running", "open tasks are returned first");
    assert.ok(ms < 500, `wait took ${ms}ms`);
    assert.ok(bytes < 20000, `response was ${bytes} bytes`);
  } finally {
    r.close();
  }
});
test("lab: persisted labels/parentTaskId are validated on reload", async () => {
  const config = fixture();
  let r = new Runtime(config);
  let id;
  try {
    id = (await r.call("spawn", { agentId: "one", prompt: "ping", labels: ["ok"] })).taskId;
    await settledGroup(r, "ok");
  } finally {
    r.close();
  }
  const store = new Store(config.runtime.stateDir, 10000);
  const good = JSON.stringify(store.state);
  for (const patch of [{ labels: "ok" }, { labels: ["Not OK"] }, { parentTaskId: id }]) {
    const s = JSON.parse(good);
    Object.assign(s.tasks[id], patch);
    store.state = s;
    store.save();
    assert.throws(() => new Runtime(config), /Invalid Agent Bridge state/, JSON.stringify(patch));
  }
  store.state = JSON.parse(good);
  store.save();
  store.close();
  r = new Runtime(config);
  try {
    assert.deepEqual((await r.call("status", { taskId: id })).labels, ["ok"]);
  } finally {
    r.close();
  }
});
