import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  realpathSync,
  existsSync,
  rmSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Runtime } from "../dist/runtime.js";
import { loadConfig, schema } from "../dist/config.js";
import { remote, serve } from "../dist/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = process.cwd();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, predicate, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const x = await fn();
    if (predicate(x)) return x;
    await pause(20);
  }
  throw Error("Condition timed out");
}
function fixture({
  load = true,
  writable = false,
  maxRuntimeMs = 5000,
  maxArtifactBytes = 1000000,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-"));
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
  const config = {
    version: 1,
    runtime: {
      stateDir: state,
      maxConcurrentTasks: 2,
      maxRuntimeMs,
      maxInlineChars: 500,
      maxArtifactBytes,
    },
    providers: {
      mock: {
        command: process.execPath,
        args: [
          path.join(root, "scripts/mock-acp.mjs"),
          ...(load ? [] : ["--no-load"]),
        ],
        env: {
          MOCK_STATE: path.join(state, "mock.json"),
          MOCK_PID_FILE: path.join(state, "worker.pid"),
        },
        readOnlyEnforced: true,
      },
    },
    agents: {
      one: {
        provider: "mock",
        description: "test",
        workspace: writable ? "isolated-worktree" : "read-only",
      },
      two: {
        provider: "mock",
        description: "test two",
        workspace: "read-only",
      },
    },
  };
  const file = path.join(dir, "agents.yaml");
  writeFileSync(file, JSON.stringify(config));
  return { dir, file, config: loadConfig(file) };
}
const done = (r, id) =>
  until(
    () => r.call("status", { taskId: id }),
    (t) => ["completed", "failed", "cancelled", "timed_out"].includes(t.status),
  );
test("config validates multiple providers and fails closed on exploration claims", () => {
  const c = loadConfig();
  assert.equal(Object.keys(c.providers).length, 8);
  assert.throws(() => schema.parse({ ...c, version: 2 }));
  const f = fixture();
  const x = JSON.parse(readFileSync(f.file));
  x.providers.mock.readOnlyEnforced = false;
  assert.throws(() => schema.parse(x), /provider-side/);
  x.providers.mock.readOnlyEnforced = true;
  x.providers.mock.unknown = "bad";
  assert.throws(() => schema.parse(x));
});
test("background question/reply, bounded results, continuity, steering, inbox replay and durable load", async () => {
  const f = fixture();
  let r = new Runtime(f.config);
  try {
    const start = performance.now();
    const a = await r.call("spawn", {
      agentId: "one",
      prompt: "ASK LARGE remember violet",
      taskKey: "idempotent",
    });
    assert.ok(performance.now() - start < 200);
    assert.equal(a.status, "queued");
    assert.equal(
      (
        await r.call("spawn", {
          agentId: "one",
          prompt: "duplicate",
          taskKey: "idempotent",
        })
      ).taskId,
      a.taskId,
    );
    const blocked = await until(
      () => r.call("status", { taskId: a.taskId }),
      (t) => t.status === "blocked_on_input",
    );
    assert.equal(blocked.question.kind, "input");
    await assert.rejects(
      r.call("reply", {
        taskId: a.taskId,
        questionId: blocked.question.questionId,
        content: { wrong: "x" },
      }),
    );
    await r.call("reply", {
      taskId: a.taskId,
      questionId: blocked.question.questionId,
      message: "violet",
    });
    assert.equal((await done(r, a.taskId)).status, "completed");
    const result = await r.call("result", { taskId: a.taskId, maxChars: 6000 });
    assert.ok(result.summary.length <= 500);
    assert.equal(result.verification, "pending");
    const page = await r.call("artifact", {
      ref: `artifact://${a.taskId}/output.txt`,
      limit: 500,
    });
    assert.equal(page.nextOffset, 500);
    assert.ok(page.text.length <= 500);
    assert.ok(page.totalBytes > 24000);
    assert.equal(page.eof, false);
    await assert.rejects(
      r.call("artifact", { ref: `artifact://${a.taskId}/../../state.json` }),
    );
    const b = await r.call("spawn", {
      agentId: "one",
      prompt: "recall",
      agentSessionId: a.agentSessionId,
    });
    await r.call("steer", { taskId: b.taskId, message: "follow up" });
    await r.call("steer", { taskId: b.taskId, message: "second follow up" });
    await assert.rejects(
      r.call("steer", { taskId: b.taskId, message: "third" }),
    );
    assert.equal((await done(r, b.taskId)).status, "completed");
    assert.equal(b.agentSessionId, a.agentSessionId);
    const out = readFileSync(
      r.store.artifactPath(b.taskId, "output.txt"),
      "utf8",
    );
    assert.match(out, /remember violet/);
    assert.match(out, /second follow up/);
    const e = await r.call("events", {});
    assert.deepEqual(e, await r.call("events", {}));
    assert.ok(e.events.some((e) => e.type === "task.question"));
    assert.equal(new Set(e.events.map((e) => e.eventId)).size, e.events.length);
    const native = r.store.state.sessions.one.nativeSessionId;
    r.close();
    r = new Runtime(f.config);
    assert.equal(r.store.task(a.taskId).status, "completed");
    assert.deepEqual((await r.call("events", {})).events, e.events);
    const c = await r.call("spawn", {
      agentId: "one",
      prompt: "after restart recall",
      agentSessionId: a.agentSessionId,
    });
    assert.equal((await done(r, c.taskId)).status, "completed");
    assert.equal(r.store.state.sessions.one.nativeSessionId, native);
    assert.equal(r.store.state.sessions.one.recovery, "loaded");
    assert.match(
      readFileSync(r.store.artifactPath(c.taskId, "output.txt"), "utf8"),
      /remember violet/,
    );
    assert.doesNotMatch(
      readFileSync(r.store.artifactPath(c.taskId, "output.txt"), "utf8"),
      /HISTORY REPLAY/,
    );
    assert.match(
      readFileSync(r.store.artifactPath(c.taskId, "recovery.jsonl"), "utf8"),
      /HISTORY REPLAY/,
    );
  } finally {
    r.close();
  }
});
test("serial ownership, concurrency, cancel, runtime deadline and provider death", async () => {
  const f = fixture();
  const r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "SLOW" });
    // A fresh conversation on the same profile runs alongside, not behind, a.
    const b = await r.call("spawn", { agentId: "one", prompt: "fresh" });
    // A follow-up turn in a's conversation must wait for a.
    const followup = await r.call("spawn", {
      agentId: "one",
      prompt: "next",
      agentSessionId: a.agentSessionId,
    });
    const c = await r.call("spawn", { agentId: "two", prompt: "parallel" });
    await until(
      () => r.call("status", { taskId: a.taskId }),
      (t) => t.status === "running",
    );
    assert.equal((await done(r, b.taskId)).status, "completed");
    assert.equal(
      (await r.call("status", { taskId: followup.taskId })).status,
      "queued",
    );
    assert.equal((await done(r, c.taskId)).status, "completed");
    assert.equal(
      (await r.call("status", { taskId: a.taskId })).status,
      "running",
    );
    await r.call("cancel", { taskId: a.taskId });
    assert.equal((await done(r, a.taskId)).status, "cancelled");
    assert.equal((await done(r, followup.taskId)).status, "completed");
    const dead = await r.call("spawn", { agentId: "two", prompt: "CRASH" });
    assert.equal((await done(r, dead.taskId)).status, "failed");
    const next = await r.call("spawn", {
      agentId: "two",
      prompt: "recover after death",
    });
    assert.equal((await done(r, next.taskId)).status, "completed");
  } finally {
    r.close();
  }
  const t = new Runtime(fixture({ maxRuntimeMs: 150 }).config);
  try {
    const a = await t.call("spawn", { agentId: "one", prompt: "SLOW" });
    assert.equal((await done(t, a.taskId)).status, "timed_out");
  } finally {
    t.close();
  }
});
test("worktree isolation, explicit permission options and read-only denial", async () => {
  const f = fixture({ writable: true });
  const r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "PERMISSION" });
    const q = await until(
      () => r.call("status", { taskId: a.taskId }),
      (t) => t.status === "blocked_on_input",
    );
    assert.notEqual(r.store.state.sessions.one.cwd, f.dir);
    await assert.rejects(
      r.call("reply", {
        taskId: a.taskId,
        questionId: q.question.questionId,
        optionId: "always",
      }),
    );
    await r.call("reply", {
      taskId: a.taskId,
      questionId: q.question.questionId,
      optionId: "deny",
    });
    assert.equal((await done(r, a.taskId)).status, "completed");
    const b = await r.call("spawn", { agentId: "two", prompt: "PERMISSION" });
    assert.equal((await done(r, b.taskId)).status, "completed");
    assert.match(
      readFileSync(r.store.artifactPath(b.taskId, "output.txt"), "utf8"),
      /cancelled/,
    );
  } finally {
    r.close();
  }
});
test("unsupported recovery fails without silently replacing conversation; budget is terminal", async () => {
  const f = fixture({ load: false });
  let r = new Runtime(f.config);
  try {
    const a = await r.call("spawn", { agentId: "one", prompt: "remember" });
    await done(r, a.taskId);
    const native = r.store.state.sessions.one.nativeSessionId;
    r.close();
    r = new Runtime(f.config);
    const b = await r.call("spawn", {
      agentId: "one",
      prompt: "recall",
      agentSessionId: a.agentSessionId,
    });
    const result = await done(r, b.taskId);
    assert.equal(result.status, "failed");
    assert.match(result.summary, /does not support/);
    assert.equal(r.store.state.sessions.one.nativeSessionId, native);
  } finally {
    r.close();
  }
  const small = new Runtime(fixture({ maxArtifactBytes: 1500 }).config);
  try {
    const a = await small.call("spawn", { agentId: "one", prompt: "LARGE" });
    assert.equal((await done(small, a.taskId)).status, "failed");
  } finally {
    small.close();
  }
});
test("actual daemon crash preserves history/queue and MCP reconnect does not own workers", async () => {
  const f = fixture();
  let daemon;
  const start = async () => {
    daemon = spawn(
      process.execPath,
      ["dist/cli.js", "--config", f.file, "serve"],
      { cwd: root, stdio: "pipe" },
    );
    let logs = "";
    daemon.stderr.on("data", (b) => (logs += b));
    await until(async () => {
      try {
        return await remote(f.config, "list");
      } catch {
        return null;
      }
    }, Boolean);
  };
  await start();
  let transport;
  let client;
  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/cli.js"), "--config", f.file, "mcp"],
      stderr: "pipe",
    });
    client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 14);
    const spawnResult = await client.callTool({
      name: "agents_spawn",
      arguments: { agentId: "one", prompt: "SLOW" },
    });
    const a = JSON.parse(spawnResult.content[0].text);
    // Same conversation, so it stays queued behind a across the crash.
    const b = await remote(f.config, "spawn", {
      agentId: "one",
      prompt: "queued",
      agentSessionId: a.agentSessionId,
    });
    await client.close();
    await until(
      () => remote(f.config, "events", {}),
      (e) =>
        e.events.some(
          (x) => x.taskId === a.taskId && x.type === "task.progress",
        ),
    );
    const workerPid = Number(
      readFileSync(path.join(f.config.stateDir, "worker.pid"), "utf8"),
    );
    const exited = new Promise((r) => daemon.once("exit", r));
    daemon.kill("SIGKILL");
    await exited;
    await until(async () => {
      try {
        process.kill(workerPid, 0);
        return false;
      } catch (e) {
        return e.code === "ESRCH";
      }
    }, Boolean);
    await start();
    const failed = await remote(f.config, "status", { taskId: a.taskId });
    assert.equal(failed.status, "failed");
    assert.match(failed.summary, /restarted/);
    const finished = await until(
      () => remote(f.config, "status", { taskId: b.taskId }),
      (t) => ["completed", "failed"].includes(t.status),
    );
    assert.equal(finished.status, "completed");
    await assert.rejects(
      remote(f.config, "spawn", { agentId: "one", prompt: "x", cwd: "/tmp" }),
    );
  } finally {
    await client?.close();
    if (daemon?.exitCode === null) {
      const exit = new Promise((r) => daemon.once("exit", r));
      daemon.kill("SIGTERM");
      await exit;
    }
  }
});

