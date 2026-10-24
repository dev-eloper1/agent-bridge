import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Runtime, inputs } from "../dist/runtime.js";
import { schema } from "../dist/config.js";

const root = process.cwd();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (predicate(value)) return value;
    await pause(10);
  }
  throw Error("Dependency test condition timed out");
}
function fixture(t, maxConcurrentTasks = 2) {
  const dir = mkdtempSync(path.join(root, ".depends-on-"));
  const config = {
    ...schema.parse({
      version: 1,
      runtime: { maxConcurrentTasks, maxRuntimeMs: 5000 },
      providers: {
        mock: {
          command: process.execPath,
          args: [path.join(root, "scripts/mock-acp.mjs")],
          env: { MOCK_STATE: path.join(dir, "mock.json") },
          readOnlyEnforced: true,
        },
      },
      agents: {
        demo: {
          provider: "mock",
          description: "dependency test",
          workspace: "read-only",
        },
      },
    }),
    root: dir,
    stateDir: path.join(dir, "state"),
    socket: path.join(dir, "unused.sock"),
    sourceFile: path.join(dir, "unused.yaml"),
    configDigest: "lab-depends-on",
  };
  const r = new Runtime(config);
  t.after(async () => {
    if (!r.closed) r.close();
    await until(
      () => r.active.size,
      (size) => size === 0,
    );
    rmSync(dir, { recursive: true, force: true });
  });
  return r;
}
const spawn = (r, prompt, dependsOn) =>
  r.call("spawn", {
    agentId: "demo",
    prompt,
    ...(dependsOn === undefined ? {} : { dependsOn }),
  });
const status = (r, task) => r.call("status", { taskId: task.taskId });
const waitStatus = (r, task, expected) =>
  until(
    () => status(r, task),
    (value) => value.status === expected,
  );
async function release(r, task) {
  const blocked = await waitStatus(r, task, "blocked_on_input");
  await r.call("reply", {
    taskId: task.taskId,
    questionId: blocked.question.questionId,
    message: "continue",
  });
  return waitStatus(r, task, "completed");
}

test("lab: fan-out/join waits for BOTH mock tasks and starts after completion", async (t) => {
  const r = fixture(t, 3); // A spare slot proves C is gated by dependencies.
  const a = await spawn(r, "ASK A");
  const b = await spawn(r, "ASK B");
  const c = await spawn(r, "join", [a.taskId, b.taskId]);
  await waitStatus(r, a, "blocked_on_input");
  await waitStatus(r, b, "blocked_on_input");
  assert.equal((await status(r, c)).status, "queued");
  assert.equal(r.active.size, 2);
  const finishedA = await release(r, a);
  assert.equal((await status(r, c)).status, "queued");
  assert.equal((await status(r, c)).startedAt, undefined);
  const finishedB = await release(r, b);
  const finishedC = await waitStatus(r, c, "completed");
  assert.ok(finishedC.startedAt >= finishedA.finishedAt);
  assert.ok(finishedC.startedAt >= finishedB.finishedAt);
  assert.deepEqual(finishedC.dependsOn, [a.taskId, b.taskId]);
});

test("lab: mock provider crash fails dependents transitively with dependency IDs", async (t) => {
  const r = fixture(t);
  const a = await spawn(r, "CRASH");
  const c = await spawn(r, "join", [a.taskId]);
  const d = await spawn(r, "downstream", [c.taskId]);
  await waitStatus(r, a, "failed");
  const failedC = await waitStatus(r, c, "failed");
  const failedD = await waitStatus(r, d, "failed");
  assert.ok(failedC.summary.includes(a.taskId));
  assert.ok(failedD.summary.includes(c.taskId));
  assert.equal(failedC.startedAt, undefined);
  assert.equal(failedD.startedAt, undefined);
});

for (const running of [false, true]) {
  test(`lab: cancelling a ${running ? "running" : "queued"} dependency fails its join`, async (t) => {
    const r = fixture(t);
    const a = await spawn(r, "ASK A");
    const c = await spawn(r, "join", [a.taskId]);
    if (running) await waitStatus(r, a, "blocked_on_input");
    await r.call("cancel", { taskId: a.taskId });
    const failed = await waitStatus(r, c, "failed");
    assert.ok(failed.summary.includes(a.taskId));
    assert.match(failed.summary, /cancelled/);
    assert.equal(failed.startedAt, undefined);
  });
}

