import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Runtime } from "../dist/runtime.js";
import { loadConfig } from "../dist/config.js";
import { MIN_INTERVAL_MS, MAX_TRIGGERS } from "../dist/triggers.js";

function fixture(t) {
  const dir = mkdtempSync(path.join(process.cwd(), ".trigger-test-"));
  const file = path.join(dir, "agents.yaml");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      runtime: { stateDir: path.join(dir, "state") },
      providers: {
        mock: {
          command: process.execPath,
          args: [path.join(process.cwd(), "scripts/mock-acp.mjs")],
          env: { MOCK_STATE: path.join(dir, "mock.json") },
          readOnlyEnforced: true,
        },
      },
      agents: {
        demo: {
          provider: "mock",
          description: "trigger mock",
          workspace: "read-only",
        },
      },
    }),
  );
  const config = loadConfig(file);
  let now = 10000;
  const runtimes = [];
  const reload = () => {
    const r = new Runtime(config, () => now);
    runtimes.push(r);
    return r;
  };
  t.after(async () => {
    for (const r of runtimes) await r.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    reload,
    advance: (ms) => {
      now += ms;
    },
  };
}
const definition = (kind = "timer") => ({
  kind,
  ...(kind === "timer" ? { intervalMs: MIN_INTERVAL_MS } : {}),
  agentId: "demo",
  prompt: "trigger evidence",
  workspace: { mode: "project" },
  overlap: "skip",
});
const tasks = (r) => Object.values(r.store.state.tasks);
async function completed(r, id) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const task = r.store.task(id);
    if (task.status === "completed") return task;
    if (task.status === "failed") assert.fail(task.summary);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Mock task did not complete within 1 second");
}

test("lab: timer creates exactly one real mock ACP task per fire with injected clock", async (t) => {
  const f = fixture(t);
  const r = f.reload();
  const trigger = r.triggers.create(definition());
  await r.triggers.tick();
  assert.equal(tasks(r).length, 0);
  f.advance(1000);
  await r.triggers.tick();
  assert.equal(tasks(r).length, 1);
  const first = tasks(r)[0];
  await completed(r, first.taskId);
  assert.match(
    r.store.readArtifactText(first.taskId, "output.txt"),
    /trigger evidence/,
  );
  assert.deepEqual(first.workspace, { mode: "project" });
  f.advance(1000);
  await r.triggers.tick();
  assert.equal(tasks(r).length, 2);
  await completed(r, tasks(r)[1].taskId);
  assert.equal(r.triggers.list()[0].id, trigger.id);
});

test("lab: event dedupe survives reload and concurrent duplicate calls", async (t) => {
  const f = fixture(t);
  let r = f.reload();
  const trigger = r.triggers.create(definition("event"));
  const outcomes = await Promise.all([
    r.triggers.fireEvent(trigger.id, "event-1"),
    r.triggers.fireEvent(trigger.id, "event-1"),
  ]);
  assert.deepEqual(
    outcomes.map((x) => x.outcome),
    ["spawned", "duplicate"],
  );
  assert.equal(tasks(r).length, 1);
  await completed(r, tasks(r)[0].taskId);
  await r.close();
  r = f.reload();
  assert.equal(
    (await r.triggers.fireEvent(trigger.id, "event-1")).outcome,
    "duplicate",
  );
  assert.equal(tasks(r).length, 1);
  assert.equal(
    (await r.triggers.fireEvent(trigger.id, "event-2")).outcome,
    "spawned",
  );
  assert.equal(tasks(r).length, 2);
});

test("lab: overlap skip records a skipped fire without queueing, including distinct events", async (t) => {
  const f = fixture(t);
  const r = f.reload();
  const timer = r.triggers.create(definition());
  f.advance(1000);
  await r.triggers.tick();
  assert.equal(tasks(r)[0].status, "queued");
  r.schedule();
  assert.equal(tasks(r)[0].status, "running");
  f.advance(1000);
  await r.triggers.tick();
  assert.equal(tasks(r).length, 1);
  assert.equal(r.triggers.list()[0].skipped, 1);
  assert.equal(r.triggers.list()[0].lastOutcome, "skipped");
  assert.equal(r.triggers.list()[0].nextAt, 13000);
  const event = r.triggers.create(definition("event"));
  await r.triggers.fireEvent(event.id, "a");
  assert.equal((await r.triggers.fireEvent(event.id, "b")).outcome, "skipped");
  assert.equal(
    (await r.triggers.fireEvent(event.id, "b")).outcome,
    "duplicate",
  );
  assert.equal(tasks(r).length, 2);
  assert.equal(r.triggers.list().find((x) => x.id === timer.id).skipped, 1);
});

