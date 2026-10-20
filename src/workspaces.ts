import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const workspaceInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("project") }).strict(),
  z
    .object({ mode: z.literal("directory"), path: z.string().min(1).max(4096) })
    .strict(),
  z.object({ mode: z.literal("temporary") }).strict(),
  z.object({ mode: z.literal("isolated-worktree") }).strict(),
]);
export type Workspace = z.infer<typeof workspaceInput>;
export interface WorkspaceIdentity {
  canonicalPath: string;
  device: string;
  inode: string;
}

export function identifyWorkspace(directory: string): WorkspaceIdentity {
  const canonicalPath = realpathSync(directory);
  const stat = statSync(canonicalPath, { bigint: true });
  if (!stat.isDirectory())
    throw Error("Conversation workspace is not a directory");
  return { canonicalPath, device: String(stat.dev), inode: String(stat.ino) };
}

export function verifyWorkspace(
  directory: string,
  expected?: WorkspaceIdentity,
): WorkspaceIdentity {
  let actual: WorkspaceIdentity;
  try {
    actual = identifyWorkspace(directory);
  } catch {
    throw Error("Conversation workspace missing or no longer a directory");
  }
  if (
    actual.canonicalPath !==
      (expected?.canonicalPath ?? path.resolve(directory)) ||
    (expected &&
      (actual.device !== expected.device || actual.inode !== expected.inode))
  )
    throw Error(
      "Conversation workspace identity changed; refusing to use a replacement directory",
    );
  return actual;
}

export function resolveWorkspace(value: Workspace, root: string): Workspace {
  if (value.mode !== "directory") return value;
  const directory = realpathSync(path.resolve(root, value.path));
  if (!statSync(directory).isDirectory())
    throw Error("Workspace path must be an existing directory");
  // Canonical aliases of the project share its conversation.
  return directory === root
    ? { mode: "project" }
    : { mode: "directory", path: directory };
}