test("lab: unknown dependency rejected atomically; schema validates task IDs", async (t) => {
  const r = fixture(t);
  const missing = `task_${randomUUID()}`;
  await assert.rejects(spawn(r, "invalid", [missing]), {
    message: `Unknown dependency: ${missing}`,
  });
  assert.equal(Object.keys(r.store.state.tasks).length, 0);
  assert.equal(Object.keys(r.store.state.sessions).length, 0);
  assert.throws(() =>
    inputs.spawn.parse({
      agentId: "demo",
      prompt: "invalid",
      dependsOn: ["garbage"],
    }),
  );
  const noDeps = await spawn(r, "empty dependency list", []);
  await waitStatus(r, noDeps, "completed");
});

test("lab: dependency wait consumes no slot and does not block unrelated queued work", async (t) => {
  const r = fixture(t, 2);
  const a = await spawn(r, "ASK A");
  const c = await spawn(r, "join", [a.taskId]);
  await waitStatus(r, a, "blocked_on_input");
  assert.equal(r.active.size, 1);
  const unrelated = await spawn(r, "independent");
  await waitStatus(r, unrelated, "completed");
  assert.equal((await status(r, c)).status, "queued");
  assert.equal((await status(r, a)).status, "blocked_on_input");
  await release(r, a);
  await waitStatus(r, c, "completed");
});

test("lab: failed dependencies propagate even with all slots occupied", async (t) => {
  const r = fixture(t, 1);
  const busy = await spawn(r, "ASK busy");
  await waitStatus(r, busy, "blocked_on_input");
  const a = await spawn(r, "queued A");
  const c = await spawn(r, "join", [a.taskId]);
  await r.call("cancel", { taskId: a.taskId });
  const failed = await waitStatus(r, c, "failed");
  assert.ok(failed.summary.includes(a.taskId));
  assert.equal(r.active.size, 1);
  await release(r, busy);
});

test("lab: delayed queued-cancel wakes dependents without unrelated scheduler activity", async (t) => {
  const r = fixture(t, 1);
  const busy = await spawn(r, "ASK busy");
  await waitStatus(r, busy, "blocked_on_input");
  const a = await spawn(r, "queued A");
  const c = await spawn(r, "join", [a.taskId]);
  // Drain spawn-triggered scheduler passes before testing the finish-triggered one.
  await pause(100);
  assert.equal((await status(r, a)).status, "queued");
  assert.equal((await status(r, c)).status, "queued");
  await r.call("cancel", { taskId: a.taskId });
  const failed = await until(
    () => status(r, c),
    (value) => value.status === "failed",
    1000,
  );
  assert.ok(failed.summary.includes(a.taskId));
  assert.match(failed.summary, /cancelled/);
  assert.equal(failed.startedAt, undefined);
  assert.equal((await status(r, busy)).status, "blocked_on_input");
  assert.equal(r.active.size, 1);
  await release(r, busy);
});

test("lab: status explains dependency waits and clears reason after readiness", async (t) => {
  const r = fixture(t, 1);
  const a = await spawn(r, "ASK A");
  await waitStatus(r, a, "blocked_on_input");
  const c = await spawn(r, "join", [a.taskId]);
  const independent = await spawn(r, "queued independent");
  assert.equal(c.queueReason, "waiting_on_dependency");
  assert.equal((await status(r, c)).queueReason, "waiting_on_dependency");
  assert.equal((await status(r, independent)).queueReason, undefined);
  await release(r, a);
  const finished = await waitStatus(r, c, "completed");
  assert.equal(finished.queueReason, undefined);
  await waitStatus(r, independent, "completed");
});

