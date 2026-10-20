import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";
import { remote } from "../dist/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = process.cwd();
const dir = mkdtempSync(path.join(tmpdir(), "ab-demo-"));
const configFile = path.join(dir, "agents.yaml");
writeFileSync(
  configFile,
  JSON.stringify({
    version: 1,
    runtime: { stateDir: path.join(dir, "state") },
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
        description: "Offline demo",
        workspace: "read-only",
      },
    },
  }),
);
const config = loadConfig(configFile);
let daemon;
let client;
const delay = () => new Promise((r) => setTimeout(r, 30));
async function start() {
  daemon = spawn(
    process.execPath,
    [path.join(root, "dist/cli.js"), "--config", configFile, "serve"],
    { stdio: "pipe" },
  );
  for (let i = 0; i < 200; i++) {
    try {
      await remote(config, "list");
      return;
    } catch {
      await delay();
    }
  }
  throw Error("Daemon startup failed");
}
async function stop() {
  const end = new Promise((r) => daemon.once("exit", r));
  daemon.kill("SIGTERM");
  await end;
}
async function wait(id, status) {
  for (let i = 0; i < 300; i++) {
    const t = await remote(config, "status", { taskId: id });
    if (status.includes(t.status)) return t;
    await delay();
  }
  throw Error("Task did not reach expected state");
}
try {
  await start();
  client = new Client({ name: "demo-coordinator", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/cli.js"), "--config", configFile, "mcp"],
    }),
  );
  const startAt = performance.now();
  const response = await client.callTool({
    name: "agents_spawn",
    arguments: { agentId: "demo", prompt: "ASK LARGE remember saffron" },
  });
  const first = JSON.parse(response.content[0].text);
  console.log(
    `MCP spawn returned in ${Math.round(performance.now() - startAt)}ms: ${first.taskId}`,
  );
  await client.close();
  client = undefined; // worker must outlive the facade
  const q = await wait(first.taskId, ["blocked_on_input"]);
  console.log("Question:", q.question.summary);
  await remote(config, "reply", {
    taskId: first.taskId,
    questionId: q.question.questionId,
    message: "saffron",
  });
  assert.equal(
    (await wait(first.taskId, ["completed", "failed"])).status,
    "completed",
  );
  console.log(
    "Compact result:",
    await remote(config, "result", { taskId: first.taskId, maxChars: 120 }),
  );
  await stop();
  await start();
  const second = await remote(config, "spawn", {
    agentId: "demo",
    prompt: "recall the remembered label",
    agentSessionId: first.agentSessionId,
  });
  assert.equal(
    (await wait(second.taskId, ["completed", "failed"])).status,
    "completed",
  );
  const result = await remote(config, "result", { taskId: second.taskId });
  assert.match(result.summary, /saffron/);
  assert.equal(second.agentSessionId, first.agentSessionId);
  console.log("Restart + same conversation context: PASS");
  console.log("Artifacts/history:", dir);
} finally {
  await client?.close();
  if (daemon?.exitCode === null) await stop();
}
