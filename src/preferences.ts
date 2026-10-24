import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { identifyWorkspace } from "./workspaces.js";
export type SessionConfigValue = string | boolean;
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const sessionConfig = z
  .record(key, z.union([z.string().min(1).max(200), z.boolean()]))
  .refine((o) => Object.keys(o).length <= 20);
export const workspacePreferences = z
  .object({
    version: z.literal(1),
    workspaceIdentity: z
      .object({
        canonicalPath: z.string().min(1).max(4096),
        device: z.string().min(1).max(64),
        inode: z.string().min(1).max(64),
      })
      .strict(),
    useManagedDefaults: z.boolean().default(false),
    agents: z
      .record(
        key,
        z
          .object({
            sessionConfig: sessionConfig.default({}),
            maxConcurrent: z.number().int().min(1).max(16).optional(),
          })
          .strict(),
      )
      .refine((o) => Object.keys(o).length <= 200)
      .default({}),
    runtime: z
      .object({
        maxConcurrentTasks: z.number().int().min(1).max(16).optional(),
        maxRuntimeMs: z.number().int().min(100).max(86400000).optional(),
        maxInlineChars: z.number().int().min(100).max(6000).optional(),
        maxArtifactBytes: z.number().int().min(1024).max(100000000).optional(),
      })
      .strict()
      .optional(),
    legacy: z
      .object({
        importedFrom: z.string().min(1).max(4096),
        warnings: z.array(z.string().max(1000)).max(20),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorkspacePreferences = z.infer<typeof workspacePreferences>;
const MAX_BYTES = 65536;
const configHome = () =>
  process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
const root = () => path.join(configHome(), "agent-bridge", "workspaces");
export function preferencePath(workspace: string): string {
  const id = identifyWorkspace(workspace);
  const hash = createHash("sha256")
    .update(`${id.canonicalPath}${id.device}${id.inode}`)
    .digest("hex");
  return path.join(root(), `${hash}.yaml`);
}
function checkPrivate(stat: { uid?: number; mode: number }, target: string) {
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== undefined && stat.uid !== uid)
    throw Error(
      `Unsafe workspace preferences path: ${target} is owned by another user`,
    );
  if ((stat.mode & 0o077) !== 0)
    throw Error(
      `Unsafe workspace preferences path: ${target} grants group/other access`,
    );
}
function checkConfigHome() {
  const home = configHome();
  if (existsSync(home) && lstatSync(home).isSymbolicLink())
    throw Error(`Unsafe workspace preferences path: ${home} is a symlink`);
}
function checkAncestors(file: string) {
  const home = configHome();
  checkConfigHome();
  for (
    let current = path.dirname(file);
    current !== home;
    current = path.dirname(current)
  ) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink())
      throw Error(`Unsafe workspace preferences path: ${current} is a symlink`);
    if (!stat.isDirectory())
      throw Error(
        `Unsafe workspace preferences path: ${current} is not a real directory`,
      );
    checkPrivate(stat, current);
    if (current === path.dirname(current)) break;
  }
}
function checkPath(file: string) {
  checkAncestors(file);
  const stat = lstatSync(file);
  if (stat.isSymbolicLink())
    throw Error(`Unsafe workspace preferences: ${file} is a symlink`);
  if (!stat.isFile())
    throw Error(`Unsafe workspace preferences: ${file} must be a regular file`);
  checkPrivate(stat, file);
}
function sameIdentity(
  a: WorkspacePreferences["workspaceIdentity"],
  b: ReturnType<typeof identifyWorkspace>,
) {
  return (
    a.canonicalPath === b.canonicalPath &&
    a.device === b.device &&
    a.inode === b.inode
  );
}
export function loadPreferences(
  workspace: string,
): WorkspacePreferences | undefined {
  const file = preferencePath(workspace);
  if (!existsSync(file)) return undefined;
  checkPath(file);
  if (statSync(file).size > MAX_BYTES)
    throw Error(
      `Workspace preferences exceed ${MAX_BYTES} bytes: ${file}. Original file preserved.`,
    );
  let prefs: WorkspacePreferences;
  try {
    prefs = workspacePreferences.parse(parse(readFileSync(file, "utf8")));
  } catch (e) {
    throw Error(
      `Invalid workspace preferences at ${file}: ${e instanceof Error ? e.message : String(e)}. Original file preserved; restore a valid backup or inspect it before editing.`,
    );
  }
  if (!sameIdentity(prefs.workspaceIdentity, identifyWorkspace(workspace)))
    throw Error(
      `Workspace preferences at ${file} belong to a different directory identity; refusing to apply them here.`,
    );
  return prefs;
}
export function savePreferences(
  workspace: string,
  value: WorkspacePreferences,
): void {
  let prefs: WorkspacePreferences;
  try {
    prefs = workspacePreferences.parse(value);
  } catch (e) {
    throw Error(
      `Refusing to save invalid workspace preferences: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!sameIdentity(prefs.workspaceIdentity, identifyWorkspace(workspace)))
    throw Error(
      "Workspace identity does not match the preferences record; refusing to save",
    );
  const file = preferencePath(workspace);
  if (existsSync(file)) checkPath(file);
  checkConfigHome();
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  checkAncestors(file);
  const body = stringify(prefs);
  if (Buffer.byteLength(body) > MAX_BYTES)
    throw Error(`Workspace preferences exceed ${MAX_BYTES} bytes`);
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
    const dir = openSync(path.dirname(file), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (e) {
    try {
      rmSync(temp, { force: true });
    } catch {}
    throw e;
  }
}
