import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { resolveExecutable } from "../dist/executables.js";
const root = process.cwd();
function executable(file, source = "process.exit(0)") {
  writeFileSync(file, `#!${process.execPath}\n${source}\n`);
  chmodSync(file, 0o755);
}
test("native CLI discovery prefers installed binary to npm-bundled shadow and checks execute permission", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-exe-"));
  const local = path.join(dir, "node_modules/.bin");
  const installed = path.join(dir, "user-bin");
  mkdirSync(local, { recursive: true });
  mkdirSync(installed);
  executable(path.join(local, "sample"));
  executable(path.join(installed, "sample"));
  const search = [local, installed].join(path.delimiter);
  assert.equal(
    resolveExecutable("sample", dir, search),
    path.join(installed, "sample"),
  );
  assert.equal(
    resolveExecutable("./node_modules/.bin/sample", dir, search),
    path.join(local, "sample"),
  );
  writeFileSync(path.join(installed, "no-exec"), "data");
  assert.equal(resolveExecutable("no-exec", dir, search), undefined);
  const relative = path.relative(homedir(), process.execPath);
  assert.equal(
    resolveExecutable("~/" + relative, dir),
    path.join(homedir(), relative),
  );
});
async function piWrapper(source) {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-pi-wrapper-"));
  executable(path.join(dir, "pi"), source);
  const child = spawn(
    process.execPath,
    [path.join(root, "scripts/pi-readonly.mjs"), "--mode", "rpc"],
    { env: { PATH: dir, BRIDGE_PI_MODEL: "test/model" }, stdio: "pipe" },
  );
  let output = "",
    error = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (error += b));
  const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  const code = await new Promise((r) => child.once("close", r));
  clearTimeout(timer);
  return { code, output, error };
}
test("Pi wrapper disables executable extensions and write tools and preserves explicit RPC flags", async () => {
  const r = await piWrapper(
    'console.log(JSON.stringify({type:"probe",args:process.argv.slice(2)}));',
  );
  assert.equal(r.code, 0);
  const args = JSON.parse(r.output.trim()).args;
  assert.ok(args.includes("read,grep,find,ls"));
  for (const flag of [
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-context-files",
    "--no-approve",
  ])
    assert.ok(args.includes(flag));
  assert.deepEqual(args.slice(-2), ["--mode", "rpc"]);
  assert.ok(args.includes("test/model"));
});
test("Pi model errors cannot become successful empty ACP turns", async () => {
  const r = await piWrapper(
    'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"error",errorMessage:"Model unavailable"}}));console.log(JSON.stringify({type:"agent_settled"}));',
  );
  assert.equal(r.code, 1);
  assert.match(r.error, /Pi model error: Model unavailable/);
  assert.equal(r.output, "");
});
