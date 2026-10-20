// Saved definitions are data. They cannot install tools, change permissions or execute hooks.
import {
  mkdirSync,
  writeFileSync,
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Config } from "./config.js";
export const templateId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
export const templateRef = z
  .string()
  .regex(/^(?:(?:project|global):)?[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(72);
export const templateDefinition = z
  .object({
    format: z.literal(1),
    id: templateId,
    name: z.string().min(1).max(80),
    version: z
      .string()
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/)
      .max(40),
    description: z.string().min(1).max(400),
    instructions: z.string().trim().min(1).max(12000),
    delivery: z.enum(["task-instructions", "system-append"]),
    providers: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
    requiresReadOnly: z.boolean().default(false),
    acceptanceCriteria: z.array(z.string().min(1).max(500)).max(20).default([]),
  })
  .strict();
export const templateSnapshot = templateDefinition
  .extend({
    scope: z.enum(["project", "global"]),
    source: z.string().min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type TemplateSnapshot = z.infer<typeof templateSnapshot>;
export function templateRoots(
  root: string,
  globalRoot = path.join(homedir(), ".agent-bridge", "agents"),
) {
  return {
    project: path.join(root, ".agent-bridge", "agents"),
    global: globalRoot,
  };
}
type Roots = ReturnType<typeof templateRoots>;
function checkDirectories(directory: string) {
  // Reject symlinked ancestor paths too; a bundle must live in its declared scope.
  let current = path.parse(path.resolve(directory)).root;
  for (const part of path
    .resolve(directory)
    .slice(current.length)
    .split(path.sep)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Unsafe agent definition directory");
  }
}
export function resolveTemplate(
  roots: Roots,
  reference: string,
): TemplateSnapshot {
  templateRef.parse(reference);
  const [scopeHint, requestedId] = reference.includes(":")
    ? reference.split(":")
    : [undefined, reference];
  const scopes = scopeHint
    ? [scopeHint as "project" | "global"]
    : (["project", "global"] as const);
  for (const scope of scopes) {
    const directory = path.join(roots[scope], requestedId);
    // lstat observes dangling links; a broken project override must not fall through to global.
    try {
      lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    checkDirectories(directory);
    const source = path.join(directory, "agent.yaml");
    const fd = openSync(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let text: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32000)
        throw Error(
          "Agent definition must be a regular file up to 32000 bytes",
        );
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    const definition = templateDefinition.parse(
      parse(text, { maxAliasCount: 20 }),
    );
    if (definition.id !== requestedId)
      throw Error("Agent definition id must match its directory");
    return {
      ...definition,
      scope,
      source,
      digest: createHash("sha256")
        .update(JSON.stringify(definition))
        .digest("hex"),
    };
  }
  throw Error(`Agent definition not found: ${reference}`);
}
export function templateMetadata(t: TemplateSnapshot) {
  const { instructions, acceptanceCriteria, ...metadata } = t;
  return { ...metadata, acceptanceCriteriaCount: acceptanceCriteria.length };
}
export function listTemplates(roots: Roots) {
  const definitions = [];
  for (const scope of ["project", "global"] as const) {
    if (!existsSync(roots[scope])) continue;
    checkDirectories(roots[scope]);
    const entries = readdirSync(roots[scope]).sort();
    if (entries.length > 100)
      throw Error(`Too many ${scope} agent definitions (maximum 100)`);
    for (const id of entries) {
      if (!templateId.safeParse(id).success) continue;
      const reference = `${scope}:${id}`;
      try {
        definitions.push({
          reference,
          ...templateMetadata(resolveTemplate(roots, reference)),
        });
      } catch {
        definitions.push({
          reference,
          error: "Invalid agent definition; inspect this reference for details",
        });
      }
    }
  }
  return definitions;
}
export function validateTemplateBinding(
  t: TemplateSnapshot,
  config: Config,
  agentId: string,
) {
  const agent = config.agents[agentId];
  if (!agent) throw Error("Unknown agent");
  if (t.providers && !t.providers.includes(agent.provider))
    throw Error(`Agent definition does not support provider ${agent.provider}`);
  if (t.requiresReadOnly && !config.providers[agent.provider].readOnlyEnforced)
    throw Error(
      "Agent definition requires provider-enforced read-only tools; an instruction is insufficient",
    );
  return {
    delivery: t.delivery,
    instructionAuthority:
      t.delivery === "system-append"
        ? "experimental ACP system append; requires capability negotiation"
        : "user-task instructions; not a system prompt",
    toolPolicy: config.providers[agent.provider].readOnlyEnforced
      ? "provider-enforced read-only profile"
      : "native harness policy; no extra tool enforcement from this definition",
  };
}

// Creates a new definition only; updates are explicit file edits so existing data is never overwritten.
export function createTemplate(
  roots: Roots,
  scope: "project" | "global",
  raw: unknown,
) {
  const definition = templateDefinition.parse(raw);
  const directory = path.join(roots[scope], definition.id);
  // Check every existing ancestor before mkdir; a definition must not redirect global/project writes.
  let parent = path.dirname(directory);
  while (!existsSync(parent)) parent = path.dirname(parent);
  checkDirectories(parent);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkDirectories(directory);
  writeFileSync(path.join(directory, "agent.yaml"), stringify(definition), {
    flag: "wx",
    mode: 0o600,
  });
  return resolveTemplate(roots, `${scope}:${definition.id}`);
}