test("lab: downtime catches up at most once and persisted skip policy still applies", async (t) => {
  const f = fixture(t);
  let r = f.reload();
  const trigger = r.triggers.create(definition());
  await r.close();
  f.advance(1000 * 10000);
  r = f.reload();
  await r.triggers.tick();
  await r.triggers.tick();
  assert.equal(tasks(r).length, 1);
  assert.equal(r.triggers.list()[0].id, trigger.id);
  await r.close();
  f.advance(5000);
  r = f.reload();
  await r.triggers.tick();
  assert.equal(tasks(r).length, 1); // Previous queued task survived restart.
  assert.equal(r.triggers.list()[0].skipped, 1);
});

test("lab: bounds, agent/prompt/workspace validation, disable and remove persist", async (t) => {
  const f = fixture(t);
  let r = f.reload();
  for (const bad of [
    { intervalMs: 999 },
    { intervalMs: 1.5 },
    { agentId: "missing" },
    { agentId: "toString" },
    { prompt: " " },
    { prompt: "x".repeat(16001) },
    { overlap: "queue" },
    { workspace: { mode: "directory", path: "does-not-exist" } },
  ])
    assert.throws(() => r.triggers.create({ ...definition(), ...bad }));
  const timer = r.triggers.create(definition());
  const event = r.triggers.create(definition("event"));
  r.triggers.disable(timer.id);
  r.triggers.disable(event.id);
  f.advance(5000);
  await r.triggers.tick();
  assert.equal((await r.triggers.fireEvent(event.id, "a")).outcome, "disabled");
  assert.equal(tasks(r).length, 0);
  assert.throws(() => r.triggers.delete("toString"), /Unknown/);
  r.triggers.delete(timer.id);
  assert.throws(() => r.triggers.delete(timer.id), /Unknown/);
  await r.close();
  r = f.reload();
  assert.equal(r.triggers.list().length, 1);
  assert.equal(r.triggers.list()[0].enabled, false);
  for (let i = 1; i < MAX_TRIGGERS; i++) r.triggers.create(definition("event"));
  assert.throws(() => r.triggers.create(definition("event")), /limit/);
  await r.close();
  await r.triggers.tick();
  assert.equal(tasks(r).length, 0);
});

test("lab: runtime start owns scheduler tick and close stops it", async (t) => {
  const f = fixture(t);
  const r = f.reload();
  r.triggers.create(definition());
  f.advance(1000);
  r.start();
  r.start();
  assert.equal(tasks(r).length, 1);
  await completed(r, tasks(r)[0].taskId);
  await r.close();
  f.advance(1000);
  await r.triggers.tick();
  assert.equal(tasks(r).length, 1);
});

test("lab repair: per-trigger rolling fire cap records reason and survives reload", async (t) => {
  const f = fixture(t);
  let r = f.reload();
  const trigger = r.triggers.create({
    ...definition("event"),
    maxFires: 2,
    windowMs: 1000,
  });
  for (const id of ["a", "b"]) {
    const fire = await r.triggers.fireEvent(trigger.id, id);
    assert.equal(fire.outcome, "spawned");
    r.finish(
      r.store.task(fire.taskId),
      "completed",
      "synthetic budget fixture completion",
    );
  }
  const skipped = await r.triggers.fireEvent(trigger.id, "c");
  assert.deepEqual(skipped, { outcome: "skipped", reason: "trigger_fire_cap" });
  assert.equal(tasks(r).length, 2);
  await r.close();
  r = f.reload();
  assert.equal(
    (await r.triggers.fireEvent(trigger.id, "d")).reason,
    "trigger_fire_cap",
  );
  assert.equal(r.triggers.list()[0].skipped, 2);
  assert.equal(r.triggers.list()[0].lastSkipReason, "trigger_fire_cap");
  f.advance(1000);
  assert.equal(
    (await r.triggers.fireEvent(trigger.id, "e")).outcome,
    "spawned",
  );
});

test("lab repair: aggregate fire cap bounds concurrent storm and survives deletion/reload", async (t) => {
  const { GLOBAL_MAX_FIRES, GLOBAL_WINDOW_MS } = await import(
    "../dist/triggers.js"
  );
  const f = fixture(t);
  let r = f.reload();
  const triggers = Array.from({ length: GLOBAL_MAX_FIRES + 1 }, () =>
    r.triggers.create(definition("event")),
  );
  const results = await Promise.all(
    triggers.map((tr) => r.triggers.fireEvent(tr.id, "storm")),
  );
  assert.equal(
    results.filter((x) => x.outcome === "spawned").length,
    GLOBAL_MAX_FIRES,
  );
  assert.equal(tasks(r).length, GLOBAL_MAX_FIRES);
  assert.deepEqual(results.at(-1), {
    outcome: "skipped",
    reason: "global_fire_cap",
  });
  assert.equal(r.triggers.list().at(-1).lastSkipReason, "global_fire_cap");
  for (const task of tasks(r))
    r.finish(task, "completed", "synthetic aggregate fixture completion");
  for (const tr of triggers) r.triggers.delete(tr.id);
  await r.close();
  r = f.reload();
  const fresh = r.triggers.create(definition("event"));
  assert.equal(
    (await r.triggers.fireEvent(fresh.id, "new")).reason,
    "global_fire_cap",
  );
  f.advance(GLOBAL_WINDOW_MS);
  assert.equal(
    (await r.triggers.fireEvent(fresh.id, "after-window")).outcome,
    "spawned",
  );
});

