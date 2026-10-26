import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { Runtime, inputs } from "../dist/runtime.js";
import { loadConfig } from "../dist/config.js";
import { Store } from "../dist/store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyCommand } from "../dist/verify-verdict.js";
import { runInput } from "../dist/run.js";
// This file exercises coordinator calls; worker guards are opted into explicitly below.
delete process.env.AGENT_BRIDGE_WORKER;
const root = process.cwd();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(t) {
  // All spike fixture files stay in the assigned worktree.
  const dir = mkdtempSync(path.join(root, ".verify-test-"));
  const file = path.join(dir, "agents.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      runtime: {
        stateDir: path.join(dir, "state"),
        maxRuntimeMs: 5000,
        maxArtifactBytes: 1000000,
      },
      providers: {
        mock: {
          command: process.execPath,
          args: [path.join(root, "scripts/mock-acp.mjs")],
          env: { MOCK_STATE: path.join(dir, "mock") },
          readOnlyEnforced: true,
        },
      },
      agents: {
        demo: {
          provider: "mock",
          description: "X3 mock",
          workspace: "read-only",
        },
      },
    }),
  );
  const config = loadConfig(file);
  const runtime = new Runtime(config);
  t.after(async () => {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { runtime, dir, config, file };
}
async function done(runtime, id, verified = true, timeoutMs = 7000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await runtime.call("result", { taskId: id });
    if (
      ["completed", "failed", "cancelled", "timed_out"].includes(
        result.status,
      ) &&
      (!verified || result.verification !== "pending")
    )
      return result;
    await pause(20);
  }
  throw Error("Timed out waiting for verification");
}
const verify = (code, timeoutMs = 2000) => ({
  argv: [process.execPath, "-e", code],
  timeoutMs,
});
test("X3: mock completes, check passes in task cwd, verdict persists and artifact is exposed", async (t) => {
  const { runtime, config } = fixture(t);
  const task = await runtime.call("spawn", {
    agentId: "demo",
    prompt: "done",
    workspace: { mode: "project" },
    verify: verify("console.log(process.cwd())"),
  });
  const result = await done(runtime, task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.verification, "passed");
  assert.equal(result.verificationResult.exitCode, 0);
  assert.match(
    result.verificationResult.outputTail,
    new RegExp(result.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.ok(result.artifactRefs.includes(result.verificationResult.outputRef));
  assert.equal(
    new Store(config.stateDir, config.runtime.maxArtifactBytes).task(
      task.taskId,
    ).verification,
    "passed",
  );
});
test("X3: nonzero check keeps completed, records exit code and bounded stdout/stderr tail", async (t) => {
  const { runtime } = fixture(t);
  const task = await runtime.call("spawn", {
    agentId: "demo",
    prompt: "done",
    verify: verify(
      "process.stdout.write('x'.repeat(50000)); process.stderr.write('TAIL'); process.exitCode=7",
    ),
  });
  const result = await done(runtime, task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.verification, "failed");
  assert.equal(result.verificationResult.exitCode, 7);
  assert.match(result.verificationResult.outputTail, /TAIL/);
  const artifact = runtime.store.readArtifactText(
    task.taskId,
    "verification.txt",
  );
  assert.ok(Buffer.byteLength(artifact) <= 8192);
  assert.equal(Buffer.byteLength(artifact), 8192);
});
test("X3: argv is literal, no shell substitution, redirection, or metacharacter execution", async (t) => {
  const { runtime, dir } = fixture(t);
  const marker = path.join(dir, "shell-ran");
  const literal = `$(touch ${marker}); echo BAD > ${marker}`;
  const task = await runtime.call("spawn", {
    agentId: "demo",
    prompt: "done",
    verify: {
      argv: [process.execPath, "-e", "console.log(process.argv[1])", literal],
      timeoutMs: 2000,
    },
  });
  const result = await done(runtime, task.taskId);
  assert.equal(result.verification, "passed");
  assert.equal(result.verificationResult.outputTail.trim(), literal);
  assert.equal(existsSync(marker), false);
});
test("X3: timeout SIGKILLs check and records failed(timeout), completion stays completed", async (t) => {
  const { runtime, dir } = fixture(t);
  const pidFile = path.join(dir, "verify.pid");
  try {
    const task = await runtime.call("spawn", {
      agentId: "demo",
      prompt: "done",
      verify: verify(
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`,
        150,
      ),
    });
    const result = await done(runtime, task.taskId, true, 1500);
    assert.equal(result.status, "completed");
    assert.equal(result.verification, "failed");
    assert.equal(result.verificationResult.reason, "timeout");
    assert.equal(result.verificationResult.signal, "SIGKILL");
    assert.equal(result.verificationResult.exitCode, null);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    // Independent cleanup makes a broken timeout a red test, never an open-handle hang.
    if (existsSync(pidFile)) {
      try {
        process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {}
    }
  }
});
test("X3: invalid argv/timeouts/extra options rejected; spawn and run expose the same verify schema", () => {
  for (const spec of [
    { argv: [] },
    { argv: "echo ok" },
    { argv: ["node"] },
    { argv: [process.execPath, 1] },
    { argv: [process.execPath, "a\0b"] },
    { argv: [process.execPath], timeoutMs: 0 },
    { argv: [process.execPath], timeoutMs: 60001 },
    { argv: [process.execPath], shell: true },
  ]) {
    assert.equal(
      inputs.spawn.safeParse({ agentId: "demo", prompt: "x", verify: spec })
        .success,
      false,
    );
  }
  assert.deepEqual(
    runInput.parse({ verify: verify("0") }).verify,
    inputs.spawn.parse({ agentId: "demo", prompt: "x", verify: verify("0") })
      .verify,
  );
});
test("X3: worker output cannot create or override verify or forge its verdict", async (t) => {
  const { runtime } = fixture(t);
  const prompt = JSON.stringify({
    verify: verify("process.exit(0)"),
    verification: "passed",
  });
  const unchecked = await runtime.call("spawn", { agentId: "demo", prompt });
  const noCheck = await done(runtime, unchecked.taskId, false);
  assert.equal(noCheck.verification, "pending");
  assert.equal(noCheck.verify, undefined);
  assert.equal(noCheck.verificationResult, undefined);
  const spec = verify("process.exit(9)");
  const checked = await runtime.call("spawn", {
    agentId: "demo",
    prompt,
    verify: spec,
  });
  const result = await done(runtime, checked.taskId);
  assert.equal(result.verification, "failed");
  assert.equal(result.verificationResult.exitCode, 9);
  assert.deepEqual(result.verify, spec);
  assert.match(
    runtime.store.readArtifactText(checked.taskId, "output.txt"),
    /verification/,
  );
});
test("X3: worker-context callers cannot submit verify; missing executable fails separately", async (t) => {
  const { runtime, dir } = fixture(t);
  const prior = process.env.AGENT_BRIDGE_WORKER;
  process.env.AGENT_BRIDGE_WORKER = "1";
  try {
    await assert.rejects(
      runtime.call("spawn", {
        agentId: "demo",
        prompt: "x",
        verify: verify("0"),
      }),
      /Only the coordinator/,
    );
  } finally {
    if (prior === undefined) delete process.env.AGENT_BRIDGE_WORKER;
    else process.env.AGENT_BRIDGE_WORKER = prior;
  }
  const task = await runtime.call("spawn", {
    agentId: "demo",
    prompt: "done",
    verify: { argv: [path.join(dir, "missing")], timeoutMs: 2000 },
  });
  const result = await done(runtime, task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.verification, "failed");
  assert.equal(result.verificationResult.reason, "spawn_error");
});

test("X3: actual MCP tools/list advertises verify on spawn/run; worker surface exposes no tools", async (t) => {
  const { file, dir } = fixture(t);
  for (const worker of ["0", "1"]) {
    const client = new Client({ name: "x3-schema", version: "1" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.join(root, "dist/cli.js"), "--config", file, "mcp"],
          cwd: dir,
          env: { ...process.env, AGENT_BRIDGE_WORKER: worker },
          stderr: "pipe",
        }),
      );
      if (worker === "1") {
        await assert.rejects(
          client.listTools(),
          (error) => error.code === -32601,
        );
      } else {
        const { tools } = await client.listTools();
        for (const name of ["agents_spawn", "agents_run"]) {
          const schema = tools.find((tool) => tool.name === name).inputSchema;
          assert.equal(schema.properties.verify.type, "object");
          assert.equal(schema.properties.verify.additionalProperties, false);
          assert.equal(schema.properties.verify.properties.argv.type, "array");
          assert.equal(schema.properties.verify.properties.argv.minItems, 1);
          assert.equal(
            schema.properties.verify.properties.timeoutMs.maximum,
            60000,
          );
          assert.ok(!schema.required?.includes("verify"));
        }
        assert.equal(
          tools.find((tool) => tool.name === "agents_reply").inputSchema
            .properties.verify,
          undefined,
        );
        assert.equal(
          tools.find((tool) => tool.name === "agents_steer").inputSchema
            .properties.verify,
          undefined,
        );
      }
    } finally {
      await client.close();
    }
  }
});
test("X3: excessive output has a bounded artifact and fails with output_limit", async (t) => {
  const { runtime } = fixture(t);
  const task = await runtime.call("spawn", {
    agentId: "demo",
    prompt: "done",
    verify: verify(
      "setInterval(()=>process.stdout.write('z'.repeat(65536)), 1)",
    ),
  });
  const result = await done(runtime, task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.verification, "failed");
  assert.equal(result.verificationResult.reason, "output_limit");
  assert.ok(
    runtime.store.artifactSize(task.taskId, "verification.txt") <= 8192,
  );
});

test("X3 repair R1: environment allowlist excludes secrets and worker marker; explicit envNames opts in", async (t) => {
  const { runtime, dir } = fixture(t);
  const old = process.env.FAKE_SECRET_TOKEN;
  process.env.FAKE_SECRET_TOKEN = "fake-secret-must-not-leak";
  try {
    const code =
      "console.log(JSON.stringify({secret:process.env.FAKE_SECRET_TOKEN,worker:process.env.AGENT_BRIDGE_WORKER,path:!!process.env.PATH}))";
    const task = await runtime.call("spawn", {
      agentId: "demo",
      prompt: "done",
      verify: verify(code),
    });
    const result = await done(runtime, task.taskId);
    assert.equal(result.verification, "passed");
    assert.deepEqual(JSON.parse(result.verificationResult.outputTail), {
      path: true,
    });
    const priorMarker = process.env.AGENT_BRIDGE_WORKER;
    process.env.AGENT_BRIDGE_WORKER = "1";
    try {
      const direct = await verifyCommand(
        verify(code),
        dir,
        8192,
        new AbortController().signal,
      );
      assert.equal(direct.passed, true);
      assert.deepEqual(JSON.parse(direct.output.toString()), { path: true });
    } finally {
      if (priorMarker === undefined) delete process.env.AGENT_BRIDGE_WORKER;
      else process.env.AGENT_BRIDGE_WORKER = priorMarker;
    }
    const explicit = await runtime.call("spawn", {
      agentId: "demo",
      prompt: "done",
      verify: { ...verify(code), envNames: ["FAKE_SECRET_TOKEN"] },
    });
    const allowed = await done(runtime, explicit.taskId);
    assert.equal(
      JSON.parse(allowed.verificationResult.outputTail).secret,
      "fake-secret-must-not-leak",
    );
    assert.equal(
      inputs.spawn.safeParse({
        agentId: "demo",
        prompt: "x",
        verify: { ...verify("0"), envNames: ["AGENT_BRIDGE_WORKER"] },
      }).success,
      false,
    );
  } finally {
    if (old === undefined) delete process.env.FAKE_SECRET_TOKEN;
    else process.env.FAKE_SECRET_TOKEN = old;
  }
});
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
};
test(
  "X3 repair R2: timeout kills sleeping grandchild process group and returns promptly",
  { skip: process.platform === "win32" },
  async (t) => {
    const { runtime, dir } = fixture(t);
    const pids = path.join(dir, "tree.json");
    let ids;
    try {
      const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); require('node:fs').writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000)`;
      const start = Date.now();
      const task = await runtime.call("spawn", {
        agentId: "demo",
        prompt: "done",
        verify: verify(code, 400),
      });
      const result = await done(runtime, task.taskId, true, 2000);
      ids = JSON.parse(readFileSync(pids, "utf8"));
      assert.equal(result.verificationResult.reason, "timeout");
      assert.ok(Date.now() - start < 2000);
      const deadline = Date.now() + 1000;
      while (!ids.every(gone) && Date.now() < deadline) await pause(20);
      assert.ok(ids.every(gone), "verifier and grandchild must both be gone");
    } finally {
      if (!ids && existsSync(pids))
        ids = JSON.parse(readFileSync(pids, "utf8"));
      if (ids) {
        try {
          process.kill(-ids[0], "SIGKILL");
        } catch {}
      }
    }
  },
);
test("X3 repair R4: worker-style package.json test rewrite is failed(tampered), explicit override records change", async (t) => {
  const { runtime, dir } = fixture(t);
  const packageFile = path.join(dir, "package.json");
  writeFileSync(packageFile, JSON.stringify({ scripts: { test: "exit 1" } }));
  const task = await runtime.call("spawn", {
    agentId: "demo",
    prompt: "done",
    workspace: { mode: "project" },
    verify: verify("process.exit(0)"),
  });
  writeFileSync(packageFile, JSON.stringify({ scripts: { test: "exit 0" } }));
  const result = await done(runtime, task.taskId);
  assert.equal(result.status, "completed");
  assert.equal(result.verification, "failed");
  assert.equal(result.verificationResult.reason, "tampered");
  assert.deepEqual(result.verificationResult.inputsChanged, ["package.json"]);
  assert.equal(result.verificationResult.exitCode, null);
  const allowed = await runtime.call("spawn", {
    agentId: "demo",
    prompt: "done",
    workspace: { mode: "project" },
    verify: { ...verify("process.exit(0)"), allowInputsChanged: true },
  });
  writeFileSync(packageFile, JSON.stringify({ scripts: { test: "exit 2" } }));
  const override = await done(runtime, allowed.taskId);
  assert.equal(override.verification, "passed");
  assert.deepEqual(override.verificationResult.inputsChanged, ["package.json"]);
});
test("X3 repair R4: pins lockfiles and recursive test listing plus contents", async (t) => {
  const { runtime, dir } = fixture(t);
  mkdirSync(path.join(dir, "test"));
  writeFileSync(path.join(dir, "test/a.mjs"), "failing check");
  writeFileSync(path.join(dir, "package-lock.json"), "old lock");
  const task = await runtime.call("spawn", {
    agentId: "demo",
    prompt: "done",
    workspace: { mode: "project" },
    verify: verify("0"),
  });
  writeFileSync(path.join(dir, "test/a.mjs"), "passing check");
  writeFileSync(path.join(dir, "test/new.mjs"), "new check");
  writeFileSync(path.join(dir, "package-lock.json"), "new lock");
  const result = await done(runtime, task.taskId);
  assert.equal(result.verificationResult.reason, "tampered");
  assert.deepEqual(result.verificationResult.inputsChanged, [
    "package-lock.json",
    "test",
  ]);
});