test("non-success backend stop reasons do not report task completion", async () => {
  const r = new Runtime(fixture().config);
  try {
    const t = await r.call("spawn", { agentId: "one", prompt: "REFUSE" });
    const result = await done(r, t.taskId);
    assert.equal(result.status, "failed");
    assert.match(result.summary, /refusal/);
  } finally {
    r.close();
  }
});

test("configured provider execution-error output cannot masquerade as successful end_turn", async () => {
  const f = fixture();
  f.config.providers.mock.errorOutputPrefixes = ["Error: Execution failed:"];
  const r = new Runtime(f.config);
  try {
    const t = await r.call("spawn", { agentId: "one", prompt: "ERROROUTPUT" });
    const s = await done(r, t.taskId);
    assert.equal(s.status, "failed");
    assert.match(s.summary, /400 fixture error/);
  } finally {
    r.close();
  }
});

test("project default runs in a non-Git folder; isolated worktrees are explicit and never silently fall back", async () => {
  const f = fixture();
  f.config.agents.one.workspace = "project";
  const r = new Runtime(f.config);
  try {
    const t = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE review only",
    });
    const result = await done(r, t.taskId);
    assert.equal(result.status, "completed");
    assert.equal(result.cwd, realpathSync(f.dir));
    assert.deepEqual(result.workspace, { mode: "project" });
    const text = readFileSync(
      r.store.artifactPath(t.taskId, "output.txt"),
      "utf8",
    );
    assert.ok(
      text.includes(
        JSON.stringify({
          processCwd: realpathSync(f.dir),
          sessionCwd: realpathSync(f.dir),
        }),
      ),
    );
    assert.equal(existsSync(path.join(f.dir, ".git")), false);
    assert.equal(existsSync(path.join(f.config.stateDir, "worktrees")), false);
    const isolated = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE",
      workspace: { mode: "isolated-worktree" },
    });
    assert.equal((await done(r, isolated.taskId)).status, "failed");
    assert.notEqual(isolated.agentSessionId, t.agentSessionId);
    const again = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE",
      agentSessionId: t.agentSessionId,
    });
    assert.equal((await done(r, again.taskId)).status, "completed");
  } finally {
    r.close();
  }
});

