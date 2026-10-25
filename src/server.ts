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
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { Runtime } from "./runtime.js";
import { streamEvents } from "./event-stream.js";
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
  // Raises the bar for /human: callers must read this 0600 file. Any process
  // running as the same user (including a model's shell) still can.
  const paneToken = readPaneToken(config) ?? createPaneToken(config);
  const watchers = new Set<http.ServerResponse>();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/events") {
        const value = url.searchParams.get("since") ?? "0";
        const since = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(since))
          throw Error("since must be a nonnegative safe integer");
        watchers.add(res);
        res.once("close", () => watchers.delete(res));
        streamEvents(runtime.store, res, since);
        return;
      }
      const human = req.method === "POST" && req.url === "/human";
      if (!human && (req.method !== "POST" || req.url !== "/call"))
        throw Error("Use POST /call");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) throw Error("Request too large");
      }
      // Resolve or withdraw a decision. Only the Mod pane calls this route;
      // MCP tools go through /call and cannot reach it.
      if (human) {
        const supplied = Buffer.from(String(req.headers[PANE_TOKEN_HEADER] ?? ""));
        const expected = Buffer.from(paneToken);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          throw Error("Missing or wrong pane token");
        const result = runtime.human(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result }));
        return;
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
    await runtime.close();
    rmSync(lock, { recursive: true });
    throw e;
  }
  chmodSync(config.socket, 0o600);
  runtime.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const watcher of watchers) watcher.destroy();
    const closed = runtime.close().catch((error) => {
      console.error(
        `Agent Bridge: shutdown failed: ${runtime.sanitize(String(error))}`,
      );
    });
    server.close(() => {
      void closed
        .then(() => {
          if (existsSync(config.socket)) rmSync(config.socket);
          rmSync(lock, { recursive: true });
        })
        .catch((error) => {
          console.error(
            `Agent Bridge: shutdown cleanup failed: ${runtime.sanitize(String(error))}`,
          );
        });
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return { runtime, server, stop };
}
export const PANE_TOKEN_HEADER = "x-agent-bridge-pane-token";
const paneTokenFile = (config: Config) =>
  path.join(config.stateDir, "pane-token");
export function readPaneToken(config: Config) {
  const file = paneTokenFile(config);
  if (!existsSync(file)) return undefined;
  const token = readFileSync(file, "utf8").trim();
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
function createPaneToken(config: Config) {
  const token = randomBytes(32).toString("hex");
  writeFileSync(paneTokenFile(config), token, { mode: 0o600 });
  chmodSync(paneTokenFile(config), 0o600);
  return token;
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
        agent: false,
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
