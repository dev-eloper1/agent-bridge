import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { compilePluginConfig } from "../dist/effective-config.js";
import { savePreferences, workspacePreferences } from "../dist/preferences.js";
import { identifyWorkspace } from "../dist/workspaces.js";
import { schema } from "../dist/config.js";
import { Runtime } from "../dist/runtime.js";

const root = process.cwd();
function raw(cap = 1) {
  return {
    version: 1,
    runtime: {
      maxConcurrentTasks: 2,
      taskBudgets: { experiment: { maxTasks: 3 } },
    },
    providers: {
      mock: {
        command: process.execPath,
        args: [path.join(root, "scripts/mock-acp.mjs")],
      },
    },
    agents: Object.fromEntries(
      ["one", "two", "three"].map((id) => [
        id,
        {
          provider: "mock",
          description: id,
          ...(id === "one" && cap !== undefined ? { maxConcurrent: cap } : {}),
        },
      ]),
    ),
  };
}
function fixture(cap = 1) {
  const dir = mkdtempSync(path.join(root, ".budget-pools-"));
  const config = {
    ...schema.parse(raw(cap)),
    root: dir,
    stateDir: path.join(dir, "state"),
    socket: path.join(dir, "unused.sock"),
    sourceFile: "spike-test",
    configDigest: "spike",
  };
  const runtime = new Runtime(config);
  return {
    runtime,
    config,
    async cleanup() {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function until(fn, message) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}
const spawn = (r, agentId, extra = {}) =>
  r.call("spawn", { agentId, prompt: "ASK hold slot", ...extra });
const status = (r, task) => r.store.task(task.taskId).status;

test("agent pool skips a saturated agent, global cap holds, and a released slot drains", async () => {
  const f = fixture();
  const r = f.runtime;
  try {
    const first = await spawn(r, "one");
    const second = await spawn(r, "one");
    const other = await spawn(r, "two");
    const globalWaiter = await spawn(r, "three");
    await until(
      () =>
        status(r, first) === "blocked_on_input" &&
        status(r, other) === "blocked_on_input",
      "independent agents should both run",
    );
    assert.equal(status(r, second), "queued");
    assert.equal(status(r, globalWaiter), "queued");
    assert.equal(r.active.size, 2);
    assert.equal(
      (await r.call("list", {})).find((a) => a.agentId === "one").maxConcurrent,
      1,
    );
    await r.call("cancel", { taskId: first.taskId });
    await until(
      () => status(r, second) === "blocked_on_input",
      "released agent slot should drain its queue",
    );
    assert.equal(status(r, globalWaiter), "queued");
    assert.equal(r.active.size, 2);
  } finally {
    await f.cleanup();
  }
});

test("omitting an agent cap preserves same-agent parallelism", async () => {
  const f = fixture();
  delete f.config.agents.one.maxConcurrent;
  try {
    const a = await spawn(f.runtime, "one");
    const b = await spawn(f.runtime, "one");
    await until(
      () =>
        status(f.runtime, a) === "blocked_on_input" &&
        status(f.runtime, b) === "blocked_on_input",
      "uncapped agent should use both global slots",
    );
  } finally {
    await f.cleanup();
  }
});

test("config rejects invalid caps but permits requests above the global limit", () => {
  for (const cap of [0, -1, 1.5, 17])
    assert.equal(schema.safeParse(raw(cap)).success, false, `cap ${cap}`);
  assert.equal(schema.parse(raw(2)).agents.one.maxConcurrent, 2);
  for (const maxTasks of [0, -1, 1.5]) {
    const config = raw();
    config.runtime.taskBudgets.experiment.maxTasks = maxTasks;
    assert.equal(schema.safeParse(config).success, false);
  }
  const merged = raw(2);
  merged.runtime.maxConcurrentTasks = 1;
  assert.equal(schema.parse(merged).agents.one.maxConcurrent, 2);
});

test("label task budget rejects the fourth spawn, preserves retries and survives reload", async () => {
  const f = fixture();
  let r = f.runtime;
  try {
    const first = await spawn(r, "one", {
      budgetLabel: "experiment",
      taskKey: "first",
    });
    await spawn(r, "two", { budgetLabel: "experiment" });
    await spawn(r, "three", { budgetLabel: "experiment" });
    await assert.rejects(
      spawn(r, "one", { budgetLabel: "experiment" }),
      /Task budget experiment exhausted: maxTasks=3/,
    );
    assert.equal(
      (await spawn(r, "one", { budgetLabel: "experiment", taskKey: "first" }))
        .taskId,
      first.taskId,
    );
    await assert.rejects(
      spawn(r, "one", { budgetLabel: "typo" }),
      /Unknown task budget label/,
    );
    for (const task of Object.values(r.store.state.tasks))
      await r.call("cancel", { taskId: task.taskId });
    await r.close();
    r = new Runtime(f.config);
    await assert.rejects(
      spawn(r, "one", { budgetLabel: "experiment" }),
      /maxTasks=3/,
    );
    assert.equal(Object.keys(r.store.state.tasks).length, 3);
  } finally {
    await r.close();
    await f.cleanup();
  }
});

test("cap changes preserve fingerprints and durable follow-ups after restart", async () => {
  const f = fixture();
  f.config.providers.mock.env.MOCK_STATE = path.join(
    f.config.root,
    "mock.json",
  );
  let r = f.runtime;
  try {
    const first = await spawn(r, "one", { prompt: "ping" });
    await until(() => status(r, first) === "completed", "first task completes");
    const original = { ...r.session(r.store.task(first.taskId)) };
    await r.close();
    f.config.agents.one.maxConcurrent = 2;
    r = new Runtime(f.config);
    const follow = await spawn(r, "one", {
      prompt: "ping again",
      agentSessionId: first.agentSessionId,
    });
    await until(
      () => status(r, follow) === "completed",
      "follow-up loads native conversation",
    );
    assert.equal(
      r.session(r.store.task(follow.taskId)).fingerprint,
      original.fingerprint,
    );
    assert.equal(
      r.session(r.store.task(follow.taskId)).nativeSessionId,
      original.nativeSessionId,
    );
    delete f.config.agents.one.maxConcurrent;
    const uncapped = await spawn(r, "one", {
      prompt: "ping uncapped",
      agentSessionId: first.agentSessionId,
    });
    await until(
      () => status(r, uncapped) === "completed",
      "removing cap also preserves conversation",
    );
    const fresh = await spawn(r, "one", { prompt: "fresh" });
    assert.equal(
      r.session(r.store.task(fresh.taskId)).fingerprint,
      original.fingerprint,
    );
    // Persist a pre-repair spike fingerprint, then change its scheduling cap.
    const session = r.session(r.store.task(first.taskId));
    session.fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          agent: { ...f.config.agents.one, maxConcurrent: 1 },
          provider: f.config.providers.mock,
        }),
      )
      .digest("hex");
    r.store.save();
    await r.close();
    f.config.agents.one.maxConcurrent = 2;
    r = new Runtime(f.config);
    const legacy = await spawn(r, "one", {
      prompt: "legacy follow-up",
      agentSessionId: first.agentSessionId,
    });
    await until(
      () => status(r, legacy) === "completed",
      "pre-repair conversation survives changed cap",
    );
    assert.equal(
      r.session(r.store.task(legacy.taskId)).fingerprint,
      original.fingerprint,
    );
    f.config.agents.one.description = "changed session identity";
    await assert.rejects(
      spawn(r, "one", { agentSessionId: first.agentSessionId }),
      /configuration changed/,
    );
  } finally {
    await r.close();
    await f.cleanup();
  }
});