test("workspace selection isolates conversations, serializes one worker, and restores native context on folder switches", async () => {
  const f = fixture({ writable: true });
  const other = path.join(f.dir, "research");
  mkdirSync(other);
  const r = new Runtime(f.config);
  try {
    const first = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE remember project-token",
      workspace: { mode: "project" },
    });
    assert.equal((await done(r, first.taskId)).status, "completed");
    const second = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE remember research-token",
      workspace: { mode: "directory", path: "research" },
    });
    const third = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE recall",
      agentSessionId: first.agentSessionId,
    });
    assert.equal((await done(r, second.taskId)).status, "completed");
    assert.equal((await done(r, third.taskId)).status, "completed");
    assert.notEqual(first.agentSessionId, second.agentSessionId);
    assert.equal(r.store.task(second.taskId).cwd, realpathSync(other));
    const text = readFileSync(
      r.store.artifactPath(third.taskId, "output.txt"),
      "utf8",
    );
    assert.match(text, /project-token/);
    assert.doesNotMatch(text, /research-token/);
    assert.ok(
      text.includes(
        JSON.stringify({
          processCwd: realpathSync(f.dir),
          sessionCwd: realpathSync(f.dir),
        }),
      ),
    );
    const fourth = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE recall",
      agentSessionId: second.agentSessionId,
    });
    assert.equal(fourth.agentSessionId, second.agentSessionId);
    assert.equal((await done(r, fourth.taskId)).status, "completed");
    assert.match(
      readFileSync(r.store.artifactPath(fourth.taskId, "output.txt"), "utf8"),
      /research-token/,
    );
    assert.equal(
      existsSync(r.store.artifactPath(fourth.taskId, "diff.patch")),
      false,
    );
    await assert.rejects(
      r.call("spawn", {
        agentId: "two",
        prompt: "invalid",
        agentSessionId: first.agentSessionId,
      }),
      /Unknown conversation/,
    );
    await assert.rejects(
      r.call("spawn", {
        agentId: "one",
        prompt: "invalid",
        agentSessionId: first.agentSessionId,
        workspace: { mode: "project" },
      }),
      /not both/,
    );
    await assert.rejects(
      r.call("spawn", {
        agentId: "one",
        prompt: "invalid",
        workspace: { mode: "directory", path: "seed" },
      }),
      /directory/,
    );
  } finally {
    r.close();
  }
});

