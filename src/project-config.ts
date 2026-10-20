import path from "node:path";
import { homedir } from "node:os";
import { realpathSync, writeFileSync } from "node:fs";
import { stringify } from "yaml";
import type { Config } from "./config.js";
import { resolveExecutable } from "./executables.js";
export function projectConfig(source: Config) {
  const providers = Object.fromEntries(
    Object.entries(source.providers).map(([id, p]) => {
      const env = { ...p.env };
      for (const key of p.envPaths)
        if (env[key])
          env[key] =
            resolveExecutable(env[key], source.root) ??
            path.resolve(
              source.root,
              env[key].startsWith("~/")
                ? path.join(homedir(), env[key].slice(2))
                : env[key],
            );
      return [
        id,
        {
          ...p,
          command:
            resolveExecutable(p.command, source.root) ??
            (p.command.includes("/")
              ? path.resolve(source.root, p.command)
              : p.command),
          args: p.args.map((x) =>
            /^(\.\/|scripts\/)/.test(x) ? path.resolve(source.root, x) : x,
          ),
          env,
        },
      ];
    }),
  );
  return {
    version: source.version,
    runtime: { ...source.runtime, stateDir: ".agent-bridge" },
    providers,
    agents: source.agents,
  };
}
export function initializeProject(source: Config, workspace: string) {
  const dir = realpathSync(workspace);
  const file = path.join(dir, "agents.bridge.yaml");
  // Never overwrite an existing project config, including through a symlink.
  writeFileSync(file, stringify(projectConfig(source)), {
    flag: "wx",
    mode: 0o600,
  });
  return file;
}