test("workspace preference caps override defaults and global reductions clamp with diagnostics", async () => {
  const dir = mkdtempSync(path.join(root, ".budget-prefs-"));
  const oldHome = process.env.XDG_CONFIG_HOME;
  const oldConfig = process.env.AGENT_BRIDGE_CONFIG;
  let r;
  try {
    execFileSync("git", ["init", "-q", dir]);
    process.env.XDG_CONFIG_HOME = path.join(dir, "home");
    delete process.env.AGENT_BRIDGE_CONFIG;
    writeFileSync(path.join(dir, "agents.bridge.yaml"), JSON.stringify(raw(2)));
    const prefs = {
      version: 1,
      workspaceIdentity: identifyWorkspace(dir),
      agents: { one: { maxConcurrent: 1 } },
    };
    savePreferences(dir, prefs);
    let compiled = compilePluginConfig(dir);
    assert.equal(
      compiled.config.agents.one.maxConcurrent,
      1,
      "preference overrides config cap 2",
    );
    savePreferences(dir, { ...prefs, agents: {} });
    compiled = compilePluginConfig(dir);
    assert.equal(
      compiled.config.agents.one.maxConcurrent,
      2,
      "absent preference uses config default",
    );
    savePreferences(dir, {
      ...prefs,
      runtime: { maxConcurrentTasks: 1 },
      agents: { one: { maxConcurrent: 3 } },
    });
    compiled = compilePluginConfig(dir);
    assert.equal(compiled.config.runtime.maxConcurrentTasks, 1);
    assert.equal(
      compiled.config.agents.one.maxConcurrent,
      3,
      "requested preference preserved for diagnosis",
    );
    r = new Runtime(compiled.config);
    const a = await spawn(r, "one");
    const b = await spawn(r, "one");
    await until(
      () => status(r, a) === "blocked_on_input",
      "clamped worker starts",
    );
    assert.equal(status(r, b), "queued");
    const expected = {
      requestedMaxConcurrent: 3,
      effectiveMaxConcurrent: 1,
      clamped: true,
    };
    assert.deepEqual(
      (await r.call("doctor", {})).agents.one.agentConcurrency,
      expected,
    );
    assert.deepEqual(
      (await r.call("status", { taskId: b.taskId })).agentConcurrency,
      expected,
    );
    for (const maxConcurrent of [0, -1, 1.5, 17]) {
      assert.equal(
        workspacePreferences.safeParse({
          ...prefs,
          agents: { one: { maxConcurrent } },
        }).success,
        false,
      );
    }
  } finally {
    await r?.close();
    if (oldHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldHome;
    if (oldConfig === undefined) delete process.env.AGENT_BRIDGE_CONFIG;
    else process.env.AGENT_BRIDGE_CONFIG = oldConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
