import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = process.cwd();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect(dir, extra = {}) {
  const client = new Client({ name: "plugin-test", version: "1" });
  // Exercise coordinator startup even when a delegated worker runs this suite.
  // The explicit recursion test below still opts into worker mode through extra.
  const env = { ...process.env, AGENT_BRIDGE_WORKER: "0", ...extra };
  delete env.AGENT_BRIDGE_CONFIG;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/cli.js"), "plugin-mcp"],
      cwd: dir,
      env,
      stderr: "pipe",
    }),
  );
  return client;
}
async function tool(client, name, args) {
  const r = await client.callTool({ name: "agents_" + name, arguments: args });
  assert.ok(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
}
async function stop(dir) {
  const pidFile = path.join(dir, ".agent-bridge/lock/pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 100 && existsSync(pidFile); i++) await delay(20);
  }
}
test("Claude plugin autostarts one project daemon, reconnects to persistent task, and restarts after daemon death", async () => {
  const dir = mkdtempSync(
    path.join(
      tmpdir(),
      "ab-plugin-long-project-name-to-exercise-macos-socket-limit-",
    ),
  );
  let one, two;
  try {
    [one, two] = await Promise.all([connect(dir), connect(dir)]);
    const pid = readFileSync(path.join(dir, ".agent-bridge/lock/pid"), "utf8");
    assert.equal((await one.listTools()).tools.length, 11);
    const first = await tool(one, "spawn", {
      agentId: "demo",
      prompt: "remember plugin marker",
    });
    assert.equal(first.status, "queued");
    const waited = await tool(two, "wait", {
      taskIds: [first.taskId],
      timeoutMs: 4000,
    });
    assert.equal(waited.tasks[0].status, "completed");
    await one.close();
    one = undefined;
    const second = await tool(two, "spawn", {
      agentId: "demo",
      prompt: "recall",
      agentSessionId: first.agentSessionId,
    });
    await tool(two, "wait", { taskIds: [second.taskId], timeoutMs: 4000 });
    const page = await tool(two, "artifact", {
      ref: `artifact://${second.taskId}/output.txt`,
      limit: 2000,
    });
    assert.match(page.text, /remember plugin marker/);
    assert.equal(
      readFileSync(path.join(dir, ".agent-bridge/lock/pid"), "utf8"),
      pid,
    );
    await stop(dir);
    await tool(two, "list", {});
    assert.notEqual(
      readFileSync(path.join(dir, ".agent-bridge/lock/pid"), "utf8"),
      pid,
    );
    assert.equal(
      (await tool(two, "status", { taskId: first.taskId })).status,
      "completed",
    );
  } finally {
    await one?.close();
    await two?.close();
    await stop(dir);
  }
});
test("external Claude worker cannot recursively activate the plugin daemon or delegation tools", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-no-nesting-"));
  const client = await connect(dir, { AGENT_BRIDGE_WORKER: "1" });
  try {
    assert.equal(client.getServerCapabilities()?.tools, undefined);
    assert.equal(existsSync(path.join(dir, ".agent-bridge")), false);
  } finally {
    await client.close();
  }
});