async function failed(r, id) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const task = r.store.task(id);
    if (task.status === "failed") return task;
    if (task.status === "completed")
      assert.fail("Expected mock refusal to fail");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Mock refusal did not fail within 1 second");
}

test("lab repair: three real mock failures auto-disable, with streak persisted across reload", async (t) => {
  const f = fixture(t);
  let r = f.reload();
  const tr = r.triggers.create({ ...definition("event"), prompt: "REFUSE" });
  assert.equal(tr.definition.maxConsecutiveFailures, 3);
  for (let i = 1; i <= 3; i++) {
    const fire = await r.triggers.fireEvent(tr.id, `failure-${i}`);
    assert.equal(fire.outcome, "spawned");
    const task = await failed(r, fire.taskId);
    assert.match(task.summary, /refusal/);
    assert.equal(r.triggers.list()[0].consecutiveFailures, i);
    r.triggers.taskFinished(task); // Duplicate notification must not double-count.
    assert.equal(r.triggers.list()[0].consecutiveFailures, i);
    if (i === 2) {
      await r.close();
      r = f.reload();
    }
  }
  assert.equal(r.triggers.list()[0].enabled, false);
  assert.equal(r.triggers.list()[0].disabledReason, "consecutive_failures:3");
  assert.equal(
    (await r.triggers.fireEvent(tr.id, "fourth")).outcome,
    "disabled",
  );
  assert.equal(tasks(r).length, 3);
  await r.close();
  r = f.reload();
  assert.equal(r.triggers.list()[0].enabled, false);
  assert.equal(r.triggers.list()[0].disabledReason, "consecutive_failures:3");
});

test("lab repair: successful task resets consecutive failure streak", async (t) => {
  const r = fixture(t).reload();
  const tr = r.triggers.create(definition("event"));
  for (const [i, status] of [
    "failed",
    "failed",
    "completed",
    "failed",
  ].entries()) {
    const fire = await r.triggers.fireEvent(tr.id, `reset-${i}`);
    r.finish(
      r.store.task(fire.taskId),
      status,
      "synthetic streak fixture outcome",
    );
  }
  assert.equal(r.triggers.list()[0].consecutiveFailures, 1);
  assert.equal(r.triggers.list()[0].enabled, true);
});

test("lab repair: trigger work leaves final concurrency slot for interactive task behind it", async (t) => {
  const r = fixture(t).reload();
  const a = r.triggers.create({ ...definition("event"), prompt: "SLOW" });
  const b = r.triggers.create({ ...definition("event"), prompt: "SLOW" });
  const first = await r.triggers.fireEvent(a.id, "a");
  const second = await r.triggers.fireEvent(b.id, "b");
  const interactive = await r.call("spawn", {
    agentId: "demo",
    prompt: "SLOW",
  });
  assert.equal(r.store.task(interactive.taskId).triggerId, undefined);
  r.schedule();
  assert.equal(r.store.task(first.taskId).status, "running");
  assert.equal(r.store.task(second.taskId).status, "queued");
  assert.equal(r.store.task(interactive.taskId).status, "running");
  assert.equal(r.active.size, 2);
});

test("lab repair: concurrency one reserves its only slot for interactive work", async (t) => {
  const r = fixture(t).reload();
  r.config.runtime.maxConcurrentTasks = 1;
  const tr = r.triggers.create(definition("event"));
  const fire = await r.triggers.fireEvent(tr.id, "one-slot");
  const interactive = await r.call("spawn", {
    agentId: "demo",
    prompt: "SLOW",
  });
  r.schedule();
  assert.equal(r.store.task(fire.taskId).status, "queued");
  assert.equal(r.store.task(interactive.taskId).status, "running");
  assert.equal(r.active.size, 1);
});

test("lab repair: startup tick tags timer tasks before scheduler can use reserved slot", async (t) => {
  const f = fixture(t);
  const r = f.reload();
  r.config.runtime.maxConcurrentTasks = 1;
  r.triggers.create(definition());
  f.advance(1000);
  r.start();
  assert.equal(tasks(r).length, 1);
  assert.ok(tasks(r)[0].triggerId);
  assert.equal(tasks(r)[0].status, "queued");
  assert.equal(r.active.size, 0);
  await Promise.resolve();
});

test("lab repair: queued legacy trigger task is tagged on reload before scheduling", async (t) => {
  const f = fixture(t);
  let r = f.reload();
  const tr = r.triggers.create(definition("event"));
  const fire = await r.triggers.fireEvent(tr.id, "legacy");
  delete r.store.task(fire.taskId).triggerId;
  r.store.save();
  await r.close();
  r = f.reload();
  r.config.runtime.maxConcurrentTasks = 1;
  r.schedule();
  assert.equal(r.store.task(fire.taskId).triggerId, tr.id);
  assert.equal(r.store.task(fire.taskId).status, "queued");
});