test("lab: restart preserves queued dependency graph and resumes in dependency order", async (t) => {
  const r = fixture(t, 1);
  const a = await spawn(r, "ASK queued A");
  const c = await spawn(r, "join", [a.taskId]);
  // Close before the pending setImmediate spawn passes: both tasks stay queued.
  r.close();
  assert.equal((await status(r, a)).status, "queued");
  assert.equal((await status(r, c)).status, "queued");
  const restarted = new Runtime(r.config);
  try {
    assert.deepEqual((await status(restarted, c)).dependsOn, [a.taskId]);
    assert.equal(
      (await status(restarted, c)).queueReason,
      "waiting_on_dependency",
    );
    restarted.start();
    await waitStatus(restarted, a, "blocked_on_input");
    assert.equal((await status(restarted, c)).status, "queued");
    const finishedA = await release(restarted, a);
    const finishedC = await waitStatus(restarted, c, "completed");
    assert.ok(finishedC.startedAt >= finishedA.finishedAt);
    assert.equal(finishedC.queueReason, undefined);
  } finally {
    restarted.close();
    await until(
      () => restarted.active.size,
      (size) => size === 0,
    );
  }
});

// Direct runtime calls in this file act as the coordinator in both test modes.
delete process.env.AGENT_BRIDGE_WORKER;
const check = (code) => ({
  argv: [process.execPath, "-e", code],
  timeoutMs: 2000,
});

test("D11: passed verification releases dependents only after the verdict", async (t) => {
  const r = fixture(t, 3);
  const a = await r.call("spawn", {
    agentId: "demo",
    prompt: "ASK verified dependency",
    verify: check("setTimeout(() => {}, 300)"),
  });
  const b = await spawn(r, "dependent", [a.taskId]);
  await release(r, a);
  assert.equal((await status(r, a)).verification, "pending");
  r.schedule(); // A spare slot cannot bypass verification after worker completion.
  assert.equal((await status(r, b)).status, "queued");
  assert.equal((await status(r, b)).queueReason, "waiting_on_dependency");
  await until(
    () => status(r, a),
    (value) => value.verification === "passed",
  );
  assert.equal((await waitStatus(r, b, "completed")).status, "completed");
});

test("D11: failed, tampered and errored verification fail dependents with the dependency and verdict", async (t) => {
  for (const [reason, spec] of [
    ["exit", check("process.exit(7)")],
    [
      "tampered",
      check("require('node:fs').writeFileSync('package.json', '{}')"),
    ],
    [
      "spawn_error",
      { argv: [path.join(root, ".missing-d11-verifier")], timeoutMs: 2000 },
    ],
    ["error", check("0")],
  ]) {
    const r = fixture(t, 3);
    if (reason === "error") {
      const append = r.append.bind(r);
      r.append = (task, name, value) => {
        if (name === "verification.txt")
          throw Error("injected verification storage failure");
        return append(task, name, value);
      };
    }
    const a = await r.call("spawn", {
      agentId: "demo",
      prompt: "ASK failing dependency",
      verify: spec,
    });
    const b = await spawn(r, "dependent", [a.taskId]);
    const c = await spawn(r, "transitive dependent", [b.taskId]);
    await release(r, a);
    const failed = await waitStatus(r, b, "failed");
    assert.ok(failed.summary.includes(a.taskId));
    assert.ok(failed.summary.includes(`verification failed: ${reason}`));
    assert.equal(failed.startedAt, undefined);
    assert.equal((await status(r, a)).verification, "failed");
    assert.ok((await waitStatus(r, c, "failed")).summary.includes(b.taskId));
  }
});

test("D11: dependencies without verify still release on completed with a pending verdict", async (t) => {
  const r = fixture(t);
  const a = await spawn(r, "ASK unchecked dependency");
  const b = await spawn(r, "dependent", [a.taskId]);
  await release(r, a);
  assert.equal((await status(r, a)).verification, "pending");
  assert.equal((await waitStatus(r, b, "completed")).status, "completed");
});

