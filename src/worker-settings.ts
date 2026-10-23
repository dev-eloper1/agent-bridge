import type { Config } from "./config.js";
import { resolveExecutable } from "./executables.js";
import { Worker } from "./acp.js";
import {
  normalizeSessionSettings,
  type SessionSettingOption,
} from "./session-settings.js";
import type { SessionConfigValue } from "./preferences.js";
export interface AgentSettingsProbe {
  agentId: string;
  provider: string;
  description: string;
  available: boolean;
  readOnlyEnforced: boolean;
  requested: Record<string, SessionConfigValue>;
  options: SessionSettingOption[];
  error?: string;
}
export function sanitizeSettingsError(config: Config, e: unknown): string {
  let s = e instanceof Error ? e.message : String(e);
  for (const p of Object.values(config.providers)) {
    for (const name of p.envNames) {
      const v = process.env[name];
      if (v && v.length >= 6) s = s.split(v).join("[REDACTED]");
    }
    for (const v of Object.values(p.env))
      if (v.length >= 6) s = s.split(v).join("[REDACTED]");
  }
  return s
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .slice(0, 500);
}
export interface ProbeOptions {
  timeoutMs?: number;
}
function probeTimeout(options?: ProbeOptions): number {
  const value = options?.timeoutMs ?? 20000;
  return Math.min(Math.max(value, 100), 120000);
}
export async function probeAgentSettings(
  config: Config,
  agentId: string,
  options?: ProbeOptions,
): Promise<AgentSettingsProbe> {
  const agent = config.agents[agentId];
  if (!agent)
    throw Error(
      `Unknown agent "${agentId}" (configured: ${
        Object.keys(config.agents).join(", ") || "none"
      })`,
    );
  const provider = config.providers[agent.provider];
  const probe: AgentSettingsProbe = {
    agentId,
    provider: agent.provider,
    description: agent.description,
    available: false,
    readOnlyEnforced: provider.readOnlyEnforced,
    requested: { ...agent.sessionConfig },
    options: [],
  };
  const executable = resolveExecutable(provider.command, config.root);
  const missing = provider.requires.filter(
    (x) => !resolveExecutable(x, config.root),
  );
  if (!executable || missing.length) {
    probe.error = missing.length
      ? `Missing provider dependencies: ${missing.join(", ")}`
      : `Provider executable unavailable: ${provider.command}`;
    return probe;
  }
  probe.available = true;
  let worker: Worker | undefined;
  try {
    worker = new Worker(config, agent.provider, config.root, {
      update: () => {},
      question: async (kind) =>
        kind === "input"
          ? { action: "decline" }
          : { outcome: { outcome: "cancelled" } },
      exit: () => {},
      log: () => {},
    });
    const timeout = probeTimeout(options);
    const request = (async () => {
      await worker.initialize();
      return worker.session(config.root);
    })();
    request.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      request.then((response) => ({ response })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeout);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if ("timedOut" in result) {
      probe.error = `Provider settings probe timed out after ${timeout}ms`;
      return probe;
    }
    const response = result.response;
    probe.options = normalizeSessionSettings({
      configOptions: (response as Record<string, unknown>).configOptions,
      modes: (response as Record<string, unknown>).modes,
    });
  } catch (e) {
    probe.error = sanitizeSettingsError(config, e);
  } finally {
    worker?.kill();
  }
  return probe;
}
export async function probeAllAgentSettings(
  config: Config,
  options?: ProbeOptions,
): Promise<AgentSettingsProbe[]> {
  const results: AgentSettingsProbe[] = [];
  const ids = Object.entries(config.agents)
    .filter(([, agent]) => !agent.internal)
    .map(([id]) => id);
  for (let i = 0; i < ids.length; i += 2)
    results.push(
      ...(await Promise.all(
        ids
          .slice(i, i + 2)
          .map((id) => probeAgentSettings(config, id, options)),
      )),
    );
  return results;
}
