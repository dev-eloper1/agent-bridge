// A small process guardian: pipe closure on daemon death tears down the process group.
import { spawn } from "node:child_process";
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-process.pid, "SIGKILL");
  } catch {}
  process.exit(1);
}
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
process.stdout.on("error", stop);
process.stdin.on("end", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
child.once("error", () => {
  console.error("Configured provider executable could not start");
  stop();
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
  process.stdin.destroy();
});
