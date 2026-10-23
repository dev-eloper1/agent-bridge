import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const PLUGIN_ID = "agent-bridge@agent-bridge-local";

function bound(value, max = 500) {
  return String(value ?? "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^@\s/]+@/g, "$1[REDACTED]@")
    .slice(0, max);
}

export function pluginBlock(listOutput, pluginId = PLUGIN_ID) {
  const lines = String(listOutput ?? "").split("\n");
  const start = lines.findIndex(
    (line) => line.trim().replace(/^❯\s*/, "") === pluginId,
  );
  if (start < 0) return undefined;
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith("❯")) break;
    block.push(line);
  }
  return block.join("\n");
}

async function defaultRun(command, args, opts = {}) {
  if (opts.inherit) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: opts.cwd, stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (result) => resolve(result ?? 1));
    });
    if (code !== 0)
      throw Error(`${command} ${args.join(" ")} exited with code ${code}`);
    return { stdout: "", stderr: "" };
  }
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: opts.cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (e) {
    throw Error(
      `${command} ${args.join(" ")} failed: ${bound(e.stderr || e.stdout || e.message)}`,
    );
  }
}

export function nodeMajor(version = process.version) {
  return Number.parseInt(String(version).replace(/^v/, ""), 10);
}

export async function updatePlugin(options = {}) {
  const root =
    options.root ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const run = options.run ?? defaultRun;
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const nodeVersion = options.nodeVersion ?? process.version;
  const invoke = async (command, args, opts = {}) => {
    try {
      return await run(command, args, { cwd: root, ...opts });
    } catch (e) {
      throw Error(`${command} ${args.join(" ")} failed: ${bound(e.message)}`);
    }
  };
  const git = (args) => invoke("git", args);

  const branch = (await git(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  if (branch !== "main")
    throw Error(
      `Update requires the main branch; current branch is "${branch}". Switch to main before running npm run update:plugin.`,
    );
  const sha = (value) => /^[0-9a-f]{7,64}$/i.test(value);
  const before = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (!sha(before))
    throw Error(
      `Could not read a valid HEAD revision ("${bound(before, 80)}").`,
    );
  const status = (await git(["status", "--porcelain"])).stdout;
  const dirtyPaths = status.split("\n").filter((line) => line.trim()).length;
  const dirty = dirtyPaths > 0;
  if (dirty)
    warn(
      `${dirtyPaths} local path(s) have uncommitted changes; they will be preserved and included in the build.`,
    );
  await git(["fetch", "origin", "main"]);
  const relation = (
    await git(["rev-list", "--left-right", "--count", "HEAD...origin/main"])
  ).stdout
    .trim()
    .split(/\s+/)
    .map(Number);
  if (
    relation.length !== 2 ||
    relation.some((n) => !Number.isInteger(n) || n < 0)
  )
    throw Error(
      "Could not determine relation to origin/main; resolve the local checkout manually before updating.",
    );
  const [ahead, behind] = relation;
  if (ahead > 0)
    throw Error(
      `Local main is ${ahead} commit(s) ahead of origin/main. Push or reconcile those commits first; this update never rebases, resets or discards local work.`,
    );
  if (behind > 0) await git(["merge", "--ff-only", "origin/main"]);
  const after = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (!sha(after))
    throw Error(
      `Could not read a valid HEAD revision ("${bound(after, 80)}").`,
    );
  const changed = before !== after;

  const major = nodeMajor(nodeVersion);
  if (Number.isNaN(major))
    warn(
      `Could not parse Node version "${bound(nodeVersion, 40)}"; this package requires Node >=24.`,
    );
  else if (major < 24)
    warn(
      `This package requires Node >=24; current Node ${String(nodeVersion).replace(/^v/, "")} is unsupported and the build may fail.`,
    );

  try {
    await invoke("npm", ["--version"]);
  } catch {
    throw Error(
      "npm is required to update the plugin but was not found on PATH. Install Node.js with npm first.",
    );
  }
  await invoke("npm", ["ci"], { inherit: true });
  await invoke("npm", ["run", "build"], { inherit: true });

  try {
    await invoke("claude", ["--version"]);
  } catch {
    throw Error(
      "claude CLI is required to update the plugin but was not found on PATH. Install Claude Code first.",
    );
  }
  const installCommand = `claude plugin install agent-bridge --marketplace "${root}" --scope user`;
  const listed = (await invoke("claude", ["plugin", "list"])).stdout;
  if (!pluginBlock(listed))
    throw Error(
      `Plugin ${PLUGIN_ID} is not installed for this user. Install it first:\n  ${installCommand}`,
    );
  await invoke("claude", ["plugin", "update", PLUGIN_ID, "--scope", "user"], {
    inherit: true,
  });
  const relisted = pluginBlock(
    (await invoke("claude", ["plugin", "list"])).stdout,
  );
  if (!relisted || !/(^|\n)\s*status[^\n]*\benabled\b/i.test(relisted))
    throw Error(
      `Plugin ${PLUGIN_ID} is missing or disabled after update; inspect 'claude plugin list'.`,
    );

  log(
    changed
      ? `Updated ${before.slice(0, 7)} → ${after.slice(0, 7)}.`
      : `Already current at ${after.slice(0, 7)}.`,
  );
  log(
    "Build complete. Run /reload-plugins in open Claude sessions. Idle Agent Bridge daemons restart automatically on next call; active tasks keep their runtime until they finish.",
  );
  return { before, after, changed, dirty };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  updatePlugin().catch((error) => {
    console.error(bound(error.message, 800));
    process.exit(1);
  });
