// X3 spike: only coordinator input reaches this runner; provider output is data.
import { spawn } from "node:child_process";
import path from "node:path";
import { allowlistedEnvironment } from "./acp.js";
import { z } from "zod";
const argument = z
  .string()
  .max(16000)
  .refine((s) => !s.includes("\0"), "NUL in argv");
export const verifySpec = z
  .object({
    argv: z
      .array(argument)
      .min(1)
      .max(100)
      .refine(
        (argv) =>
          typeof argv[0] === "string" &&
          path.isAbsolute(argv[0]) &&
          argv[0].trim().length > 0,
        "Verification executable must be an absolute path",
      )
      .describe(
        "Executable and literal arguments; argv[0] must be an absolute path; no NUL bytes; no shell expansion",
      ),
    envNames: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .refine(
            (name) => name !== "AGENT_BRIDGE_WORKER",
            "Worker recursion marker cannot be inherited",
          ),
      )
      .max(100)
      .optional(),
    allowInputsChanged: z.boolean().optional(),
    timeoutMs: z.number().int().min(1).max(60000).default(10000),
  })
  .strict();
export type VerifySpec = z.infer<typeof verifySpec>;
export interface VerificationResult {
  exitCode: number | null;
  signal: string | null;
  reason:
    | "exit"
    | "timeout"
    | "spawn_error"
    | "error"
    | "restarted"
    | "aborted"
    | "output_limit"
    | "tampered";
  inputsChanged?: string[];
  outputRef: string;
  outputTail: string;
}
export async function verifyCommand(
  spec: VerifySpec,
  cwd: string,
  maxBytes: number,
  signal: AbortSignal,
) {
  const { argv, timeoutMs, envNames } = verifySpec.parse(spec);
  return await new Promise<{
    passed: boolean;
    output: Buffer;
    exitCode: number | null;
    signal: string | null;
    reason: VerificationResult["reason"];
  }>((resolve) => {
    let output = Buffer.alloc(0);
    let reason: VerificationResult["reason"] = "exit";
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const counts = { stdout: 0, stderr: 0 };
    // execFile does not forward detached to spawn. Use the same no-shell argv
    // semantics directly, so the verifier owns a process group on POSIX.
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      env: allowlistedEnvironment(envNames),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = () => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const finish = (exitCode: number | null, exitSignal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      signal.removeEventListener("abort", abort);
      killGroup(); // Also remove descendants left behind by a successful parent.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        passed: reason === "exit" && exitCode === 0,
        output,
        exitCode,
        signal: exitSignal,
        reason,
      });
    };
    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      output = Buffer.concat([output, chunk]).subarray(-maxBytes);
      counts[stream] += chunk.length;
      if (counts[stream] > 1024 * 1024 && reason === "exit") {
        reason = "output_limit";
        killGroup();
      }
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", (error) => {
      reason = "spawn_error";
      output = Buffer.from(error.message).subarray(-maxBytes);
      finish(null, null);
    });
    const abort = () => {
      reason = "aborted";
      killGroup();
      drain = setTimeout(() => finish(null, "SIGKILL"), 100);
    };
    const timer = setTimeout(() => {
      reason = "timeout";
      killGroup();
      // Never wait indefinitely for descendants holding inherited pipes.
      drain = setTimeout(() => finish(null, "SIGKILL"), 100);
    }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("exit", (code, exitSignal) => {
      killGroup();
      drain = setTimeout(() => finish(code, exitSignal), 100);
    });
    child.once("close", (code, exitSignal) => finish(code, exitSignal));
  });
}
