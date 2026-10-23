import {
  client,
  ndJsonStream,
  type ClientConnection,
  type InitializeResponse,
  type NewSessionResponse,
  type LoadSessionResponse,
} from "@agentclientprotocol/sdk/unstable";
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
        session: { configOptions: { boolean: {} } },
      },
    });
    return this.init;
  }
  async session(
    cwd: string,
    nativeSessionId?: string,
    systemInstructions?: string,
  ): Promise<NewSessionResponse | LoadSessionResponse> {
    // SDK 2.0.0's pinned v1 unstable schema is needed for this opt-in RFD field.
    // Ordinary sessions retain their existing v1 requests and no new fields.
    if (
      systemInstructions &&
      !this.init?.agentCapabilities?.sessionCapabilities?.systemPrompt
    )
      throw Error(
        "Backend does not advertise experimental ACP systemPrompt; choose a compatible harness or explicitly use task-instructions",
      );
    const system = systemInstructions
      ? {
          systemPrompt: {
            mode: "append",
            content: [{ type: "text" as const, text: systemInstructions }],
          },
        }
      : {};
    if (nativeSessionId) {
      if (!this.init?.agentCapabilities?.loadSession)
        throw Error(
          "Backend does not support session/load; continuity unavailable",
        );
      return this.connection.agent.request("session/load", {
        sessionId: nativeSessionId,
        cwd,
        mcpServers: [],
        ...system,
      });
    }
    return this.connection.agent.request("session/new", {
      cwd,
      mcpServers: [],
      ...system,
    });
  }
  async applySessionConfig(
    sessionId: string,
    configured: Record<string, string | boolean>,
    response: NewSessionResponse | LoadSessionResponse,
  ): Promise<{
    configOptions: any[];
    effective: Record<string, string | boolean>;
  }> {
    let options: any[] = (response as any).configOptions ?? [];
    const modes = (response as any).modes;
    const effective: Record<string, string | boolean> = {};
    const identifier = (o: any) => o?.id ?? o?.configId;
    const choices = (o: any): string[] =>
      (o?.options ?? []).flatMap((x: any) =>
        Array.isArray(x?.options)
          ? x.options.map((y: any) => String(y.value))
          : x && "value" in x
            ? [String(x.value)]
            : [],
      );
    for (const [key, value] of Object.entries(configured)) {
      const option = options.find((o) => identifier(o) === key);
      if (!option) {
        if (
          key === "mode" &&
          typeof value === "string" &&
          modes?.availableModes?.some((m: any) => m.id === value)
        ) {
          await this.connection.agent.request("session/set_mode", {
            sessionId,
            modeId: value,
          });
          effective[key] = value;
          continue;
        }
        throw Error(
          `Configured session option "${key}" is not advertised by the provider (available: ${
            options.map(identifier).filter(Boolean).join(", ") || "none"
          })`,
        );
      }
      const configId = identifier(option);
      const boolean = typeof option.currentValue === "boolean";
      if (boolean) {
        if (typeof value !== "boolean")
          throw Error(
            `Configured session option "${key}" expects a boolean value`,
          );
      } else {
        const advertised = choices(option);
        if (typeof value !== "string" || !advertised.includes(value))
          throw Error(
            `Configured session option "${key}" must be one of: ${
              advertised.join(", ") || "none advertised"
            }`,
          );
      }
      if (option.currentValue === value) {
        effective[key] = value;
        continue;
      }
      const result: any = await this.connection.agent.request(
        "session/set_config_option",
        {
          sessionId,
          configId,
          ...(boolean ? { value, type: "boolean" } : { value }),
        },
      );
      if (!Array.isArray(result?.configOptions))
        throw Error(
          `Provider did not confirm session option "${key}"=${JSON.stringify(value)}: set response lacks configOptions`,
        );
      options = result.configOptions;
      const confirmed = options.find((o) => identifier(o) === configId);
      if (!confirmed || confirmed.currentValue !== value)
        throw Error(
          `Provider did not confirm session option "${key}"=${JSON.stringify(value)}`,
        );
      effective[key] = confirmed.currentValue;
    }
    return { configOptions: options, effective };
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
