import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const MODULES = [
  "acp",
  "build-id",
  "cli",
  "config",
  "dashboard",
  "effective-config",
  "executables",
  "mcp",
  "models",
  "plugin",
  "preferences",
  "project-config",
  "run",
  "runtime",
  "server",
  "session-settings",
  "specialists",
  "store",
  "templates",
  "worker-host",
  "worker-names",
  "worker-settings",
  "workspaces",
].sort();
export function computeBuildId(
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): string {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dist = fileURLToPath(new URL("./", import.meta.url));
  const hash = createHash("sha256");
  try {
    const pkg = JSON.parse(read(root + "package.json"));
    hash.update(String(pkg.version ?? ""));
    for (const name of MODULES)
      hash.update(name).update(read(`${dist}${name}.js`));
  } catch (e) {
    throw Error(
      `Agent Bridge build files are unreadable under ${dist}; run npm run build before starting. ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return hash.digest("hex");
}
export const buildId: string = computeBuildId();
