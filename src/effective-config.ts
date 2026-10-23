import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { loadConfig, type Config } from "./config.js";
import { projectConfig } from "./project-config.js";
import {
  loadPreferences,
  preferencePath,
  savePreferences,
  type SessionConfigValue,
  type WorkspacePreferences,
} from "./preferences.js";
import { identifyWorkspace } from "./workspaces.js";
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
export const bundledConfigFile = path.join(pluginRoot, "agents.yaml");
export interface PluginConfigContext {
  file: string;
  config: Config;
  workspace: string;
  preferencesFile?: string;
  sources: {
    bundled: string;
    project?: string;
    explicitEnvironment?: string;
    legacyGenerated?: string;
  };
  migrationWarnings: string[];
  projectRequestedSessionConfig: Record<
    string,
    Record<string, SessionConfigValue>
  >;
}
type BaseConfig = Pick<
  Config,
  "version" | "runtime" | "providers" | "agents" | "specialistCatalogs"
>;
const PROVIDER_FIELDS = [
  "command",
  "args",
  "env",
  "envNames",
  "envPaths",
  "requires",
  "errorOutputPrefixes",
  "readOnlyEnforced",
] as const;
function serializable(c: Config): BaseConfig {
  return {
    version: c.version,
    runtime: { ...c.runtime, workspaceRoot: c.root },
    providers: c.providers,
    agents: c.agents,
    specialistCatalogs: c.specialistCatalogs,
  };
}
function providersDiffer(
  a: Config["providers"],
  b: Config["providers"],
): boolean {
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const pa = a[id] as Record<string, unknown> | undefined;
    const pb = b[id] as Record<string, unknown> | undefined;
    if (!pa || !pb) return true;
    for (const field of PROVIDER_FIELDS)
      if (JSON.stringify(pa[field]) !== JSON.stringify(pb[field])) return true;
  }
  return false;
}
function runtimeLimits(
  runtime: Partial<BaseConfig["runtime"]>,
): NonNullable<WorkspacePreferences["runtime"]> {
  const picked: NonNullable<WorkspacePreferences["runtime"]> = {};
  for (const key of [
    "maxConcurrentTasks",
    "maxRuntimeMs",
    "maxInlineChars",
    "maxArtifactBytes",
  ] as const) {
    const value = runtime[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}
function fsyncDirectory(directory: string) {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function writeAtomicPrivate(file: string, body: string) {
  if (existsSync(file) && lstatSync(file).isSymbolicLink())
    throw Error(`Refusing to write through symlinked file: ${file}`);
  const current = existsSync(file) ? readFileBody(file) : undefined;
  if (current === body) return;
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    fsyncDirectory(path.dirname(file));
  } catch (e) {
    try {
      rmSync(temp, { force: true });
    } catch {}
    throw e;
  }
}
function readFileBody(file: string) {
  return existsSync(file) && !lstatSync(file).isSymbolicLink()
    ? readFileSync(file, "utf8")
    : undefined;
}
const workspaceRoots = new Map<string, string>();
function resolveWorkspaceRoot(cwd: string): string {
  const canonical = realpathSync(cwd);
  const identity = identifyWorkspace(canonical);
  const key = `${identity.canonicalPath}${identity.device}${identity.inode}`;
  const cached = workspaceRoots.get(key);
  if (cached !== undefined) return cached;
  let workspace = canonical;
  try {
    workspace = execFileSync(
      "git",
      ["-C", workspace, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: "pipe" },
    ).trim();
  } catch {}
  workspaceRoots.set(key, workspace);
  if (workspaceRoots.size > 512)
    workspaceRoots.delete(workspaceRoots.keys().next().value!);
  return workspace;
}
export interface CompileOptions {
  bundledFile?: string;
}
export function compilePluginConfig(
  cwd = process.cwd(),
  options: CompileOptions = {},
): PluginConfigContext {
  const bundled = options.bundledFile ?? bundledConfigFile;
  if (process.env.AGENT_BRIDGE_CONFIG) {
    const file = path.resolve(cwd, process.env.AGENT_BRIDGE_CONFIG);
    const config = loadConfig(file);
    return {
      file,
      config,
      workspace: config.root,
      sources: { bundled, explicitEnvironment: file },
      migrationWarnings: [],
      projectRequestedSessionConfig: {},
    };
  }
  const workspace = resolveWorkspaceRoot(cwd);
  const dir = path.join(workspace, ".agent-bridge");
  const legacyFile = path.join(dir, "plugin-agents.yaml");
  const effectiveFile = path.join(dir, "effective-agents.yaml");
  const explicit = path.join(workspace, "agents.bridge.yaml");
  const sources: PluginConfigContext["sources"] = {
    bundled,
  };
  const migrationWarnings: string[] = [];
  const projectRequestedSessionConfig: PluginConfigContext["projectRequestedSessionConfig"] =
    {};
  const managed = (): BaseConfig => {
    const prepared = projectConfig(loadConfig(bundled));
    prepared.runtime = { ...prepared.runtime, workspaceRoot: workspace };
    return prepared;
  };
  let prefs = loadPreferences(workspace);
  let base: BaseConfig;
  if (!prefs?.useManagedDefaults && existsSync(explicit)) {
    const project = serializable(loadConfig(explicit));
    for (const [id, a] of Object.entries(project.agents))
      if (Object.keys(a.sessionConfig).length)
        projectRequestedSessionConfig[id] = { ...a.sessionConfig };
    sources.project = explicit;
    base = project;
  } else if (!prefs?.useManagedDefaults && existsSync(legacyFile)) {
    const prepared = managed();
    let legacy: Config | undefined;
    try {
      legacy = loadConfig(legacyFile);
    } catch (e) {
      migrationWarnings.push(
        `Legacy generated config ${legacyFile} could not be loaded (${e instanceof Error ? e.message : String(e)}); managed defaults are used and the file is left untouched`.slice(
          0,
          500,
        ),
      );
    }
    const differs =
      legacy !== undefined &&
      providersDiffer(legacy.providers, prepared.providers);
    if (!prefs && legacy) {
      const imported: WorkspacePreferences = {
        version: 1,
        workspaceIdentity: identifyWorkspace(workspace),
        useManagedDefaults: !differs,
        agents: Object.fromEntries(
          Object.entries(legacy.agents)
            .filter(([, a]) => Object.keys(a.sessionConfig).length > 0)
            .map(([id, a]) => [id, { sessionConfig: { ...a.sessionConfig } }]),
        ),
        runtime: runtimeLimits(legacy.runtime),
        legacy: { importedFrom: legacyFile, warnings: [] },
      };
      try {
        savePreferences(workspace, imported);
        prefs = imported;
      } catch (e) {
        migrationWarnings.push(
          `Could not import legacy settings into user preferences: ${e instanceof Error ? e.message : String(e)}`.slice(
            0,
            500,
          ),
        );
      }
    }
    if (differs && legacy) {
      base = serializable(legacy);
      sources.legacyGenerated = legacyFile;
      migrationWarnings.push(
        `Legacy generated config ${legacyFile} has provider command/args/environment or enforcement fields that differ from current bundled defaults; it remains the active base so those customizations are not lost. Choose managed plugin defaults to switch.`.slice(
          0,
          500,
        ),
      );
    } else base = prepared;
  } else {
    base = managed();
  }
  const effective = {
    version: 1 as const,
    runtime: {
      ...base.runtime,
      ...(prefs?.runtime ? runtimeLimits(prefs.runtime) : {}),
    },
    providers: base.providers,
    agents: Object.fromEntries(
      Object.entries(base.agents).map(([id, a]) => [
        id,
        {
          ...a,
          sessionConfig: { ...(prefs?.agents[id]?.sessionConfig ?? {}) },
        },
      ]),
    ),
    specialistCatalogs: base.specialistCatalogs,
  };
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink())
      throw Error(`Refusing to write effective config: ${dir} is a symlink`);
    if (!stat.isDirectory())
      throw Error(
        `Refusing to write effective config: ${dir} is not a real directory`,
      );
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomicPrivate(effectiveFile, stringify(effective));
  const preferencesFile = preferencePath(workspace);
  return {
    file: effectiveFile,
    config: loadConfig(effectiveFile),
    workspace,
    preferencesFile: existsSync(preferencesFile) ? preferencesFile : undefined,
    sources,
    migrationWarnings,
    projectRequestedSessionConfig,
  };
}
