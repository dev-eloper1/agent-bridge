import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const relevant = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "test",
];
export type VerifyInputs = Record<string, string>;
function digest(file: string): string {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  // Following symlinks would let a workspace redirect reads outside its boundary.
  if (stat.isSymbolicLink())
    throw Error("Symlink in verification inputs: " + file);
  const hash = createHash("sha256");
  if (stat.isDirectory()) {
    hash.update("directory\0");
    for (const name of readdirSync(file).sort())
      hash.update(JSON.stringify([name, digest(path.join(file, name))]));
  } else if (stat.isFile()) hash.update("file\0").update(readFileSync(file));
  else throw Error("Unsupported verification input: " + file);
  return hash.digest("hex");
}
export function snapshotVerifyInputs(cwd: string): VerifyInputs {
  return Object.fromEntries(
    relevant.map((name) => [name, digest(path.join(cwd, name))]),
  );
}
export function changedVerifyInputs(
  before: VerifyInputs,
  cwd: string,
): string[] {
  return relevant.filter((name) => {
    try {
      return before[name] !== digest(path.join(cwd, name));
    } catch {
      return true;
    } // Deleted/replaced/unreadable input is a change, never a pass.
  });
}