test("temporary folders need no Git, remain distinct, and resume the same workspace after runtime restart", async () => {
  const f = fixture();
  let r = new Runtime(f.config);
  try {
    const t = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE remember scratch-token",
      workspace: { mode: "temporary" },
    });
    const finished = await done(r, t.taskId);
    assert.equal(finished.status, "completed");
    assert.ok(
      finished.cwd.startsWith(
        path.join(realpathSync(f.config.stateDir), "scratch"),
      ),
    );
    writeFileSync(path.join(finished.cwd, "notes.txt"), "retained notes");
    const different = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE",
      workspace: { mode: "temporary" },
    });
    assert.equal((await done(r, different.taskId)).status, "completed");
    assert.notEqual(different.agentSessionId, t.agentSessionId);
    r.close();
    r = new Runtime(f.config);
    const followup = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE recall",
      agentSessionId: t.agentSessionId,
    });
    const restored = await done(r, followup.taskId);
    assert.equal(restored.status, "completed");
    assert.equal(restored.cwd, finished.cwd);
    assert.equal(
      readFileSync(path.join(restored.cwd, "notes.txt"), "utf8"),
      "retained notes",
    );
    assert.match(
      readFileSync(r.store.artifactPath(followup.taskId, "output.txt"), "utf8"),
      /scratch-token/,
    );
    rmSync(restored.cwd, { recursive: true });
    const missing = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE",
      agentSessionId: t.agentSessionId,
    });
    assert.match((await done(r, missing.taskId)).summary, /workspace missing/);
  } finally {
    r.close();
  }
});

