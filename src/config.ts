import { readFileSync, realpathSync, mkdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const provider = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    envNames: z.array(z.string()).default([]),
    envPaths: z.array(z.string()).default([]),
    requires: z.array(z.string().min(1)).default([]),
    errorOutputPrefixes: z
      .array(z.string().min(1).max(200))
      .max(10)
      .default([]),
    readOnlyEnforced: z.boolean().default(false),
  })
  .strict();
export const schema = z
  .object({
    version: z.literal(1),
    runtime: z
      .object({
        stateDir: z.string().default(".agent-bridge"),
        workspaceRoot: z.string().optional(),
        maxConcurrentTasks: z.number().int().min(1).max(16).default(2),
        taskBudgets: z
          .record(
            id,
            z
              .object({ maxTasks: z.number().int().min(1).max(1000000) })
              .strict(),
          )
          .optional(),
        maxRuntimeMs: z.number().int().min(100).max(86400000).default(7200000),
        maxInlineChars: z.number().int().min(100).max(6000).default(2000),
        maxArtifactBytes: z
          .number()
          .int()
          .min(1024)
          .max(100000000)
          .default(10000000),
      })
      .strict()
      .default({}),
    providers: z.record(id, provider),
    agents: z.record(
      id,
      z
        .object({
          provider: id,
          description: z.string().max(400),
          workspace: z
            .enum(["read-only", "project", "isolated-worktree"])
            .default("project"),
          sessionConfig: z
            .record(
              z.string().min(1).max(100),
              z.union([z.string().min(1).max(200), z.boolean()]),
            )
            .refine((o) => Object.keys(o).length <= 20)
            .default({}),
          isolation: z.enum(["none", "seatbelt"]).default("none"),
          providerSandbox: z.enum(["none", "native"]).optional(),
          internal: z.boolean().default(false),
          maxConcurrent: z.number().int().min(1).max(16).optional(),
        })
        .strict(),
    ),
    specialistCatalogs: z
      .record(id, z.object({ path: z.string().min(1) }).strict())
      .default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const name of Object.keys(c.specialistCatalogs))
      if (name === "project" || name === "global" || name === "inline")
        ctx.addIssue({
          code: "custom",
          message: `${name} is a reserved specialist catalog name`,
        });
    for (const [name, a] of Object.entries(c.agents)) {
      const p = c.providers[a.provider];
      if (a.isolation === "seatbelt") {
        if (process.platform !== "darwin")
          ctx.addIssue({
            code: "custom",
            message: `${name}: seatbelt requires macOS`,
          });
        if (a.providerSandbox !== "none")
          ctx.addIssue({
            code: "custom",
            message: `${name}: seatbelt cannot nest; explicitly set providerSandbox: none and disable the provider sandbox`,
          });
        // The pinned Codex ACP adapter defaults to a native sandboxed mode.
        if (
          p &&
          /codex(?:-acp)?(?:\.exe)?$/.test(p.command) &&
          a.sessionConfig.mode !== "agent-full-access"
        )
          ctx.addIssue({
            code: "custom",
            message: `${name}: seatbelt with Codex requires sessionConfig.mode: agent-full-access (no nested sandbox)`,
          });
        if (a.workspace === "isolated-worktree")
          ctx.addIssue({
            code: "custom",
            message: `${name}: seatbelt cannot access worktrees inside stateDir; use workspace: project`,
          });
      }

      if (!p)
        ctx.addIssue({
          code: "custom",
          message: `Unknown provider for ${name}`,
        });
      else if (a.workspace === "read-only" && !p.readOnlyEnforced)
        ctx.addIssue({
          code: "custom",
          message: `${name}: read-only needs provider-side enforcement; ACP is not a sandbox`,
        });
    }
  });
export type Config = z.infer<typeof schema> & {
  root: string;
  stateDir: string;
  socket: string;
  sourceFile: string;
  configDigest: string;
};
export function agentConcurrency(config: Config, agentId: string) {
  const requestedMaxConcurrent =
    config.agents[agentId]?.maxConcurrent ?? config.runtime.maxConcurrentTasks;
  const effectiveMaxConcurrent = Math.min(
    requestedMaxConcurrent,
    config.runtime.maxConcurrentTasks,
  );
  return {
    requestedMaxConcurrent,
    effectiveMaxConcurrent,
    clamped: effectiveMaxConcurrent < requestedMaxConcurrent,
  };
}
export function loadConfig(file = "agents.yaml"): Config {
  const sourceFile = realpathSync(path.resolve(file));
  const base = path.dirname(sourceFile);
  const c = schema.parse(parse(readFileSync(file, "utf8")));
  const specialistCatalogs = Object.fromEntries(
    Object.entries(c.specialistCatalogs).map(([catalog, entry]) => [
      catalog,
      {
        path: path.resolve(
          base,
          entry.path.startsWith("~/")
            ? path.join(homedir(), entry.path.slice(2))
            : entry.path,
        ),
      },
    ]),
  );
  const root = realpathSync(path.resolve(base, c.runtime.workspaceRoot ?? "."));
  const stateDir = path.resolve(root, c.runtime.stateDir);
  let socket = path.join(stateDir, "runtime.sock");
  // macOS sockaddr_un is short. Keep state in the project but relocate only long sockets.
  if (Buffer.byteLength(socket) >= 100) {
    const uid = process.getuid?.() ?? 0;
    const directory = path.join("/tmp", `agent-bridge-${uid}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      (stat.mode & 0o077) !== 0
    )
      throw Error("Unsafe shared socket directory: " + directory);
    socket = path.join(
      directory,
      createHash("sha256").update(stateDir).digest("hex").slice(0, 24) +
        ".sock",
    );
  }
  const configDigest = createHash("sha256")
    .update(
      JSON.stringify({ ...c, specialistCatalogs, root, stateDir, socket }),
    )
    .digest("hex");
  return {
    ...c,
    specialistCatalogs,
    root,
    stateDir,
    socket,
    sourceFile,
    configDigest,
  };
}
