import {
  client,
  ndJsonStream,
  type ClientConnection,
  type InitializeResponse,
  type NewSessionResponse,
  type LoadSessionResponse,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { executablePath, resolveExecutable } from "./executables.js";
export class Worker {
  child: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  init?: InitializeResponse;
  dead = false;
  constructor(
    c: Config,
    providerId: string,
    cwd: string,
    hooks: {
      update: (value: unknown) => void;
      question: (kind: "input" | "permission", value: any) => Promise<any>;
      exit: () => void;
      log: (s: string) => void;
    },
  ) {
    const p = c.providers[providerId];
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "TMPDIR",
      "LANG",
      "SHELL",
      "SystemRoot",
      ...p.envNames,
    ])
      if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, p.env);
    env.AGENT_BRIDGE_WORKER = "1";
    env.PATH = executablePath(env);
    for (const requirement of p.requires)
      if (!resolveExecutable(requirement, c.root, env.PATH))
        throw Error(`Missing provider dependency: ${requirement}`);
    for (const name of p.envPaths) {
      if (!env[name]) continue;
      const value = env[name]!;
      env[name] =
        resolveExecutable(value, c.root, env.PATH) ??
        (value.startsWith("~/")
          ? path.join(process.env.HOME!, value.slice(2))
          : path.resolve(c.root, value));
    }
    // Resolve configured relative paths against the config, not the worker's worktree.
    const command = resolveExecutable(p.command, c.root, env.PATH);
    if (!command) throw Error(`Provider executable unavailable: ${p.command}`);
    const args = p.args.map((x) =>
      /^(\.\/|scripts\/)/.test(x) ? path.resolve(c.root, x) : x,
    );
    for (const [k, v] of Object.entries(p.env))
      if (k.endsWith("_STATE")) env[k] = path.resolve(c.root, v);
    this.child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./worker-host.js", import.meta.url)),
        command,
        ...args,
      ],
      { cwd, env, stdio: "pipe", detached: process.platform !== "win32" },
    );
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (b) => hooks.log(b.toString()));
    const app = client({ name: "agent-bridge" });
    app.onNotification("session/update", ({ params }) => hooks.update(params));
    app.onRequest("session/request_permission", ({ params }) =>
      hooks.question("permission", params),
    );
    app.onRequest("elicitation/create", ({ params }) => {
      if (params.mode !== "form") return { action: "decline" };
      return hooks.question("input", params);
    });
    this.connection = app.connect(
      ndJsonStream(
        Writable.toWeb(this.child.stdin),
        Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
        { maxMessageBytes: 1024 * 1024 },
      ),
    );
    this.child.on("error", () => {
      this.dead = true;
      this.connection.close();
      hooks.exit();
    });
    this.child.on("exit", () => {
      this.dead = true;
      this.connection.close();
      hooks.exit();
    });
    void this.connection.closed.then(() => {
      if (!this.dead) this.kill();
    });
  }
  async initialize() {
    this.init = await this.connection.agent.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "agent-bridge", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
      },
    });
    return this.init;
  }
  async session(
    cwd: string,
    nativeSessionId?: string,
  ): Promise<NewSessionResponse | LoadSessionResponse> {
    if (nativeSessionId) {
      if (!this.init?.agentCapabilities?.loadSession)
        throw Error(
          "Backend does not support session/load; continuity unavailable",
        );
      return this.connection.agent.request("session/load", {
        sessionId: nativeSessionId,
        cwd,
        mcpServers: [],
      });
    }
    return this.connection.agent.request("session/new", {
      cwd,
      mcpServers: [],
    });
  }
  prompt(sessionId: string, text: string) {
    return this.connection.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }
  cancel(sessionId: string) {
    return this.connection.agent
      .notify("session/cancel", { sessionId })
      .catch(() => {});
  }
  kill() {
    this.dead = true;
    this.connection.close();
    if (this.child.pid) {
      try {
        process.kill(
          process.platform === "win32" ? this.child.pid : -this.child.pid,
          "SIGKILL",
        );
      } catch {}
    }
  }
}
