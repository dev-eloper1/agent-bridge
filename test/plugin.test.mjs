import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
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
  const r = await client.callTool({ name, arguments: args });
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
    assert.equal((await one.listTools()).tools.length, 18);
    const first = await tool(one, "agents_spawn", {
      agentId: "demo",
      prompt: "remember plugin marker",
    });
    assert.equal(first.status, "queued");
    const waited = await tool(two, "agents_wait", {
      taskIds: [first.taskId],
      timeoutMs: 4000,
    });
    assert.equal(waited.tasks[0].status, "completed");
    await one.close();
    one = undefined;
    const second = await tool(two, "agents_spawn", {
      agentId: "demo",
      prompt: "recall",
      agentSessionId: first.agentSessionId,
    });
    await tool(two, "agents_wait", {
      taskIds: [second.taskId],
      timeoutMs: 4000,
    });
    const page = await tool(two, "agents_artifact", {
      ref: `artifact://${second.taskId}/output.txt`,
      limit: 2000,
    });
    assert.match(page.text, /remember plugin marker/);
    assert.equal(
      readFileSync(path.join(dir, ".agent-bridge/lock/pid"), "utf8"),
      pid,
    );
    await stop(dir);
    await tool(two, "agents_list", {});
    assert.notEqual(
      readFileSync(path.join(dir, ".agent-bridge/lock/pid"), "utf8"),
      pid,
    );
    assert.equal(
      (await tool(two, "agents_status", { taskId: first.taskId })).status,
      "completed",
    );
  } finally {
    await one?.close();
    await two?.close();
    await stop(dir);
  }
});
test("specialist tools expose .specialists specs through MCP without instructions in listings", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-plugin-catalog-"));
  const specDir = path.join(
    dir,
    ".specialists",
    "hivemind",
    "triage-investigator",
  );
  mkdirSync(specDir, { recursive: true });
  writeFileSync(
    path.join(specDir, "specialist.yaml"),
    JSON.stringify({
      format: 1,
      namespace: "hivemind",
      id: "triage-investigator",
      name: "Triage investigator",
      version: "1.0.0",
      description: "Investigates local source and KB files",
      instructions: "SECRET_INSTRUCTIONS",
      delivery: "task-instructions",
    }),
  );
  const client = await connect(dir);
  try {
    const all = await tool(client, "specialists_catalog", {});
    const entry = all.find(
      (e) => e.catalog === "project" && e.id === "triage-investigator",
    );
    assert.ok(entry);
    assert.equal(entry.reference, "project:hivemind/triage-investigator");
    assert.equal(entry.instructions, undefined);
    const found = await tool(client, "specialists_catalog", {
      query: "TRIAGE",
    });
    const foundEntry = found.find(
      (e) => e.reference === "project:hivemind/triage-investigator",
    );
    assert.ok(foundEntry);
    assert.equal(foundEntry.instructions, undefined);
    const exact = await tool(client, "specialists_catalog", {
      reference: "project:hivemind/triage-investigator",
    });
    assert.equal(exact.instructions, "SECRET_INSTRUCTIONS");
    const contract = await tool(client, "specialists_schema", {});
    assert.ok(contract.specialistSpec.required.namespace);
    assert.equal(
      contract.availableCatalogs.project,
      path.join(realpathSync(dir), ".specialists"),
    );
    assert.ok(contract.availableCatalogs.global.endsWith(".specialists"));
    const validated = await tool(client, "specialists_validate", {
      specialistSpec: {
        format: 1,
        namespace: "me",
        id: "scratch-reviewer",
        name: "Scratch reviewer",
        version: "0.1.0",
        description: "One-off review specialist",
        instructions: "Review only",
        delivery: "task-instructions",
      },
    });
    assert.equal(validated.reference, "inline:me/scratch-reviewer");
    assert.equal(validated.catalog, "inline");
  } finally {
    await client.close();
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
test("a stale daemon defers the update while tasks run and restarts once they finish", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-plugin-pending-"));
  const prior = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(
    path.join(tmpdir(), "ab-plugin-home-"),
  );
  const { identifyWorkspace } = await import("../dist/workspaces.js");
  const { savePreferences } = await import("../dist/preferences.js");
  let client;
  try {
    client = await connect(dir);
    const a = await tool(client, "agents_spawn", {
      agentId: "demo",
      prompt: "SLOW",
    });
    for (
      let t = await tool(client, "agents_status", { taskId: a.taskId });
      t.status !== "running";
      t = await tool(client, "agents_status", { taskId: a.taskId })
    )
      await delay(150);
    savePreferences(dir, {
      version: 1,
      workspaceIdentity: identifyWorkspace(dir),
      useManagedDefaults: false,
      agents: {},
      runtime: { maxInlineChars: 1500 },
    });
    const blocked = await client.callTool({
      name: "agents_spawn",
      arguments: { agentId: "demo", prompt: "new work" },
    });
    assert.ok(blocked.isError);
    assert.match(blocked.content[0].text, /update is pending/);
    const blockedRun = await client.callTool({
      name: "agents_run",
      arguments: { agentId: "demo", prompt: "new work" },
    });
    assert.ok(blockedRun.isError);
    assert.match(blockedRun.content[0].text, /update is pending/);
    assert.equal(
      (await tool(client, "agents_status", { taskId: a.taskId })).status,
      "running",
      "supervision stays available on the stale daemon",
    );
    await tool(client, "agents_cancel", { taskId: a.taskId });
    for (
      let t = await tool(client, "agents_status", { taskId: a.taskId });
      t.status !== "cancelled";
      t = await tool(client, "agents_status", { taskId: a.taskId })
    )
      await delay(150);
    const resumed = await tool(client, "agents_spawn", {
      agentId: "demo",
      prompt: "quick",
    });
    assert.ok(
      resumed.taskId,
      "first call after terminal restarts and proceeds",
    );
    await tool(client, "agents_wait", {
      taskIds: [resumed.taskId],
      timeoutMs: 4000,
    });
  } finally {
    await client?.close();
    await stop(dir);
    if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior;
  }
});
test("plugin MCP calls follow a changed effective config to a new socket", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-plugin-switch-"));
  const prior = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(
    path.join(tmpdir(), "ab-plugin-home-"),
  );
  const { stringify } = await import("yaml");
  const stopPid = async (stateDir) => {
    const pidFile = path.join(dir, stateDir, "lock", "pid");
    if (!existsSync(pidFile)) return;
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
    } catch {}
    for (let i = 0; i < 100 && existsSync(pidFile); i++) await delay(20);
  };
  let client;
  try {
    client = await connect(dir);
    const managed = await tool(client, "agents_list");
    assert.ok(managed.length > 0);
    assert.ok(existsSync(path.join(dir, ".agent-bridge", "lock")));
    writeFileSync(
      path.join(dir, "agents.bridge.yaml"),
      stringify({
        version: 1,
        runtime: { stateDir: "bridge-state" },
        providers: {
          mock: {
            command: "node",
            args: [path.join(root, "scripts/mock-acp.mjs")],
            env: {
              MOCK_STATE: path.join(dir, "bridge-state", "mock-sessions.json"),
            },
            readOnlyEnforced: true,
          },
        },
        agents: {
          solo: {
            provider: "mock",
            description: "project override worker",
            workspace: "read-only",
          },
        },
      }),
    );
    const switched = await tool(client, "agents_list");
    assert.deepEqual(
      switched.map((a) => a.agentId),
      ["solo"],
      "the next call used the new advanced base, not the startup config",
    );
    assert.ok(
      existsSync(path.join(dir, "bridge-state", "lock")),
      "a daemon started on the new stateDir/socket",
    );
  } finally {
    await client?.close();
    await stop(dir);
    await stopPid("bridge-state");
    if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior;
  }
});
const cliArgs = (command, input) => [
  path.join(root, "dist/cli.js"),
  command,
  ...(input === undefined ? [] : [JSON.stringify(input)]),
];
const cliEnv = (home, extra = {}) => {
  const env = { ...process.env, XDG_CONFIG_HOME: home };
  delete env.AGENT_BRIDGE_CONFIG;
  return { ...env, ...extra };
};
const fixtureBridgeConfig = (dir) => ({
  version: 1,
  providers: {
    mock: {
      command: "node",
      args: [path.join(root, "scripts/mock-acp.mjs")],
      env: { MOCK_STATE: path.join(dir, "mock-sessions.json") },
      readOnlyEnforced: true,
    },
    ghost: { command: "nonexistent-agent-bridge-binary", args: [], env: {} },
    needer: {
      command: "node",
      args: [],
      requires: ["nonexistent-agent-bridge-dep"],
      env: {},
    },
  },
  agents: {
    fixture: {
      provider: "mock",
      description: "fixture worker",
      workspace: "read-only",
    },
    gone: {
      provider: "ghost",
      description: "unavailable",
      workspace: "project",
    },
    deps: {
      provider: "needer",
      description: "missing dependency",
      workspace: "project",
    },
  },
});
test("plugin-settings reports provenance, probes and a preferences path before save", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-plugin-settings-"));
  const home = mkdtempSync(path.join(tmpdir(), "ab-plugin-home-"));
  const { stringify } = await import("yaml");
  writeFileSync(
    path.join(dir, "agents.bridge.yaml"),
    stringify(fixtureBridgeConfig(dir)),
  );
  try {
    const out = JSON.parse(
      execFileSync(process.execPath, cliArgs("plugin-settings"), {
        cwd: dir,
        env: cliEnv(home),
        encoding: "utf8",
        timeout: 90000,
      }),
    );
    assert.equal(out.workspace, realpathSync(dir));
    assert.match(
      out.preferencesFile,
      /agent-bridge[\\/]workspaces[\\/][a-f0-9]{64}\.yaml$/,
    );
    assert.equal(
      existsSync(out.preferencesFile),
      false,
      "settings never creates preferences",
    );
    assert.equal(out.readiness.status, "ready");
    assert.ok(out.sources.project.endsWith("agents.bridge.yaml"));
    const fixture = out.agents.find((a) => a.agentId === "fixture");
    assert.equal(fixture.available, true);
    assert.deepEqual(
      fixture.options.map((o) => o.id),
      ["mode", "review", "telemetry"],
    );
    const unavailable = out.agents.filter((a) => !a.available);
    assert.deepEqual(
      unavailable.map((a) => a.agentId),
      ["gone", "deps"],
      "only fixture profiles are probed; no installed harness is launched",
    );
    assert.ok(unavailable.every((a) => a.error));
    assert.doesNotMatch(JSON.stringify(out), /mock-sessions\.json/);
    const disabled = JSON.parse(
      execFileSync(process.execPath, cliArgs("plugin-settings"), {
        cwd: dir,
        env: cliEnv(home, { AGENT_BRIDGE_WORKER: "1" }),
        encoding: "utf8",
        timeout: 90000,
      }),
    );
    assert.equal(disabled.disabled, true);
  } finally {
    await stop(dir);
  }
});
test("plugin-settings returns probes with a bounded readiness error when the daemon cannot start", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-plugin-down-"));
  const home = mkdtempSync(path.join(tmpdir(), "ab-plugin-home-"));
  const { stringify } = await import("yaml");
  const config = fixtureBridgeConfig(dir);
  config.runtime = { stateDir: "blocked-state" };
  writeFileSync(path.join(dir, "agents.bridge.yaml"), stringify(config));
  writeFileSync(path.join(dir, "blocked-state"), "not a directory");
  try {
    const out = JSON.parse(
      execFileSync(
        process.execPath,
        cliArgs("plugin-settings", { agentId: "fixture" }),
        {
          cwd: dir,
          env: cliEnv(home),
          encoding: "utf8",
          timeout: 90000,
        },
      ),
    );
    assert.equal(out.readiness.status, "error");
    assert.ok(out.readiness.error.length <= 500);
    const fixture = out.agents.find((a) => a.agentId === "fixture");
    assert.equal(fixture.available, true);
    assert.deepEqual(
      fixture.options.map((o) => o.id),
      ["mode", "review", "telemetry"],
      "probes still run when daemon startup fails",
    );
  } finally {
    await stop(dir);
  }
});
test("plugin-settings with an unknown profile fails before starting a daemon", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-plugin-unknown-"));
  const home = mkdtempSync(path.join(tmpdir(), "ab-plugin-home-"));
  const { stringify } = await import("yaml");
  writeFileSync(
    path.join(dir, "agents.bridge.yaml"),
    stringify(fixtureBridgeConfig(dir)),
  );
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          cliArgs("plugin-settings", { agentId: "nope" }),
          { cwd: dir, env: cliEnv(home), encoding: "utf8", timeout: 90000 },
        ),
      /Unknown agent "nope"/,
    );
    const stateDir = path.join(dir, ".agent-bridge");
    assert.equal(
      existsSync(path.join(stateDir, "lock")) ||
        existsSync(path.join(stateDir, "daemon.log")),
      false,
      "no daemon was started for an unknown profile",
    );
  } finally {
    await stop(dir);
  }
});
test("an explicit AGENT_BRIDGE_CONFIG is read-only for settings operations", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-plugin-explicit-"));
  const home = mkdtempSync(path.join(tmpdir(), "ab-plugin-home-"));
  const { stringify } = await import("yaml");
  const file = path.join(dir, "trusted.yaml");
  writeFileSync(file, stringify(fixtureBridgeConfig(dir)));
  const env = cliEnv(home, { AGENT_BRIDGE_CONFIG: file });
  const run = (command, input) =>
    execFileSync(process.execPath, cliArgs(command, input), {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 90000,
    });
  try {
    const settings = JSON.parse(run("plugin-settings", { agentId: "fixture" }));
    assert.equal(settings.sources.explicitEnvironment, file);
    assert.equal(settings.agents[0].available, true);
    assert.throws(() =>
      run("plugin-configure", {
        agentId: "fixture",
        configId: "mode",
        value: "bypass",
      }),
    );
    assert.throws(() =>
      run("plugin-configure", {
        agentId: "fixture",
        configId: "mode",
        clear: true,
      }),
    );
    assert.throws(() => run("plugin-migrate-managed"));
    assert.equal(
      existsSync(path.join(home, "agent-bridge", "workspaces")),
      false,
      "refused operations never create preferences",
    );
  } finally {
    await stop(dir);
  }
});
test("plugin-configure validates, saves and clears without changing bytes on failure", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-plugin-configure-"));
  const home = mkdtempSync(path.join(tmpdir(), "ab-plugin-home-"));
  const env = cliEnv(home);
  const run = (command, input) =>
    execFileSync(process.execPath, cliArgs(command, input), {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 90000,
    });
  const { parse } = await import("yaml");
  try {
    const set = JSON.parse(
      run("plugin-configure", {
        agentId: "demo",
        configId: "mode",
        value: "bypass",
      }),
    );
    assert.equal(set.saved, true);
    assert.equal(set.readiness.status, "ready");
    assert.equal(set.sessionConfig.mode, "bypass");
    const prefs = () => parse(readFileSync(set.preferencesFile, "utf8"));
    assert.equal(prefs().useManagedDefaults, true);
    assert.equal(prefs().agents.demo.sessionConfig.mode, "bypass");
    const second = JSON.parse(
      run("plugin-configure", {
        agentId: "demo",
        configId: "telemetry",
        value: true,
      }),
    );
    assert.deepEqual(second.sessionConfig, { mode: "bypass", telemetry: true });
    let bytes = readFileSync(set.preferencesFile, "utf8");
    assert.throws(() =>
      run("plugin-configure", {
        agentId: "demo",
        configId: "mode",
        value: "sometimes",
      }),
    );
    assert.throws(() =>
      run("plugin-configure", {
        agentId: "demo",
        configId: "not-an-option",
        value: "x",
      }),
    );
    assert.throws(() =>
      run("plugin-configure", { agentId: "ghost", configId: "x", value: "y" }),
    );
    assert.equal(
      readFileSync(set.preferencesFile, "utf8"),
      bytes,
      "failed saves leave preference bytes unchanged",
    );
    const cleared = JSON.parse(
      run("plugin-configure", {
        agentId: "demo",
        configId: "mode",
        clear: true,
      }),
    );
    assert.deepEqual(cleared.sessionConfig, { telemetry: true });
    assert.equal(prefs().agents.demo.sessionConfig.mode, undefined);
    assert.equal(prefs().agents.demo.sessionConfig.telemetry, true);
    assert.doesNotMatch(
      readFileSync(set.preferencesFile, "utf8"),
      /mock-sessions\.json|MOCK_STATE/,
      "no provider env values reach preferences",
    );
    bytes = readFileSync(set.preferencesFile, "utf8");
  } finally {
    await stop(dir);
  }
});
test("plugin-configure refuses unavailable advanced profiles without spawning them", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-plugin-refuse-"));
  const home = mkdtempSync(path.join(tmpdir(), "ab-plugin-home-"));
  const { stringify } = await import("yaml");
  writeFileSync(
    path.join(dir, "agents.bridge.yaml"),
    stringify(fixtureBridgeConfig(dir)),
  );
  const run = (command, input) =>
    execFileSync(process.execPath, cliArgs(command, input), {
      cwd: dir,
      env: cliEnv(home),
      encoding: "utf8",
      timeout: 90000,
    });
  try {
    assert.throws(() =>
      run("plugin-configure", {
        agentId: "gone",
        configId: "mode",
        value: "ask",
      }),
    );
    assert.throws(() =>
      run("plugin-configure", {
        agentId: "deps",
        configId: "mode",
        value: "ask",
      }),
    );
    assert.equal(
      existsSync(path.join(home, "agent-bridge", "workspaces")),
      false,
      "refused configuration never writes preferences",
    );
  } finally {
    await stop(dir);
  }
});
test("plugin-configure saves while tasks run and reports update_pending", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-plugin-busy-"));
  const prior = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(
    path.join(tmpdir(), "ab-plugin-home-"),
  );
  let client;
  try {
    client = await connect(dir);
    const task = await tool(client, "agents_spawn", {
      agentId: "demo",
      prompt: "SLOW",
    });
    for (
      let t = await tool(client, "agents_status", { taskId: task.taskId });
      t.status !== "running";
      t = await tool(client, "agents_status", { taskId: task.taskId })
    )
      await delay(150);
    const out = JSON.parse(
      execFileSync(
        process.execPath,
        cliArgs("plugin-configure", {
          agentId: "demo",
          configId: "mode",
          value: "bypass",
        }),
        {
          cwd: dir,
          env: { ...process.env },
          encoding: "utf8",
          timeout: 90000,
        },
      ),
    );
    assert.equal(out.saved, true);
    assert.equal(out.readiness.status, "update_pending");
    assert.ok(out.readiness.activeTaskIds.includes(task.taskId));
    const { parse } = await import("yaml");
    assert.equal(
      parse(readFileSync(out.preferencesFile, "utf8")).agents.demo.sessionConfig
        .mode,
      "bypass",
      "preference is saved while the restart stays pending",
    );
    await tool(client, "agents_cancel", { taskId: task.taskId });
  } finally {
    await client?.close();
    await stop(dir);
    if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior;
  }
});
test("plugin-migrate-managed switches bases without touching source files", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-plugin-migrate-"));
  const home = mkdtempSync(path.join(tmpdir(), "ab-plugin-home-"));
  const env = cliEnv(home);
  const run = (command, input) =>
    execFileSync(process.execPath, cliArgs(command, input), {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 90000,
    });
  const { stringify, parse } = await import("yaml");
  const projectFile = path.join(dir, "agents.bridge.yaml");
  writeFileSync(
    projectFile,
    stringify({
      version: 1,
      providers: {
        mock: {
          command: "node",
          args: [path.join(root, "scripts/mock-acp.mjs")],
          env: {},
          readOnlyEnforced: true,
        },
      },
      agents: {
        solo: {
          provider: "mock",
          description: "project worker",
          workspace: "read-only",
          sessionConfig: { mode: "bypass" },
        },
      },
    }),
  );
  const projectBytes = readFileSync(projectFile, "utf8");
  try {
    const set = JSON.parse(
      run("plugin-configure", {
        agentId: "solo",
        configId: "mode",
        value: "bypass",
      }),
    );
    assert.equal(
      parse(readFileSync(set.preferencesFile, "utf8")).useManagedDefaults,
      false,
      "configuring under an advanced base does not implicitly switch",
    );
    const migrated = JSON.parse(run("plugin-migrate-managed"));
    assert.equal(migrated.saved, true);
    assert.equal(migrated.useManagedDefaults, true);
    assert.equal(migrated.readiness.status, "ready");
    assert.equal(
      readFileSync(projectFile, "utf8"),
      projectBytes,
      "the advanced project file is preserved byte for byte",
    );
    const yaml = parse(readFileSync(migrated.preferencesFile, "utf8"));
    assert.equal(yaml.useManagedDefaults, true);
    assert.equal(
      yaml.agents.solo.sessionConfig.mode,
      "bypass",
      "saved settings survive migration",
    );
    const settings = JSON.parse(run("plugin-settings", { agentId: "demo" }));
    assert.ok(
      settings.agents.find((a) => a.agentId === "demo"),
      "managed bundled profiles apply after migration",
    );
    assert.equal(
      settings.agents.length,
      1,
      "single-profile probe never launches other harnesses",
    );
  } finally {
    await stop(dir);
  }
});