test("live status exposes bounded tool activity and public output; terminal events do not contain report fragments", async () => {
  const r = new Runtime(fixture().config);
  try {
    const t = await r.call("spawn", { agentId: "one", prompt: "TOOLS LARGE" });
    assert.equal((await done(r, t.taskId)).status, "completed");
    const status = await r.call("status", { taskId: t.taskId });
    assert.equal(status.recentActivity.length, 1);
    assert.equal(status.recentActivity[0].title, "Read src/runtime.ts");
    assert.deepEqual(status.recentActivity[0].paths, ["src/runtime.ts"]);
    assert.equal(status.recentActivity[0].status, "completed");
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_FIXTURE_THOUGHT/);
    const result = await r.call("result", { taskId: t.taskId });
    assert.equal(result.summaryKind, "bounded-output-tail");
    assert.equal(result.fullOutputRef, `artifact://${t.taskId}/output.txt`);
    assert.ok(result.outputBytes > result.summary.length);
    const event = (await r.call("events", {})).events.find(
      (e) => e.type === "task.completed",
    );
    assert.equal(
      event.summary,
      "Worker finished; independent verification pending",
    );
  } finally {
    r.close();
  }
});

test("stderr budget failure on a reused worker interrupts the current task, not the previous task", async () => {
  const r = new Runtime(fixture({ maxArtifactBytes: 2000 }).config);
  const interrupted = [];
  const interrupt = r.interrupt.bind(r);
  r.interrupt = (active) => {
    interrupted.push(active.task.taskId);
    return interrupt(active);
  };
  try {
    const first = await r.call("spawn", { agentId: "one", prompt: "first" });
    assert.equal((await done(r, first.taskId)).status, "completed");
    const next = await r.call("spawn", {
      agentId: "one",
      prompt: "STDERRBURST",
      agentSessionId: first.agentSessionId,
    });
    const failed = await done(r, next.taskId);
    assert.equal(failed.status, "failed");
    assert.match(failed.summary, /budget exceeded/);
    assert.ok(interrupted.includes(next.taskId));
    assert.ok(!interrupted.includes(first.taskId));
    assert.equal(r.store.task(first.taskId).status, "completed");
  } finally {
    r.close();
  }
});

test("persisted conversations reject directory replacement after runtime restart without launching a worker", async () => {
  for (const redirect of [true, false]) {
    const f = fixture();
    const folder = path.join(f.dir, "review");
    mkdirSync(folder);
    let r = new Runtime(f.config);
    try {
      const first = await r.call("spawn", {
        agentId: "one",
        prompt: "WORKSPACE remember original",
        workspace: { mode: "directory", path: folder },
      });
      assert.equal((await done(r, first.taskId)).status, "completed");
      const originalNative = r.session(
        r.store.task(first.taskId),
      ).nativeSessionId;
      r.close();
      renameSync(folder, path.join(f.dir, "retained-review"));
      if (redirect) symlinkSync(f.dir, folder);
      else mkdirSync(folder);
      r = new Runtime(f.config);
      const followup = await r.call("spawn", {
        agentId: "one",
        prompt: "WORKSPACE recall",
        agentSessionId: first.agentSessionId,
      });
      const failed = await done(r, followup.taskId);
      assert.equal(failed.status, "failed");
      assert.match(failed.summary, /identity changed/);
      assert.equal(r.workers.size, 0);
      assert.equal(
        r.session(r.store.task(first.taskId)).nativeSessionId,
        originalNative,
      );
    } finally {
      r.close();
    }
  }
});

