import http from "node:http";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { Runtime } from "./runtime.js";
export async function serve(config: Config) {
  process.umask(0o077);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(config.stateDir, "lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (e) {
    // Never break an incomplete/unknown lock: another daemon may be writing its PID.
    const pid = Number(readFileSync(path.join(lock, "pid"), "utf8"));
    if (!Number.isInteger(pid) || pid <= 0)
      throw Error("Invalid runtime lock; inspect it manually");
    try {
      process.kill(pid, 0);
      throw Error("Runtime already running");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    rmSync(lock, { recursive: true });
    mkdirSync(lock, { mode: 0o700 });
  }
  writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  // Under exclusive lock, remove only this runtime's stale socket.
  if (existsSync(config.socket)) rmSync(config.socket);
  let runtime: Runtime;
  try {
    runtime = new Runtime(config);
  } catch (e) {
    rmSync(lock, { recursive: true });
    throw e;
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/call")
        throw Error("Use POST /call");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) throw Error("Request too large");
      }
      const { method, args } = JSON.parse(body);
      if (method === "shutdown") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: { stopped: true } }));
        setImmediate(stop);
        return;
      }
      const result = await runtime.call(method, args ?? {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: runtime
            .sanitize(e instanceof Error ? e.message : String(e))
            .slice(0, 1000),
        }),
      );
    }
  });
  server.requestTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.socket, resolve);
    });
  } catch (e) {
    runtime.close();
    rmSync(lock, { recursive: true });
    throw e;
  }
  chmodSync(config.socket, 0o600);
  runtime.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    runtime.close();
    server.close(() => {
      if (existsSync(config.socket)) rmSync(config.socket);
      rmSync(lock, { recursive: true });
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return { runtime, server, stop };
}
export function remote(
  config: Config,
  method: string,
  args: unknown = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: config.socket,
        path: "/call",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const v = JSON.parse(body);
            v.error ? reject(Error(v.error)) : resolve(v.result);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(Error("Runtime request timed out")));
    req.end(JSON.stringify({ method, args }));
  });
}
