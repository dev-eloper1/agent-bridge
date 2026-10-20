import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Search known user CLI installation directories after PATH. No shell expansion/execution.
export function executablePath(env: NodeJS.ProcessEnv = process.env): string {
  return [
    ...new Set([
      ...(env.PATH ?? "").split(path.delimiter),
      path.join(homedir(), ".local/bin"),
      path.join(homedir(), ".opencode/bin"),
      path.join(homedir(), ".bun/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]),
  ]
    .filter(Boolean)
    .join(path.delimiter);
}
export function resolveExecutable(
  command: string,
  root: string,
  search = executablePath(),
): string | undefined {
  const expanded = command.startsWith("~/")
    ? path.join(homedir(), command.slice(2))
    : command;
  const candidates = expanded.includes("/")
    ? [path.resolve(root, expanded)]
    : search.split(path.delimiter).map((dir) => path.join(dir, expanded));
  // npm prepends dependency .bin folders; native CLI names should prefer the user's
  // installation. Local adapters are explicitly configured with ./node_modules/.bin/ paths.
  if (!expanded.includes("/"))
    candidates.sort(
      (a, b) =>
        Number(a.includes("/node_modules/.bin/")) -
        Number(b.includes("/node_modules/.bin/")),
    );
  return candidates.find((file) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}
