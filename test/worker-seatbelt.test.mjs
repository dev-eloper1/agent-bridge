import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  symlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { seatbeltProfile } from "../dist/seatbelt.js";
import { schema } from "../dist/config.js";
import { Runtime } from "../dist/runtime.js";
import { Worker } from "../dist/acp.js";
const darwin =
  process.platform === "darwin"
    ? false
    : "sandbox-exec is macOS only; isolation fails closed elsewhere";
function scratch() {
  return mkdtempSync(path.join(process.cwd(), ".sb-"));
}
function config(agent = {}) {
  return {
    version: 1,
    providers: {
      mock: {
        command: process.execPath,
        args: [path.resolve("scripts/mock-acp.mjs")],
      },
    },
    agents: {
      demo: { provider: "mock", description: "seatbelt fixture", ...agent },
    },
  };
}
test("seatbelt profile quotes paths and covers canonical state and relocated socket", () => {
  const paths = {
    stateDir: "/alias/state",
    realStateDir: "/private/state",
    socket: "/tmp/relocated.sock",
    realSocket: "/private/tmp/relocated.sock",
  };
  const p = seatbeltProfile(paths);
  for (const value of [
    ...Object.values(paths),
    "/alias/state/runtime.sock",
    "/private/state/runtime.sock",
  ])
    assert.ok(p.includes(`"${value}"`));
  const odd = '/tmp/a"\\)(allow default);☃';
  assert.ok(
    seatbeltProfile({ ...paths, stateDir: odd }).includes(
      '"/tmp/a\\"\\\\)(allow default);☃"',
    ),
  );
  for (const stateDir of ["/tmp/new\nline", "/tmp/\0bad", "relative"])
    assert.throws(
      () => seatbeltProfile({ ...paths, stateDir }),
      /absolute|control/,
    );
});
test("seatbelt is opt-in and refuses native or undeclared sandbox and incompatible workspace", () => {
  assert.equal(schema.parse(config()).agents.demo.isolation, "none");
  for (const providerSandbox of [undefined, "native"])
    assert.throws(
      () => schema.parse(config({ isolation: "seatbelt", providerSandbox })),
      /cannot nest/,
    );
  assert.throws(
    () =>
      schema.parse(
        config({
          isolation: "seatbelt",
          providerSandbox: "none",
          workspace: "isolated-worktree",
        }),
      ),
    /worktrees/,
  );
  if (process.platform !== "darwin")
    assert.throws(
      () =>
        schema.parse(
          config({ isolation: "seatbelt", providerSandbox: "none" }),
        ),
      /macOS/,
    );
  else
    assert.equal(
      schema.parse(config({ isolation: "seatbelt", providerSandbox: "none" }))
        .agents.demo.isolation,
      "seatbelt",
    );
});
function run(profile, script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", profile, process.execPath, "-e", script, ...args],
      { timeout: 8000 },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
test(
  "real seatbelt: EPERM for state read/write and relocated socket; workspace and HOME readable",
  { skip: darwin, timeout: 15000 },
  async (t) => {
    const dir = scratch();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const state = path.join(dir, 'state"\\odd');
    mkdirSync(state);
    const alias = path.join(dir, "alias");
    symlinkSync(state, alias);
    const workspace = path.join(dir, "workspace");
    mkdirSync(workspace);
    const home = path.join(dir, "home");
    mkdirSync(home);
    for (const folder of [state, workspace, home])
      writeFileSync(path.join(folder, "file"), "readable");
    const socket = path.join(dir, "runtime.sock");
    let connections = 0;
    const server = createServer((s) => {
      connections++;
      s.destroy();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path.relative(process.cwd(), socket), resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const profile = seatbeltProfile({
      stateDir: alias,
      realStateDir: realpathSync(state),
      socket,
      realSocket: path.join(realpathSync(dir), "runtime.sock"),
    });
    const result = await run(
      profile,
      `
    const fs = require('node:fs'), net = require('node:net');
    const [state, alias, workspace, home, socket] = process.argv.slice(1);
    const out = {};
    for (const [key, folder] of Object.entries({ state, alias, workspace, home })) {
      try { out[key] = fs.readFileSync(folder + '/file', 'utf8'); } catch(e) { out[key] = e.code; }
    }
    try { fs.writeFileSync(state + '/new', 'blocked'); out.write = 'allowed'; } catch(e) { out.write = e.code; }
    const c = net.createConnection(socket);
    c.once('error', e => { out.socket = e.code; console.log(JSON.stringify(out)); });
    c.once('connect', () => { out.socket = 'connected'; c.end(); console.log(JSON.stringify(out)); });
  `,
      [state, alias, workspace, home, path.relative(process.cwd(), socket)],
    );
    assert.equal(result.code, 0, result.stderr);
    t.diagnostic(result.stdout.trim());
    assert.deepEqual(JSON.parse(result.stdout), {
      state: "EPERM",
      alias: "EPERM",
      workspace: "readable",
      home: "readable",
      write: "EPERM",
      socket: "EPERM",
    });
    assert.equal(connections, 0);
  },
);
test(
  "mock ACP provider completes task through seatbelt and guardian",
  { skip: darwin, timeout: 15000 },
  async (t) => {
    const dir = scratch();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const state = path.join(dir, "state");
    mkdirSync(state);
    const parsed = schema.parse(
      config({ isolation: "seatbelt", providerSandbox: "none" }),
    );
    parsed.providers.mock.env.MOCK_STATE = path.join(dir, "mock-sessions.json");
    const c = {
      ...parsed,
      root: process.cwd(),
      stateDir: state,
      socket: path.join(state, "runtime.sock"),
    };
    const updates = [],
      logs = [];
    const worker = new Worker(
      c,
      "mock",
      process.cwd(),
      {
        update: (u) => updates.push(u),
        question: async () => ({ action: "decline" }),
        exit: () => {},
        log: (s) => logs.push(s),
      },
      c.agents.demo,
    );
    t.after(() => worker.kill());
    assert.equal(worker.child.spawnfile, "/usr/bin/sandbox-exec");
    await worker.initialize();
    const session = await worker.session(process.cwd());
    const result = await worker.prompt(session.sessionId, "Hello seatbelt");
    assert.equal(result.stopReason, "end_turn", logs.join(""));
    assert.ok(updates.length > 0);
    assert.ok(
      existsSync(
        `${parsed.providers.mock.env.MOCK_STATE}-${session.sessionId}.json`,
      ),
    );
    t.diagnostic(
      `mock stopReason=${result.stopReason}; updates=${updates.length}`,
    );
  },
);

test("Codex sandboxed modes rejected even with providerSandbox none", () => {
  for (const mode of [undefined, "read-only", "workspace-write", "agent"]) {
    const c = config({
      isolation: "seatbelt",
      providerSandbox: "none",
      sessionConfig: mode ? { mode } : {},
    });
    c.providers.mock.command = "./node_modules/.bin/codex-acp";
    assert.throws(() => schema.parse(c), /agent-full-access/);
  }
});
test(
  "runtime task completes with per-agent seatbelt enabled",
  { skip: darwin, timeout: 15000 },
  async (t) => {
    const dir = scratch();
    const file = path.join(dir, "agents.json");
    const input = config({ isolation: "seatbelt", providerSandbox: "none", maxConcurrent: 1 });
    input.providers.mock.env = {
      MOCK_STATE: path.join(dir, "mock-sessions.json"),
    };
    writeFileSync(file, JSON.stringify(input));
    const parsed = schema.parse(input);
    assert.equal(parsed.agents.demo.isolation, "seatbelt");
    assert.equal(parsed.agents.demo.providerSandbox, "none");
    assert.equal(parsed.agents.demo.maxConcurrent, 1, "seatbelt retains the per-agent cap");
    const stateDir = path.join(dir, "state");
    const c = {
      ...parsed,
      root: realpathSync(dir),
      stateDir,
      socket: path.join(stateDir, "runtime.sock"),
      sourceFile: file,
      configDigest: "seatbelt-repair-fixture",
    };
    const runtime = new Runtime(c);
    // Hooks run in registration order: close before removing persisted state.
    t.after(async () => {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const task = await runtime.call("spawn", {
      agentId: "demo",
      prompt: "Hello wrapped runtime",
    });
    let result;
    const deadline = Date.now() + 8000;
    do {
      result = await runtime.call("status", { taskId: task.taskId });
      if (
        ["completed", "failed", "cancelled", "timed_out"].includes(
          result.status,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    t.diagnostic(`runtime task status=${result.status}`);
    assert.equal(result.status, "completed", JSON.stringify(result));
  },
);

for (const attack of ["socket", "parent"]) {
  test(
    `relocated directory denies rename-${attack} bypass`,
    { skip: darwin, timeout: 15000 },
    async (t) => {
      const dir = scratch();
      const state = path.join(dir, "state");
      mkdirSync(state);
      const relocation = path.join(dir, "reloc");
      mkdirSync(relocation);
      const socket = path.join(relocation, "s");
      let connections = 0;
      const server = createServer((s) => {
        connections++;
        s.destroy();
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(path.relative(process.cwd(), socket), resolve);
      });
      t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        rmSync(dir, { recursive: true, force: true });
      });
      const profile = seatbeltProfile({
        stateDir: state,
        realStateDir: realpathSync(state),
        socket,
        realSocket: socket,
      });
      const result = await run(
        profile,
        `
      const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
      const [attack, socket] = process.argv.slice(1);
      const out = {};
      const old = attack === 'socket' ? socket : path.dirname(socket);
      const moved = old + '-moved';
      try { fs.renameSync(old, moved); out.rename = 'allowed'; } catch(e) { out.rename = e.code; }
      const target = out.rename === 'allowed' ? (attack === 'socket' ? moved : path.join(moved, 's')) : socket;
      const c = net.createConnection(target);
      c.once('error', e => { out.connect = e.code; console.log(JSON.stringify(out)); });
      c.once('connect', () => { out.connect = 'CONNECTED'; c.end(); console.log(JSON.stringify(out)); });
    `,
        [attack, path.relative(process.cwd(), socket)],
      );
      assert.equal(result.code, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      t.diagnostic(JSON.stringify({ attack, ...observed, connections }));
      assert.deepEqual(observed, { rename: "EPERM", connect: "EPERM" });
      assert.equal(connections, 0);
    },
  );
}
test("relocation directory denies writes and connections under both tmp spellings", () => {
  const profile = seatbeltProfile({
    stateDir: "/workspace/state",
    realStateDir: "/workspace/state",
    socket: "/tmp/agent-bridge-501/hash.sock",
    realSocket: "/private/tmp/agent-bridge-501/hash.sock",
  });
  for (const directory of [
    "/tmp/agent-bridge-501",
    "/private/tmp/agent-bridge-501",
  ]) {
    assert.ok(profile.includes(`(deny file-write* (subpath "${directory}"))`));
    assert.ok(
      profile.includes(
        `(deny network-outbound (remote unix-socket (subpath "${directory}")))`,
      ),
    );
  }
  const ordinary = seatbeltProfile({
    stateDir: "/workspace/state",
    realStateDir: "/workspace/state",
    socket: "/workspace/state/runtime.sock",
    realSocket: "/workspace/state/runtime.sock",
  });
  assert.ok(!ordinary.includes('(deny file-write* (subpath "/workspace"))'));
});