test("workspace identity is pinned at dispatch and detects replacement while a task waits in the queue", async () => {
  const f = fixture();
  const folder = path.join(f.dir, "queued-review");
  mkdirSync(folder);
  const r = new Runtime(f.config);
  try {
    const first = await r.call("spawn", { agentId: "one", prompt: "SLOW" });
    await until(
      () => r.call("status", { taskId: first.taskId }),
      (t) => t.status === "running",
    );
    const queued = await r.call("spawn", {
      agentId: "one",
      prompt: "WORKSPACE",
      workspace: { mode: "directory", path: folder },
    });
    renameSync(folder, path.join(f.dir, "retained-queued-review"));
    symlinkSync(f.dir, folder);
    await r.call("cancel", { taskId: first.taskId });
    const failed = await done(r, queued.taskId);
    assert.equal(failed.status, "failed");
    assert.match(failed.summary, /identity changed/);
    assert.equal(
      r.session(r.store.task(queued.taskId)).nativeSessionId,
      undefined,
    );
  } finally {
    r.close();
  }
});

test("unrelated tasks in the same folder get fresh context while explicit follow-ups restore the original conversation", async () => {
  const r = new Runtime(fixture().config);
  try {
    const first = await r.call("spawn", {
      agentId: "one",
      prompt: "remember original-label",
    });
    assert.equal((await done(r, first.taskId)).status, "completed");
    const second = await r.call("spawn", {
      agentId: "one",
      prompt: "unrelated new task",
    });
    assert.equal((await done(r, second.taskId)).status, "completed");
    assert.notEqual(first.agentSessionId, second.agentSessionId);
    assert.doesNotMatch(
      readFileSync(r.store.artifactPath(second.taskId, "output.txt"), "utf8"),
      /original-label/,
    );
    const followup = await r.call("spawn", {
      agentId: "one",
      prompt: "recall",
      agentSessionId: first.agentSessionId,
    });
    assert.equal((await done(r, followup.taskId)).status, "completed");
    assert.match(
      readFileSync(r.store.artifactPath(followup.taskId, "output.txt"), "utf8"),
      /original-label/,
    );
  } finally {
    r.close();
  }
});

test("foreground MCP call returns report from the beginning, supports exact continuation and cancels on caller abort", async () => {
  const f = fixture();
  const daemon = await serve(f.config);
  const client = new Client({ name: "foreground-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/cli.js"), "--config", f.file, "mcp"],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "agents_run",
      arguments: {
        agentId: "one",
        prompt: "TOOLS LARGE",
        description: "Review fixture",
      },
    });
    assert.ok(!response.isError, JSON.stringify(response));
    const report = JSON.parse(response.content[0].text);
    assert.equal(report.status, "completed");
    assert.equal(report.execution, "foreground");
    assert.ok(report.output.startsWith("Working"));
    assert.equal(report.outputComplete, false);
    assert.ok(report.nextOutputOffset > 0);
    const completed = await client.callTool({
      name: "agents_run",
      arguments: { taskId: report.taskId },
    });
    assert.equal(JSON.parse(completed.content[0].text).taskId, report.taskId);
    assert.equal(Object.keys(daemon.runtime.store.state.tasks).length, 1);
    const bounded = JSON.parse(
      (
        await client.callTool({
          name: "agents_run",
          arguments: { agentId: "one", prompt: "SLOW", waitMs: 0 },
        })
      ).content[0].text,
    );
    assert.equal(bounded.waitExpired, true);
    assert.ok(["queued", "running"].includes(bounded.status));
    const resumed = JSON.parse(
      (
        await client.callTool({
          name: "agents_run",
          arguments: { taskId: bounded.taskId, waitMs: 3000 },
        })
      ).content[0].text,
    );
    assert.equal(resumed.taskId, bounded.taskId);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.waitExpired, false);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "agents_run", arguments: { agentId: "one", prompt: "SLOW" } },
      undefined,
      { signal: controller.signal, onprogress: () => controller.abort() },
    );
    await assert.rejects(pending);
    await until(
      async () =>
        Object.values(daemon.runtime.store.state.tasks).find(
          (t) => t.status === "cancelled",
        ),
      (t) => t?.status === "cancelled",
    );
  } finally {
    await client.close();
    daemon.stop();
  }
});

