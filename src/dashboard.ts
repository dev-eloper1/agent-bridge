import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import MarkdownIt from "markdown-it";
import type { Config } from "./config.js";
import { templateDefinition } from "./templates.js";

const markdown = new MarkdownIt({ html: false, linkify: false });
// Reports may contain arbitrary provider text; never load their remote images automatically.
markdown.disable("image");
export function renderMarkdown(text: string) {
  return markdown.render(text);
}
export async function startDashboard(
  config: Config,
  call: (method: string, args: unknown) => Promise<unknown>,
) {
  const token = randomBytes(32).toString("base64url");
  let origin = "";
  const assets: Record<string, { name: string; type: string }> = {
    "/": { name: "index.html", type: "text/html" },
    "/app.js": { name: "app.js", type: "text/javascript" },
    "/styles.css": { name: "styles.css", type: "text/css" },
  };
  const server = http.createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        return json(403, { error: "Origin refused" });
      const url = new URL(req.url ?? "/", origin);
      if (req.method === "GET" && assets[url.pathname]) {
        const asset = assets[url.pathname];
        res.writeHead(200, {
          "Content-Type": asset.type + "; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          readFileSync(new URL("../dashboard/" + asset.name, import.meta.url)),
        );
        return;
      }
      const supplied = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (
        supplied.length !== token.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        return json(401, {
          error: "Open the dashboard link from this runtime",
        });
      if (req.method === "GET" && url.pathname === "/api/overview") {
        const [workers, definitions] = await Promise.all([
          call("list", {}),
          call("templates", {}),
        ]);
        return json(200, { project: config.root, workers, definitions });
      }
      if (req.method === "GET" && url.pathname === "/api/definition") {
        const args = url.searchParams.has("conversation")
          ? { agentSessionId: url.searchParams.get("conversation") }
          : {
              reference: url.searchParams.get("reference"),
              ...(url.searchParams.has("agentId")
                ? { agentId: url.searchParams.get("agentId") }
                : {}),
            };
        const definition = (await call("templates", args)) as {
          instructions: string;
        };
        return json(200, {
          definition,
          html: renderMarkdown(definition.instructions),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/task") {
        const taskId = url.searchParams.get("taskId");
        const result = await call("result", { taskId, maxChars: 2000 });
        const page = (await call("artifact", {
          ref: `artifact://${taskId}/output.txt`,
          offset: Number(url.searchParams.get("offset") ?? 0),
          limit: 6000,
        })) as { text: string };
        return json(200, { result, page, html: renderMarkdown(page.text) });
      }
      if (
        req.method === "POST" &&
        ["/api/definitions", "/api/preview"].includes(url.pathname)
      ) {
        if (
          req.headers.origin !== origin ||
          req.headers["content-type"] !== "application/json"
        )
          return json(403, { error: "Same-origin JSON required" });
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 32000)
            return json(413, { error: "Definition is too large" });
        }
        const parsed = JSON.parse(body);
        if (url.pathname === "/api/preview") {
          const definition = templateDefinition.parse(parsed);
          return json(200, { html: renderMarkdown(definition.instructions) });
        }
        const definition = await call("define", parsed);
        return json(201, { definition });
      }
      return json(404, { error: "Unknown dashboard operation" });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Dashboard operation failed";
      // The runtime wrapper sanitizes error text before exposing this boundary.
      return json(400, { error: message.slice(0, 1000) });
    }
  });
  server.requestTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw Error("Dashboard listen failed");
  }
  origin = `http://127.0.0.1:${address.port}`;
  return { url: `${origin}/#${token}`, server };
}