test("I2: labelled fan-out, agent caps, trigger reserve and verified join compose", async (t) => {
  const r = fixture(t, 2);
  r.config.agents.demo.maxConcurrent = 1;
  r.config.agents.other = { ...r.config.agents.demo };
  r.config.runtime.taskBudgets = { fanout: { maxTasks: 3 } };
  const dispatches = [];
  const run = r.run.bind(r);
  r.run = (task) => {
    const before = r.active.size;
    const result = run(task);
    dispatches.push({
      taskId: task.taskId,
      trigger: Boolean(task.triggerId),
      before,
      agents: [...r.active.values()].map((a) => a.task.agentId),
      dependenciesReady: (task.dependsOn ?? []).every((id) => r.dependencyReady(id)),
    });
    return result;
  };
  const fan = (agentId, prompt, parentTaskId) => r.call("spawn", {
    agentId, prompt, labels: ["i2-fanout"], budgetLabel: "fanout",
    ...(parentTaskId ? { parentTaskId } : {}),
  });
  const a = await fan("demo", "ASK first fan-out");
  const b = await fan("demo", "ASK second fan-out", a.taskId);
  await waitStatus(r, a, "blocked_on_input");
  assert.equal((await status(r, b)).status, "queued", "per-agent cap queues the second demo");
  const trigger = r.triggers.create({
    kind: "event", agentId: "other", prompt: "ASK unattended probe",
    workspace: { mode: "project" },
  });
  const fired = await r.triggers.fireEvent(trigger.id, "i2-event");
  assert.equal(fired.outcome, "spawned");
  const unattended = r.store.task(fired.taskId);
  assert.equal(unattended.status, "queued", "trigger cannot consume the reserved final slot");
  const c = await fan("other", "ASK third fan-out", a.taskId);
  await waitStatus(r, c, "blocked_on_input");
  assert.equal(r.active.size, 2, "interactive work uses the reserved slot across agents");
  await assert.rejects(fan("other", "over budget"), /exhausted/);
  const join = await r.call("spawn", {
    agentId: "demo", prompt: "ASK join", labels: ["i2-join"],
    parentTaskId: a.taskId, dependsOn: [a.taskId, b.taskId, c.taskId],
    verify: check("setTimeout(() => {}, 300)"),
  });
  const downstream = await r.call("spawn", {
    agentId: "other", prompt: "after verified join", dependsOn: [join.taskId],
  });
  assert.equal((await status(r, join)).queueReason, "waiting_on_dependency");
  const finishedC = await release(r, c);
  assert.equal(unattended.status, "queued", "reserve still applies with the other agent idle");
  const finishedA = await release(r, a);
  await waitStatus(r, b, "blocked_on_input");
  assert.equal(unattended.status, "queued");
  assert.equal((await status(r, join)).startedAt, undefined);
  const finishedB = await release(r, b);
  const runningJoin = await waitStatus(r, join, "blocked_on_input");
  await waitStatus(r, unattended, "blocked_on_input");
  for (const dependency of [finishedA, finishedB, finishedC])
    assert.ok(runningJoin.startedAt >= dependency.finishedAt);
  assert.ok(finishedB.startedAt >= finishedA.finishedAt);
  assert.equal(runningJoin.parentTaskId, a.taskId);
  const group = await r.call("wait", { label: "i2-fanout", timeoutMs: 1000 });
  assert.equal(group.timedOut, false);
  assert.equal(group.group.total, 3);
  assert.equal(group.group.byStatus.completed, 3);
  assert.equal(group.tasks.length, 3);
  await release(r, unattended);
  await release(r, join);
  assert.equal((await status(r, join)).verification, "pending");
  r.schedule();
  assert.equal((await status(r, downstream)).status, "queued", "D11 gates the spare slot on verification");
  await until(() => status(r, join), (value) => value.verification === "passed");
  await waitStatus(r, downstream, "completed");
  assert.equal(dispatches.length, 6);
  for (const dispatch of dispatches) {
    assert.ok(dispatch.dependenciesReady, `dependency gate at ${dispatch.taskId}`);
    assert.ok(dispatch.agents.length <= 2, "global concurrency cap");
    for (const agent of ["demo", "other"])
      assert.ok(dispatch.agents.filter((id) => id === agent).length <= 1, `${agent} cap at ${dispatch.taskId}`);
    if (dispatch.trigger) assert.ok(dispatch.before < 1, "trigger leaves an interactive slot");
  }
});