test("disconnecting an in-flight foreground MCP call cancels its worker; background lifetime remains independent", async () => {
  const f = fixture();
  const daemon = await serve(f.config);
  const client = new Client({ name: "foreground-close", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(root, "dist/cli.js"), "--config", f.file, "mcp"],
        stderr: "pipe",
      }),
    );
    const pending = client
      .callTool({
        name: "agents_run",
        arguments: { agentId: "one", prompt: "SLOW" },
      })
      .catch(() => undefined);
    await until(
      async () => Object.values(daemon.runtime.store.state.tasks)[0],
      (t) => t?.status === "running",
    );
    await client.close();
    await pending;
    await until(
      async () => Object.values(daemon.runtime.store.state.tasks)[0],
      (t) => t?.status === "cancelled",
    );
  } finally {
    await client.close();
    daemon.stop();
  }
});

test("artifact symlinks cannot redirect reads or appends to another file", async () => {
  const f = fixture();
  const r = new Runtime(f.config);
  try {
    const t = await r.call("spawn", { agentId: "one", prompt: "review" });
    assert.equal((await done(r, t.taskId)).status, "completed");
    const victim = path.join(f.dir, "unrelated.txt");
    writeFileSync(victim, "KEEP_PRIVATE");
    const output = r.store.artifactPath(t.taskId, "output.txt");
    rmSync(output);
    symlinkSync(victim, output);
    await assert.rejects(
      r.call("artifact", { ref: `artifact://${t.taskId}/output.txt` }),
      /symlink|unsafe|Unsafe|ELOOP/,
    );
    assert.throws(
      () => r.store.append(t.taskId, "output.txt", "CHANGED"),
      /symlink|unsafe|Unsafe|ELOOP/,
    );
    assert.equal(readFileSync(victim, "utf8"), "KEEP_PRIVATE");
  } finally {
    r.close();
  }
});

test("semantic conversation names persist across follow-ups, restart and legacy migration without losing reports", async () => {
  const f = fixture();
  let r = new Runtime(f.config);
  try {
    const first = await r.call("spawn", {
      agentId: "one",
      description: "Review repository",
      prompt: "remember named-worker",
    });
    await done(r, first.taskId);
    assert.equal(first.workerName, "one-review-repository");
    const followup = await r.call("spawn", {
      agentId: "one",
      description: "Explain findings",
      prompt: "recall",
      agentSessionId: first.agentSessionId,
    });
    await done(r, followup.taskId);
    assert.equal(followup.workerName, first.workerName);
    const independent = await r.call("spawn", {
      agentId: "one",
      description: "Review repository",
      prompt: "independent",
    });
    await done(r, independent.taskId);
    assert.equal(independent.workerName, "one-review-repository-2");
    r.close();
    r = new Runtime(f.config);
    const sessions = (await r.call("list", {})).find(
      (a) => a.agentId === "one",
    ).sessions;
    assert.equal(
      sessions.find((s) => s.agentSessionId === first.agentSessionId)
        .workerName,
      first.workerName,
    );
    assert.equal(
      (await r.call("status", { taskId: first.taskId })).workerName,
      first.workerName,
    );
    assert.match(
      (
        await r.call("artifact", {
          ref: `artifact://${first.taskId}/output.txt`,
        })
      ).text,
      /named-worker/,
    );
    // Emulate an older state snapshot: names must migrate without changing IDs.
    for (const s of Object.values(r.store.state.sessions)) delete s.workerName;
    for (const t of Object.values(r.store.state.tasks)) delete t.workerName;
    r.store.save();
    r.close();
    r = new Runtime(f.config);
    assert.equal(r.store.task(first.taskId).workerName, first.workerName);
    assert.equal(r.store.task(followup.taskId).workerName, first.workerName);
    assert.equal(
      r.store.task(independent.taskId).workerName,
      independent.workerName,
    );
    assert.equal(
      r.store.task(first.taskId).agentSessionId,
      first.agentSessionId,
    );
  } finally {
    r.close();
  }
});
