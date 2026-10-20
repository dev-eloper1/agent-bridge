import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { stringify } from "yaml";
import { randomUUID } from "node:crypto";
import { loadConfig, type Config } from "./config.js";
import { projectConfig } from "./project-config.js";
import { remote } from "./server.js";
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
export function pluginConfig(cwd = process.cwd()): {
  file: string;
  config: Config;
} {
  if (process.env.AGENT_BRIDGE_CONFIG) {
    const file = path.resolve(cwd, process.env.AGENT_BRIDGE_CONFIG);
    return { file, config: loadConfig(file) };
  }
  let workspace = realpathSync(cwd);
  try {
    workspace = execFileSync(
      "git",
      ["-C", workspace, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: "pipe" },
    ).trim();
  } catch {}
  const explicit = path.join(workspace, "agents.bridge.yaml");
  if (existsSync(explicit))
    return { file: explicit, config: loadConfig(explicit) };
  const dir = path.join(workspace, ".agent-bridge");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "plugin-agents.yaml");
  if (!existsSync(file)) {
    const prepared = projectConfig(
      loadConfig(path.join(pluginRoot, "agents.yaml")),
    );
    prepared.runtime = { ...prepared.runtime, workspaceRoot: workspace };
    const temp = file + "." + randomUUID() + ".tmp";
    writeFileSync(temp, stringify(prepared), { flag: "wx", mode: 0o600 });
    try {
      linkSync(temp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      unlinkSync(temp);
    }
  }
  return { file, config: loadConfig(file) };
}
export async function ensureRuntime(file: string, config: Config) {
  try {
    await remote(config, "list");
    return;
  } catch (e) {
    if (
      !["ENOENT", "ECONNREFUSED"].includes(
        (e as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw e;
  }
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const log = path.join(config.stateDir, "daemon.log");
  const fd = openSync(log, "a", 0o600);
  let launchError: Error | undefined;
  try {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./cli.js", import.meta.url)),
        "--config",
        file,
        "serve",
      ],
      {
        cwd: config.root,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: process.env,
      },
    );
    child.on("error", (error) => {
      launchError = error;
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      await remote(config, "list");
      return;
    } catch {
      if (launchError)
        throw Error(
          `Agent Bridge daemon launch failed: ${launchError.message}. Inspect ${log}`,
        );
      await new Promise((r) => setTimeout(r, 75));
    }
  }
  throw Error(
    `Agent Bridge could not start. Inspect ${log}: ${existsSync(log) ? readFileSync(log, "utf8").slice(-400) : "no log"}`,
  );
}
export async function bootstrap(cwd = process.cwd()) {
  const { file, config } = pluginConfig(cwd);
  await ensureRuntime(file, config);
  return { file, config, socket: config.socket, workspace: config.root };
}
