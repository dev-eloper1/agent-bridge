import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Runtime } from "../dist/runtime.js";
import { loadConfig } from "../dist/config.js";
import { remote } from "../dist/server.js";
const root = process.cwd();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, predicate, timeout = 9000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const x = await fn();
    if (predicate(x)) return x;
    await pause(20);
  }
  throw Error("Condition timed out");
}
function fixture({
  writable = false,
  maxRuntimeMs = 5000,
  sessionConfig,
  extraArgs = [],
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-rel-"));
  const state = path.join(dir, "state");
  mkdirSync(state);
  if (writable) {
    execFileSync("git", ["init", "-q", dir]);
    writeFileSync(path.join(dir, "seed"), "seed");
    execFileSync("git", ["-C", dir, "add", "seed"]);
    execFileSync("git", [
      "-C",
      dir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
  }
  const agent = (workspace) => ({
    provider: "mock",
    description: "test",
    workspace,
    ...(sessionConfig ? { sessionConfig } : {}),
  });
  const config = {
    version: 1,
    runtime: {
      stateDir: state,
      maxConcurrentTasks: 2,
      maxRuntimeMs,
      maxInlineChars: 500,
      maxArtifactBytes: 1000000,
    },
    providers: {
      mock: {
        command: process.execPath,
        args: [path.join(root, "scripts/mock-acp.mjs"), ...extraArgs],
        env: {
          MOCK_STATE: path.join(state, "mock.json"),
          MOCK_TOOL_SECRET: "configured-secret-value-12345",
        },
        envNames: ["AB_TEST_EMPTY_VAR"],
        readOnlyEnforced: true,
      },
    },
    agents: {
      one: agent(writable ? "isolated-worktree" : "read-only"),
      two: agent("read-only"),
    },
  };
  const file = path.join(dir, "agents.yaml");
  writeFileSync(file, JSON.stringify(config));
  return { dir, file, state, config: loadConfig(file) };
}
const done = (r, id) =>
  until(
    () => r.call("status", { taskId: id }),
    (t) => ["completed", "failed", "cancelled", "timed_out"].includes(t.status),
  );
const appliedConfig = (f, nativeSessionId) =>
  JSON.parse(
    readFileSync(
      path.join(f.state, `mock.json-${nativeSessionId}.json.config`),
      "utf8",
    ),
  );
test("configured session options apply on new and loaded sessions, and bypass avoids the permission question", async () => {
  const f = fixture({
    writable: true,
    sessionConfig: { mode: "bypass" },
  });
  let r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "PERMISSION" });
    const result = await done(r, a.taskId);
    assert.equal(result.status, "completed");
    assert.equal(result.question, undefined);
    assert.equal(result.sessionConfig.effective.mode, "bypass");
    assert.equal(result.sessionConfig.requested.mode, "bypass");
    const session = r.store.state.sessions[a.agentId];
    assert.equal(session.sessionConfig.effective.mode, "bypass");
    assert.deepEqual(appliedConfig(f, session.nativeSessionId).applied, [
      { configId: "mode", value: "bypass" },
    ]);
    const listed = (await r.call("list", {})).find((x) => x.agentId === "one");
    assert.equal(listed.configuredSession.mode, "bypass");
    assert.equal(listed.sessions[0].sessionConfig.effective.mode, "bypass");
    r.close();
    r = new Runtime(f.config);
    const b = await r.call("spawn", {
      agentId: "one",
      prompt: "PERMISSION followup",
      agentSessionId: a.agentSessionId,
    });
    const second = await done(r, b.taskId);
    assert.equal(second.status, "completed");
    assert.equal(second.sessionConfig.effective.mode, "bypass");
    assert.equal(second.question, undefined);
    assert.equal(r.store.state.sessions[a.agentId].recovery, "loaded");
  } finally {
    r.close();
  }
});
test("grouped select, boolean and mode options apply in insertion order", async () => {
  const f = fixture({
    writable: true,
    sessionConfig: { review: "strict", telemetry: true, mode: "bypass" },
  });
  const r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "PERMISSION" });
    const result = await done(r, a.taskId);
    assert.equal(result.status, "completed");
    assert.equal(result.question, undefined);
    assert.deepEqual(result.sessionConfig.effective, {
      review: "strict",
      telemetry: true,
      mode: "bypass",
    });
    const session = r.store.state.sessions[a.agentId];
    assert.deepEqual(appliedConfig(f, session.nativeSessionId).applied, [
      { configId: "review", value: "strict" },
      { configId: "telemetry", value: true },
      { configId: "mode", value: "bypass" },
    ]);
  } finally {
    r.close();
  }
});
test("an unconfirmed set_config_option response fails before prompting", async () => {
  const f = fixture({
    sessionConfig: { mode: "bypass" },
    extraArgs: ["--ignore-config-update"],
  });
  const r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "never" });
    const result = await done(r, a.taskId);
    assert.equal(result.status, "failed");
    assert.match(
      result.summary,
      /did not confirm session option "mode"="bypass"/,
    );
    assert.equal(
      r.store.artifactSize(a.taskId, "transcript.jsonl"),
      undefined,
      "no prompt reached the backend without a confirmed option",
    );
  } finally {
    r.close();
  }
});
test("unsupported or unadvertised session config fails before prompting", async () => {
  const f = fixture({ sessionConfig: { mode: "extreme" } });
  const r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "never" });
    const result = await done(r, a.taskId);
    assert.equal(result.status, "failed");
    assert.match(result.summary, /must be one of: ask, bypass/);
    assert.equal(
      r.store.artifactSize(a.taskId, "transcript.jsonl"),
      undefined,
      "no prompt reached the backend before config validation failed",
    );
  } finally {
    r.close();
  }
  const g = fixture({ sessionConfig: { nonexistent: "x" } });
  const r2 = new Runtime(g.config);
  try {
    const t = await r2.call("spawn", { agentId: "one", prompt: "never" });
    const result = await done(r2, t.taskId);
    assert.equal(result.status, "failed");
    assert.match(result.summary, /not advertised.*mode, review, telemetry/s);
  } finally {
    r2.close();
  }
  const h = fixture({
    sessionConfig: { mode: "bypass" },
    extraArgs: ["--legacy-modes"],
  });
  const r3 = new Runtime(h.config);
  try {
    const t = await r3.call("spawn", { agentId: "one", prompt: "PERMISSION" });
    const result = await done(r3, t.taskId);
    assert.equal(result.status, "completed");
    assert.equal(result.sessionConfig.effective.mode, "bypass");
  } finally {
    r3.close();
  }
});
test("spawn schema rejects dynamic sessionConfig escalation", async () => {
  const f = fixture({ writable: true });
  const r = new Runtime(f.config);
  try {
    await assert.rejects(
      r.call("spawn", {
        agentId: "one",
        prompt: "x",
        sessionConfig: { mode: "bypass" },
      }),
    );
  } finally {
    r.close();
  }
});
test("permission question exposes a bounded sanitized toolCall and allow_session stays refused", async () => {
  const f = fixture({ writable: true });
  const r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "PERMISSION" });
    const q = await until(
      () => r.call("status", { taskId: a.taskId }),
      (t) => t.status === "blocked_on_input",
    );
    assert.equal(q.question.toolCall.toolCallId, "write-1");
    assert.equal(q.question.toolCall.title, "Write a file");
    assert.equal(q.question.toolCall.kind, "edit");
    assert.equal(q.question.toolCall.input.length, 2000);
    assert.match(q.question.toolCall.input, /"command":\s*"write"/);
    assert.doesNotMatch(
      q.question.toolCall.input,
      /configured-secret-value-12345/,
    );
    assert.match(q.question.toolCall.input, /\[REDACTED\]/);
    assert.ok(
      q.question.options.some((o) => o.kind === "allow_always"),
      "fixture offers a persistent allow option",
    );
    await assert.rejects(
      r.call("reply", {
        taskId: a.taskId,
        questionId: q.question.questionId,
        optionId: "session",
      }),
      /allow_once or reject_once/,
    );
    await r.call("reply", {
      taskId: a.taskId,
      questionId: q.question.questionId,
      optionId: "once",
    });
    assert.equal((await done(r, a.taskId)).status, "completed");
  } finally {
    r.close();
  }
});
test("a reply after an exhausted budget times out without emitting task.replied", async () => {
  const f = fixture({ writable: true });
  const r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "PERMISSION" });
    const blocked = await until(
      () => r.call("status", { taskId: a.taskId }),
      (t) => t.status === "blocked_on_input",
    );
    r.active.get(a.agentSessionId).remainingMs = 0;
    await assert.rejects(
      r.call("reply", {
        taskId: a.taskId,
        questionId: blocked.question.questionId,
        optionId: "once",
      }),
      /Runtime budget exceeded/,
    );
    assert.equal((await done(r, a.taskId)).status, "timed_out");
    const events = (await r.call("events", {})).events.filter(
      (e) => e.taskId === a.taskId,
    );
    const timedOut = events.findIndex((e) => e.type === "task.timed_out");
    assert.ok(timedOut >= 0);
    assert.equal(
      events.some((e, i) => e.type === "task.replied" && i > timedOut),
      false,
    );
  } finally {
    r.close();
  }
});
test("blocked time does not consume the runtime budget", async () => {
  const f = fixture({ maxRuntimeMs: 1000 });
  const r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "ASK label" });
    const blocked = await until(
      () => r.call("status", { taskId: a.taskId }),
      (t) => t.status === "blocked_on_input",
    );
    await pause(1500);
    await r.call("reply", {
      taskId: a.taskId,
      questionId: blocked.question.questionId,
      message: "violet",
    });
    assert.equal((await done(r, a.taskId)).status, "completed");
  } finally {
    r.close();
  }
});
test("a permission-blocked profile queues same-agent work while other profiles still run", async () => {
  const f = fixture({ writable: true });
  const r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "PERMISSION" });
    const blocked = await until(
      () => r.call("status", { taskId: a.taskId }),
      (t) => t.status === "blocked_on_input",
    );
    const b = await r.call("spawn", { agentId: "one", prompt: "queued work" });
    assert.equal(b.status, "queued");
    assert.equal(b.queuePosition, 1);
    assert.equal(b.queueReason, "agent_waiting_for_permission");
    assert.equal(b.concurrencyLimit, 2);
    assert.equal(b.activeTasks, 1);
    assert.equal(b.queuedTasks, 1);
    const c = await r.call("spawn", { agentId: "two", prompt: "parallel" });
    assert.equal((await done(r, c.taskId)).status, "completed");
    assert.equal(
      (await r.call("status", { taskId: b.taskId })).status,
      "queued",
    );
    await r.call("reply", {
      taskId: a.taskId,
      questionId: blocked.question.questionId,
      optionId: "deny",
    });
    assert.equal((await done(r, a.taskId)).status, "completed");
    assert.equal((await done(r, b.taskId)).status, "completed");
    const finished = await r.call("status", { taskId: b.taskId });
    assert.equal(finished.queuePosition, undefined);
    assert.equal(finished.queueReason, undefined);
  } finally {
    r.close();
  }
});
test("agents_wait returns the lean bounded task shape", async () => {
  const f = fixture();
  const r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "quick" });
    const waited = await r.call("wait", {
      taskIds: [a.taskId],
      timeoutMs: 8000,
    });
    assert.equal(waited.tasks[0].status, "completed");
    assert.deepEqual(
      Object.keys(waited.tasks[0]).sort(),
      [
        "activeTasks",
        "activity",
        "agentId",
        "agentSessionId",
        "concurrencyLimit",
        "description",
        "execution",
        "queuePosition",
        "queueReason",
        "queuedTasks",
        "question",
        "status",
        "taskId",
        "workerName",
      ].sort(),
    );
  } finally {
    r.close();
  }
});
test("doctor reports sanitized configuration without environment values", async () => {
  const f = fixture({ sessionConfig: { mode: "bypass" } });
  const had = "AB_TEST_EMPTY_VAR" in process.env;
  const prior = process.env.AB_TEST_EMPTY_VAR;
  process.env.AB_TEST_EMPTY_VAR = "";
  const r = new Runtime(f.config);
  try {
    const d = await r.call("doctor", {});
    assert.equal(d.configFile, realpathSync(f.file));
    assert.equal(d.workspace, realpathSync(f.dir));
    assert.equal(d.socket, f.config.socket);
    assert.equal(d.daemon.pid, process.pid);
    assert.equal(d.runtime.maxConcurrentTasks, 2);
    assert.equal(d.agents.one.sessionConfig.mode, "bypass");
    assert.equal(d.providers.mock.command, process.execPath);
    assert.deepEqual(d.providers.mock.configuredEnv.sort(), [
      "MOCK_STATE",
      "MOCK_TOOL_SECRET",
    ]);
    assert.equal(d.providers.mock.inheritedEnv.PATH, undefined);
    assert.equal(
      d.providers.mock.inheritedEnv.AB_TEST_EMPTY_VAR,
      "set",
      "an explicitly empty inherited variable is still set",
    );
    const text = JSON.stringify(d);
    assert.doesNotMatch(text, /configured-secret-value-12345/);
  } finally {
    r.close();
    if (had) process.env.AB_TEST_EMPTY_VAR = prior;
    else delete process.env.AB_TEST_EMPTY_VAR;
  }
});
test("plugin doctor reports reachability and restart refuses while work is active", async () => {
  const f = fixture();
  const env = { ...process.env, AGENT_BRIDGE_CONFIG: f.file };
  const cli = (...args) =>
    execFileSync(process.execPath, [path.join(root, "dist/cli.js"), ...args], {
      cwd: f.dir,
      env,
      encoding: "utf8",
    });
  const offline = JSON.parse(cli("plugin-doctor"));
  assert.equal(offline.reachable, false);
  assert.equal(offline.daemon.running, false);
  assert.equal(offline.configFile, realpathSync(f.file));
  assert.equal(offline.socket, f.config.socket);
  const daemon = spawn(
    process.execPath,
    [path.join(root, "dist/cli.js"), "--config", f.file, "serve"],
    { cwd: root, stdio: "ignore" },
  );
  try {
    await until(async () => {
      try {
        return await remote(f.config, "list");
      } catch {
        return null;
      }
    }, Boolean);
    const live = JSON.parse(cli("plugin-doctor"));
    assert.equal(live.reachable, true);
    assert.equal(live.daemon.pid > 0, true);
    const a = await remote(f.config, "spawn", {
      agentId: "one",
      prompt: "SLOW",
    });
    await until(
      () => remote(f.config, "status", { taskId: a.taskId }),
      (t) => t.status === "running",
    );
    assert.throws(
      () => cli("plugin-restart"),
      /Refusing to restart: 1 nonterminal/,
    );
    const restarted = JSON.parse(cli("plugin-doctor"));
    assert.equal(restarted.reachable, true);
    await remote(f.config, "cancel", { taskId: a.taskId });
    await until(
      () => remote(f.config, "status", { taskId: a.taskId }),
      (t) => t.status === "cancelled",
    );
    const restartedLive = JSON.parse(cli("plugin-restart"));
    assert.equal(restartedLive.reachable, true);
    assert.equal(restartedLive.daemon.pid > 0, true);
    const pid = JSON.parse(cli("plugin-doctor")).daemon.pid;
    assert.equal(pid, restartedLive.daemon.pid);
  } finally {
    const lockDir = path.join(f.config.stateDir, "lock");
    try {
      for (let i = 0; i < 3 && existsSync(lockDir); i++) {
        await remote(f.config, "shutdown").catch(() => {});
        await until(
          () => existsSync(lockDir),
          (gone) => !gone,
          5000,
        ).catch(() => {});
      }
    } catch {}
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill("SIGTERM");
      await new Promise((r) => daemon.once("exit", r)).catch(() => {});
    }
  }
});
test("plugin doctor flags a live daemon that predates the doctor method", async () => {
  const f = fixture();
  const fake = spawn(
    process.execPath,
    [
      "-e",
      `require("http").createServer((req,res)=>{let b="";req.on("data",c=>b+=c);req.on("end",()=>{const {method}=JSON.parse(b);res.writeHead(method==="doctor"?400:200,{"Content-Type":"application/json"});res.end(JSON.stringify(method==="doctor"?{error:"Unknown method"}:{result:[]}))})}).listen(${JSON.stringify(f.config.socket)})`,
    ],
    { stdio: "ignore" },
  );
  try {
    await until(() => existsSync(f.config.socket), Boolean);
    const out = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "dist/cli.js"), "plugin-doctor"],
        {
          cwd: f.dir,
          env: { ...process.env, AGENT_BRIDGE_CONFIG: f.file },
          encoding: "utf8",
        },
      ),
    );
    assert.equal(out.reachable, true);
    assert.equal(out.daemon.running, true);
    assert.match(out.daemon.diagnostics, /does not expose doctor/);
    assert.equal(out.configFile, realpathSync(f.file));
  } finally {
    fake.kill("SIGKILL");
    await new Promise((r) => fake.once("exit", r)).catch(() => {});
  }
});
test("direct CLI doctor works through the generic runtime path", async () => {
  const f = fixture();
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [path.join(root, "dist/cli.js"), "--config", f.file, "doctor"],
      { cwd: f.dir, encoding: "utf8", stdio: "pipe" },
    ),
  );
  const daemon = spawn(
    process.execPath,
    [path.join(root, "dist/cli.js"), "--config", f.file, "serve"],
    { cwd: root, stdio: "ignore" },
  );
  try {
    await until(async () => {
      try {
        return await remote(f.config, "list");
      } catch {
        return null;
      }
    }, Boolean);
    const out = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "dist/cli.js"), "--config", f.file, "doctor"],
        { cwd: f.dir, encoding: "utf8" },
      ),
    );
    assert.equal(out.configFile, realpathSync(f.file));
    assert.equal(out.agents.one.provider, "mock");
  } finally {
    const lockDir = path.join(f.config.stateDir, "lock");
    try {
      for (let i = 0; i < 3 && existsSync(lockDir); i++) {
        await remote(f.config, "shutdown").catch(() => {});
        await until(
          () => existsSync(lockDir),
          (gone) => !gone,
          5000,
        ).catch(() => {});
      }
    } catch {}
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill("SIGTERM");
      await new Promise((r) => daemon.once("exit", r)).catch(() => {});
    }
  }
});
