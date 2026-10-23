import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  readFileSync,
} from "node:fs";
import { z } from "zod";
import type { Config } from "./config.js";
import { remote } from "./server.js";
import { buildId } from "./build-id.js";
import { identifyWorkspace } from "./workspaces.js";
import {
  loadPreferences,
  preferencePath,
  savePreferences,
  type SessionConfigValue,
  type WorkspacePreferences,
} from "./preferences.js";
import { validateSessionSetting } from "./session-settings.js";
import {
  probeAgentSettings,
  probeAllAgentSettings,
  sanitizeSettingsError,
  type AgentSettingsProbe,
} from "./worker-settings.js";
import {
  compilePluginConfig,
  type PluginConfigContext,
} from "./effective-config.js";
export function pluginConfig(cwd = process.cwd()): PluginConfigContext {
  return compilePluginConfig(cwd);
}
export type RuntimeReadiness =
  | { status: "ready"; restarted: boolean }
  | {
      status: "update_pending";
      activeTaskIds: string[];
      liveBuildId?: string;
      desiredBuildId: string;
      liveConfigDigest?: string;
      desiredConfigDigest: string;
    };
async function launch(file: string, config: Config) {
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
async function waitForStop(config: Config) {
  const lock = path.join(config.stateDir, "lock");
  const deadline = Date.now() + 8000;
  while (
    Date.now() < deadline &&
    (existsSync(config.socket) || existsSync(lock))
  )
    await new Promise((r) => setTimeout(r, 50));
  if (existsSync(config.socket) || existsSync(lock))
    throw Error(
      `Agent Bridge runtime did not stop at ${config.socket}; inspect ${lock} manually`,
    );
}
async function liveDaemon(config: Config) {
  let list;
  try {
    list = await remote(config, "list");
  } catch (e) {
    if (
      ["ENOENT", "ECONNREFUSED"].includes(
        (e as NodeJS.ErrnoException).code ?? "",
      )
    )
      return undefined;
    throw e;
  }
  const doctor = await remote(config, "doctor").catch(() => undefined);
  return { list, doctor };
}
export async function ensureRuntime(
  file: string,
  config: Config,
): Promise<RuntimeReadiness> {
  const live = await liveDaemon(config);
  if (!live) {
    await launch(file, config);
    return { status: "ready", restarted: false };
  }
  const daemon = live.doctor?.daemon as
    | { buildId?: string; configDigest?: string }
    | undefined;
  const stale =
    daemon?.buildId !== buildId || daemon?.configDigest !== config.configDigest;
  if (!stale) return { status: "ready", restarted: false };
  const activeTaskIds = [
    ...new Set(
      (daemon as { activeTaskIds?: string[] } | undefined)?.activeTaskIds ??
        (live.list as { activeTasks?: { taskId: string }[] }[]).flatMap((a) =>
          (a.activeTasks ?? []).map((t) => t.taskId),
        ),
    ),
  ];
  if (activeTaskIds.length)
    return {
      status: "update_pending",
      activeTaskIds,
      liveBuildId: daemon?.buildId,
      desiredBuildId: buildId,
      liveConfigDigest: daemon?.configDigest,
      desiredConfigDigest: config.configDigest,
    };
  await remote(config, "shutdown").catch(() => {});
  await waitForStop(config);
  await launch(file, config);
  return { status: "ready", restarted: true };
}
const SUPERVISION = new Set([
  "list",
  "status",
  "wait",
  "result",
  "artifact",
  "events",
  "reply",
  "cancel",
  "doctor",
]);
function guardPending(readiness: RuntimeReadiness, method?: string) {
  if (
    readiness.status === "update_pending" &&
    method !== undefined &&
    !SUPERVISION.has(method)
  )
    throw Error(
      `Agent Bridge daemon update is pending: ${readiness.activeTaskIds.length} nonterminal task(s) keep the previous runtime alive (${readiness.activeTaskIds.join(", ")}). "${method}" is refused until they finish; status/wait/result/artifact/events/reply/cancel/doctor remain available.`,
    );
}
export async function ensurePluginRuntime(
  cwd = process.cwd(),
  method?: string,
): Promise<RuntimeReadiness> {
  const { file, config } = pluginConfig(cwd);
  const readiness = await ensureRuntime(file, config);
  guardPending(readiness, method);
  return readiness;
}
export async function currentPluginConfig(
  cwd = process.cwd(),
  method?: string,
): Promise<Config> {
  const { file, config } = pluginConfig(cwd);
  const readiness = await ensureRuntime(file, config);
  guardPending(readiness, method);
  return config;
}
export async function bootstrap(cwd = process.cwd()) {
  const context = pluginConfig(cwd);
  const readiness = await ensureRuntime(context.file, context.config);
  return {
    ...context,
    socket: context.config.socket,
    readiness,
  };
}
export type PluginReadiness =
  | RuntimeReadiness
  | { status: "error"; error: string };
const settingsInput = z
  .object({
    agentId: z.string().min(1).max(64).optional(),
  })
  .strict();
const explicitEnvironmentRefused = (context: PluginConfigContext) => {
  if (context.sources.explicitEnvironment)
    throw Error(
      `Agent Bridge settings cannot change ${context.sources.explicitEnvironment}: it is an explicit operator-managed config (AGENT_BRIDGE_CONFIG). Edit that file directly; workspace preferences are ignored for it.`,
    );
};
export async function pluginSettings(
  cwd = process.cwd(),
  raw: unknown = {},
): Promise<{
  workspace: string;
  preferencesFile: string;
  sources: PluginConfigContext["sources"];
  migrationWarnings: string[];
  projectRequestedSessionConfig: PluginConfigContext["projectRequestedSessionConfig"];
  readiness: PluginReadiness;
  agents: AgentSettingsProbe[];
}> {
  const input = settingsInput.parse(raw);
  const context = pluginConfig(cwd);
  if (input.agentId && !context.config.agents[input.agentId])
    throw Error(
      `Unknown agent "${input.agentId}" (configured: ${
        Object.keys(context.config.agents).join(", ") || "none"
      })`,
    );
  const readiness: PluginReadiness = await ensureRuntime(
    context.file,
    context.config,
  ).catch((e) => ({
    status: "error" as const,
    error: sanitizeSettingsError(context.config, e),
  }));
  const agents = input.agentId
    ? [await probeAgentSettings(context.config, input.agentId)]
    : await probeAllAgentSettings(context.config);
  return {
    workspace: context.workspace,
    preferencesFile: preferencePath(context.workspace),
    sources: context.sources,
    migrationWarnings: context.migrationWarnings,
    projectRequestedSessionConfig: context.projectRequestedSessionConfig,
    readiness,
    agents,
  };
}
const configureInput = z.union([
  z
    .object({
      agentId: z.string().min(1).max(64),
      configId: z.string().min(1).max(100),
      value: z.union([z.string().min(1).max(200), z.boolean()]),
    })
    .strict(),
  z
    .object({
      agentId: z.string().min(1).max(64),
      configId: z.string().min(1).max(100),
      clear: z.literal(true),
    })
    .strict(),
]);
export async function pluginConfigure(
  cwd: string | undefined,
  raw: unknown,
): Promise<{
  saved: true;
  readiness: RuntimeReadiness;
  preferencesFile: string;
  agentId: string;
  sessionConfig: Record<string, SessionConfigValue>;
}> {
  const input = configureInput.parse(raw);
  const context = pluginConfig(cwd);
  explicitEnvironmentRefused(context);
  if (!context.config.agents[input.agentId])
    throw Error(
      `Unknown agent "${input.agentId}" (configured: ${
        Object.keys(context.config.agents).join(", ") || "none"
      })`,
    );
  const workspace = context.workspace;
  const existing = loadPreferences(workspace);
  const agents = Object.fromEntries(
    Object.entries(existing?.agents ?? {}).map(([id, a]) => [
      id,
      { sessionConfig: { ...a.sessionConfig } },
    ]),
  );
  if ("clear" in input) {
    const entry = agents[input.agentId];
    if (entry) {
      delete entry.sessionConfig[input.configId];
      if (!Object.keys(entry.sessionConfig).length)
        delete agents[input.agentId];
    }
  } else {
    const probe = await probeAgentSettings(context.config, input.agentId);
    if (!probe.available)
      throw Error(
        `Cannot configure "${input.agentId}": provider is unavailable (${probe.error ?? "no executable"})`,
      );
    if (probe.error)
      throw Error(
        `Cannot configure "${input.agentId}": provider probe failed (${probe.error})`,
      );
    validateSessionSetting(probe.options, input.configId, input.value);
    agents[input.agentId] = {
      sessionConfig: {
        ...(agents[input.agentId]?.sessionConfig ?? {}),
        [input.configId]: input.value,
      },
    };
  }
  const prefs: WorkspacePreferences = {
    version: 1,
    workspaceIdentity:
      existing?.workspaceIdentity ?? identifyWorkspace(workspace),
    useManagedDefaults:
      existing?.useManagedDefaults ??
      !(context.sources.project || context.sources.legacyGenerated),
    agents,
    ...(existing?.runtime ? { runtime: existing.runtime } : {}),
    ...(existing?.legacy ? { legacy: existing.legacy } : {}),
  };
  savePreferences(workspace, prefs);
  const recompiled = pluginConfig(cwd);
  const readiness = await ensureRuntime(recompiled.file, recompiled.config);
  return {
    saved: true,
    readiness,
    preferencesFile: preferencePath(workspace),
    agentId: input.agentId,
    sessionConfig: agents[input.agentId]?.sessionConfig ?? {},
  };
}
export async function pluginMigrateManaged(cwd = process.cwd()): Promise<{
  saved: true;
  readiness: RuntimeReadiness;
  preferencesFile: string;
  useManagedDefaults: true;
}> {
  const context = pluginConfig(cwd);
  explicitEnvironmentRefused(context);
  const workspace = context.workspace;
  const existing = loadPreferences(workspace);
  const prefs: WorkspacePreferences = {
    version: 1,
    workspaceIdentity:
      existing?.workspaceIdentity ?? identifyWorkspace(workspace),
    useManagedDefaults: true,
    agents: existing?.agents ?? {},
    ...(existing?.runtime ? { runtime: existing.runtime } : {}),
    ...(existing?.legacy ? { legacy: existing.legacy } : {}),
  };
  savePreferences(workspace, prefs);
  const recompiled = pluginConfig(cwd);
  const readiness = await ensureRuntime(recompiled.file, recompiled.config);
  return {
    saved: true,
    readiness,
    preferencesFile: preferencePath(workspace),
    useManagedDefaults: true,
  };
}
export async function pluginDoctor(cwd = process.cwd()) {
  const context = pluginConfig(cwd);
  const { config } = context;
  const provenance = {
    sources: context.sources,
    preferencesFile: context.preferencesFile,
    migrationWarnings: context.migrationWarnings,
    projectRequestedSessionConfig: context.projectRequestedSessionConfig,
    desired: { buildId, configDigest: config.configDigest },
  };
  try {
    return {
      ...(await remote(config, "doctor")),
      ...provenance,
      reachable: true,
    };
  } catch {}
  try {
    await remote(config, "list");
    return {
      configFile: config.sourceFile,
      workspace: config.root,
      stateDir: config.stateDir,
      socket: config.socket,
      daemon: {
        running: true,
        diagnostics:
          "Runtime is reachable but does not expose doctor; restart to load the current bridge version",
      },
      ...provenance,
      reachable: true,
    };
  } catch {}
  return {
    configFile: config.sourceFile,
    workspace: config.root,
    stateDir: config.stateDir,
    socket: config.socket,
    daemon: { running: false },
    ...provenance,
    reachable: false,
  };
}
export async function pluginRestart(cwd = process.cwd()) {
  const { file, config } = pluginConfig(cwd);
  let list;
  try {
    list = await remote(config, "list");
  } catch {
    throw Error(
      `Agent Bridge runtime is not reachable at ${config.socket}; nothing to restart. Start it with a worker delegation or plugin-bootstrap.`,
    );
  }
  const doctor = await remote(config, "doctor").catch(() => undefined);
  const doctorTaskIds = (
    (doctor as { daemon?: { activeTaskIds?: string[] } } | undefined)?.daemon
      ?.activeTaskIds ?? []
  ).map((taskId) => ({ taskId }));
  const active = doctorTaskIds.length
    ? doctorTaskIds
    : (list as { activeTasks?: { taskId: string }[] }[]).flatMap(
        (a) => a.activeTasks ?? [],
      );
  if (active.length)
    throw Error(
      `Refusing to restart: ${active.length} nonterminal task(s) still active (${active
        .map((t) => t.taskId)
        .join(
          ", ",
        )}). Cancel or finish them first; plugin-restart never cancels work.`,
    );
  await remote(config, "shutdown").catch(() => {});
  await waitForStop(config);
  await launch(file, config);
  return { ...(await remote(config, "doctor")), reachable: true };
}
