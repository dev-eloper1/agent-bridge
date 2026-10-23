import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import {
  probeAgentSettings,
  probeAllAgentSettings,
  sanitizeSettingsError,
} from "../dist/worker-settings.js";
const root = process.cwd();
function fixture(extraAgents = {}, extraProviders = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-wsprobe-"));
  const state = path.join(dir, "state");
  mkdirSync(state);
  const file = path.join(dir, "agents.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      runtime: { stateDir: "state" },
      providers: {
        mock: {
          command: "node",
          args: [path.join(root, "scripts/mock-acp.mjs")],
          env: {
            MOCK_STATE: path.join(state, "mock.json"),
            MOCK_PID_FILE: path.join(state, "mock.pid"),
          },
          readOnlyEnforced: true,
        },
        legacy: {
          command: "node",
          args: [path.join(root, "scripts/mock-acp.mjs"), "--legacy-modes"],
          env: { MOCK_STATE: path.join(state, "legacy.json") },
        },
        ghost: {
          command: "nonexistent-agent-bridge-binary",
          args: [],
          env: {},
        },
        needer: {
          command: "node",
          args: [],
          requires: ["nonexistent-agent-bridge-dep"],
          env: {},
        },
        crasher: {
          command: "node",
          args: ["-e", "process.exit(1)"],
          env: {},
        },
        ...extraProviders,
      },
      agents: {
        demo: {
          provider: "mock",
          description: "probe fixture",
          workspace: "read-only",
          sessionConfig: { mode: "bypass" },
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
        crash: {
          provider: "crasher",
          description: "fails handshake",
          workspace: "project",
        },
        ...extraAgents,
      },
    }),
  );
  return { dir, state, file, config: loadConfig(file) };
}
test("probe reports normalized options without prompting and kills the worker", async () => {
  const f = fixture();
  const probe = await probeAgentSettings(f.config, "demo");
  assert.equal(probe.agentId, "demo");
  assert.equal(probe.provider, "mock");
  assert.equal(probe.available, true);
  assert.equal(probe.readOnlyEnforced, true);
  assert.equal(probe.error, undefined);
  assert.deepEqual(probe.requested, { mode: "bypass" });
  assert.deepEqual(
    probe.options.map((o) => o.id),
    ["mode", "review", "telemetry"],
  );
  assert.equal(probe.options[0].source, "config_option");
  assert.equal(probe.options[2].type, "boolean");
  assert.equal(
    existsSync(path.join(f.state, "mock.json-prompt-count")),
    false,
    "probe never invokes session/prompt",
  );
  const pid = Number(readFileSync(path.join(f.state, "mock.pid"), "utf8"));
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 30));
    } catch {
      break;
    }
  }
  assert.throws(() => process.kill(pid, 0), "worker process is dead");
});
test("probeAll skips internal profiles while direct probe still works", async () => {
  const f = fixture({
    hidden: {
      provider: "mock",
      description: "internal fixture",
      workspace: "read-only",
      internal: true,
    },
  });
  const all = await probeAllAgentSettings(f.config);
  assert.deepEqual(
    all.map((p) => p.agentId),
    ["demo", "gone", "deps", "crash"],
  );
  const direct = await probeAgentSettings(f.config, "hidden");
  assert.equal(direct.agentId, "hidden");
  assert.equal(direct.available, true);
  assert.equal(direct.error, undefined);
});
test("legacy harnesses surface a legacy_mode option", async () => {
  const f = fixture({
    old: { provider: "legacy", description: "legacy", workspace: "project" },
  });
  const probe = await probeAgentSettings(f.config, "old");
  assert.equal(probe.available, true);
  assert.deepEqual(
    probe.options.map((o) => `${o.id}:${o.source}`),
    ["mode:legacy_mode"],
  );
});
test("unavailable executables, missing dependencies and handshake failures stay isolated", async () => {
  const f = fixture();
  const gone = await probeAgentSettings(f.config, "gone");
  assert.equal(gone.available, false);
  assert.equal(gone.options.length, 0);
  assert.match(gone.error, /unavailable|executable/i);
  const deps = await probeAgentSettings(f.config, "deps");
  assert.equal(deps.available, false);
  assert.match(deps.error, /nonexistent-agent-bridge-dep/);
  const crash = await probeAgentSettings(f.config, "crash");
  assert.equal(crash.available, true);
  assert.ok(crash.error, "handshake failure is bounded, not thrown");
  assert.equal(crash.options.length, 0);
  await assert.rejects(
    () => probeAgentSettings(f.config, "nope"),
    /Unknown agent/,
  );
});
test("a hung provider times out bounded and is always killed", async () => {
  const stuckPidFile = path.join(
    tmpdir(),
    `ab-stuck-${process.pid}-${Date.now()}.pid`,
  );
  const f = fixture(
    {
      stuck: {
        provider: "stuck",
        description: "never speaks ACP",
        workspace: "project",
      },
    },
    {
      stuck: {
        command: "node",
        args: [
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(stuckPidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
        ],
        env: {},
      },
    },
  );
  const started = Date.now();
  const [stuck, demo] = await Promise.all([
    probeAgentSettings(f.config, "stuck", { timeoutMs: 250 }),
    probeAgentSettings(f.config, "demo"),
  ]);
  assert.equal(stuck.available, true);
  assert.equal(stuck.options.length, 0);
  assert.match(stuck.error, /timed out after 250ms/);
  assert.ok(stuck.error.length <= 500);
  assert.ok(Date.now() - started < 15000, "probe did not hang");
  assert.equal(
    demo.error,
    undefined,
    "a timed-out profile does not affect others",
  );
  const pid = Number(readFileSync(stuckPidFile, "utf8"));
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 30));
    } catch {
      break;
    }
  }
  assert.throws(() => process.kill(pid, 0), "hung process is dead");
});
test("configured and inherited env values are redacted from errors regardless of key name", () => {
  const f = fixture(
    {},
    {
      leaky: {
        command: "node",
        args: [],
        env: { PLAIN_VALUE: "abcdefghij-plain-value" },
        envNames: ["AB_TEST_SENTINEL_ENV"],
      },
    },
  );
  process.env.AB_TEST_SENTINEL_ENV = "inherited-value-123456";
  try {
    const redacted = sanitizeSettingsError(
      f.config,
      new Error("leak abcdefghij-plain-value and inherited-value-123456 done"),
    );
    assert.equal(redacted, "leak [REDACTED] and [REDACTED] done");
  } finally {
    delete process.env.AB_TEST_SENTINEL_ENV;
  }
});
test("probeAll preserves config order and isolates per-profile failures", async () => {
  const f = fixture();
  const probes = await probeAllAgentSettings(f.config);
  assert.deepEqual(
    probes.map((p) => p.agentId),
    Object.keys(f.config.agents),
  );
  const byId = Object.fromEntries(probes.map((p) => [p.agentId, p]));
  assert.equal(byId.demo.available, true);
  assert.equal(byId.gone.available, false);
  assert.ok(byId.crash.error);
});
