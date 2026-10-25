import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import type { Config } from "./config.js";
import {
  templateDefinition,
  templateId,
  checkDirectories,
  readDefinitionFile,
  validateDefinitionBinding,
} from "./templates.js";
export const specialistSpecDefinition = templateDefinition
  .extend({
    namespace: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
  })
  .strict();
export const specialistRef = z
  .string()
  .regex(
    /^(?:[a-zA-Z0-9_-]{1,64}:)?[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/,
  )
  .max(200);
export const specialistSnapshot = specialistSpecDefinition
  .extend({
    catalog: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    reference: z.string().min(1).max(200),
    source: z.string().min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SpecialistSnapshot = z.infer<typeof specialistSnapshot>;
// The plugin root is derived from this module's own location (dist/..), like
// bundledConfigFile; Node resolves symlinks for ESM URLs, so it is a real path.
export const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
export function catalogRoots(config: Config): Record<string, string> {
  return {
    project: path.join(config.root, ".specialists"),
    global: path.join(homedir(), ".specialists"),
    plugin: path.join(config.pluginRoot ?? pluginRoot, ".specialists"),
    ...Object.fromEntries(
      Object.entries(config.specialistCatalogs ?? {}).map(([name, c]) => [
        name,
        c.path,
      ]),
    ),
  };
}
// Catalog names in order, skipping any whose folder an earlier catalog already
// covers, e.g. project and plugin in the Agent Bridge checkout. Folders compare
// by device and inode, so letter case and symlinks don't matter; an unsafe
// catalog never claims a folder, so it cannot hide a usable alias of it.
function distinctCatalogs(roots: Record<string, string>): string[] {
  const catalogs = Object.keys(roots).map((catalog) => {
    let identity: string | undefined;
    let safe = true;
    try {
      const stat = statSync(roots[catalog]);
      identity = `${stat.dev}:${stat.ino}`;
      checkDirectories(roots[catalog]);
    } catch {
      safe = false;
    }
    return { catalog, identity, safe };
  });
  const usable = new Set(
    catalogs.filter((c) => c.safe && c.identity).map((c) => c.identity),
  );
  const seen = new Set<string>();
  return catalogs
    .filter(({ identity, safe }) => {
      if (!identity) return true;
      if (!safe) return !usable.has(identity);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .map((c) => c.catalog);
}
function specDigest(definition: z.infer<typeof specialistSpecDefinition>) {
  return createHash("sha256")
    .update(JSON.stringify(definition))
    .digest("hex");
}
function loadSpecialist(
  roots: Record<string, string>,
  catalog: string,
  namespace: string,
  id: string,
): SpecialistSnapshot | undefined {
  const directory = path.join(roots[catalog], namespace, id);
  try {
    lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  checkDirectories(directory);
  const source = path.join(directory, "specialist.yaml");
  const definition = specialistSpecDefinition.parse(
    parse(readDefinitionFile(source), { maxAliasCount: 20 }),
  );
  if (definition.namespace !== namespace || definition.id !== id)
    throw Error("Specialist namespace/id must match its directory path");
  return specialistSnapshot.parse({
    ...definition,
    catalog,
    reference: `${catalog}:${namespace}/${id}`,
    source,
    digest: specDigest(definition),
  });
}
export function resolveSpecialist(
  config: Config,
  reference: string,
): SpecialistSnapshot {
  specialistRef.parse(reference);
  const [catalogHint, specPath] = reference.includes(":")
    ? reference.split(":")
    : [undefined, reference];
  const [namespace, id] = specPath.split("/");
  const roots = catalogRoots(config);
  if (catalogHint) {
    if (!(catalogHint in roots))
      throw Error(`Unknown specialist catalog: ${catalogHint}`);
    return (
      loadSpecialist(roots, catalogHint, namespace, id) ??
      (() => {
        throw Error(`Specialist not found: ${reference}`);
      })()
    );
  }
  const matches = distinctCatalogs(roots)
    .map((catalog) => loadSpecialist(roots, catalog, namespace, id))
    .filter((m): m is SpecialistSnapshot => m !== undefined);
  if (matches.length > 1)
    throw Error(
      `Specialist ${specPath} exists in multiple catalogs; use ${matches
        .map((m) => m.reference)
        .join(" or ")}`,
    );
  if (!matches.length) throw Error(`Specialist not found: ${reference}`);
  return matches[0];
}
export function inlineSpecialist(definition: unknown): SpecialistSnapshot {
  const parsed = specialistSpecDefinition.parse(definition);
  return specialistSnapshot.parse({
    ...parsed,
    catalog: "inline",
    reference: `inline:${parsed.namespace}/${parsed.id}`,
    source: "inline",
    digest: specDigest(parsed),
  });
}
export function specialistMetadata(snapshot: SpecialistSnapshot) {
  const { instructions, acceptanceCriteria, ...metadata } = snapshot;
  return { ...metadata, acceptanceCriteriaCount: acceptanceCriteria.length };
}
export function listSpecialists(config: Config): unknown[] {
  const roots = catalogRoots(config);
  const specialists = [];
  for (const catalog of distinctCatalogs(roots)) {
    const root = roots[catalog];
    if (!existsSync(root)) continue;
    try {
      checkDirectories(root);
      let count = 0;
      for (const namespace of readdirSync(root).sort()) {
        if (!templateId.safeParse(namespace).success) continue;
        const namespaceDir = path.join(root, namespace);
        if (!lstatSync(namespaceDir).isDirectory()) continue;
        for (const id of readdirSync(namespaceDir).sort()) {
          if (!templateId.safeParse(id).success) continue;
          const directory = path.join(namespaceDir, id);
          try {
            if (!lstatSync(directory).isDirectory()) continue;
          } catch {
            continue;
          }
          const reference = `${catalog}:${namespace}/${id}`;
          if (++count > 100) {
            specialists.push({
              catalog,
              error: `Too many ${catalog} specialists (maximum 100); listing truncated`,
            });
            break;
          }
          try {
            specialists.push(
              specialistMetadata(loadSpecialist(roots, catalog, namespace, id)!),
            );
          } catch {
            specialists.push({
              reference,
              error: "Invalid specialist; inspect this reference for details",
            });
          }
        }
        if (count > 100) break;
      }
    } catch (error) {
      specialists.push({
        catalog,
        error: `Catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return specialists;
}
export function validateSpecialistBinding(
  snapshot: SpecialistSnapshot,
  config: Config,
  agentId: string,
) {
  return validateDefinitionBinding(snapshot, config, agentId);
}
