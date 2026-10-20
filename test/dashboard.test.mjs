import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { startDashboard, renderMarkdown } from "../dist/dashboard.js";
import {
  createTemplate,
  resolveTemplate,
  listTemplates,
  templateRoots,
} from "../dist/templates.js";
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ab-dashboard-")));
  const roots = templateRoots(root, path.join(root, "global"));
  const call = async (method, args) => {
    if (method === "list") return [{ agentId: "claude-worker", sessions: [] }];
    if (method === "templates")
      return args.reference
        ? resolveTemplate(roots, args.reference)
        : listTemplates(roots);
    if (method === "define")
      return createTemplate(roots, args.scope ?? "project", args.definition);
    if (method === "result")
      return { taskId: args.taskId, status: "completed" };
    if (method === "artifact")
      return {
        text: "# Public result\n<script>alert(1)</script>",
        offset: 0,
        nextOffset: 10,
        eof: true,
      };
    throw Error("Unexpected operation");
  };
  return { root, call };
}
// fetch() forbids overriding Host, so DNS-rebinding checks need raw HTTP.
function statusWithHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}
async function dashboard(fn) {
  const f = fixture();
  const d = await startDashboard({ root: f.root }, f.call);
  const url = new URL(d.url);
  try {
    await fn({
      ...f,
      ...d,
      origin: url.origin,
      token: url.hash.slice(1),
      headers: {
        Authorization: "Bearer " + url.hash.slice(1),
        Origin: url.origin,
        "Content-Type": "application/json",
      },
    });
  } finally {
    await new Promise((resolve) => d.server.close(resolve));
  }
}
test("dashboard binds loopback, requires a capability token and rejects cross-origin/host requests", async () => {
  await dashboard(async (d) => {
    assert.equal(d.server.address().address, "127.0.0.1");
    assert.equal((await fetch(d.origin + "/api/overview")).status, 401);
    assert.equal(
      (await fetch(d.origin + "/api/overview", { headers: d.headers })).status,
      200,
    );
    assert.equal(
      (
        await fetch(d.origin + "/api/overview", {
          headers: { ...d.headers, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      await statusWithHeaders(d.origin + "/api/overview", {
        ...d.headers,
        Host: "evil.example",
      }),
      403,
    );
    const page = await fetch(d.origin);
    assert.match(
      page.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.equal((await fetch(d.origin + "/../package.json")).status, 401);
  });
});
test("dashboard creates definitions with explicit origin, preserves existing data and renders safe Markdown", async () => {
  await dashboard(async (d) => {
    const definition = {
      format: 1,
      id: "reviewer",
      name: "Reviewer",
      version: "1.0.0",
      description: "Review",
      delivery: "task-instructions",
      instructions:
        "# Review\n<script>alert('x')</script>\n[bad](javascript:alert(1))\n![image](https://evil.example/pixel)",
    };
    const body = JSON.stringify({ definition, scope: "project" });
    assert.equal(
      (
        await fetch(d.origin + "/api/definitions", {
          method: "POST",
          headers: {
            Authorization: d.headers.Authorization,
            "Content-Type": "application/json",
          },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(d.origin + "/api/definitions", {
          method: "POST",
          headers: d.headers,
          body,
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await fetch(d.origin + "/api/definitions", {
          method: "POST",
          headers: d.headers,
          body,
        })
      ).status,
      400,
    );
    const saved = await (
      await fetch(d.origin + "/api/definition?reference=project:reviewer", {
        headers: d.headers,
      })
    ).json();
    assert.match(saved.html, /<h1>Review<\/h1>/);
    assert.doesNotMatch(saved.html, /<script|<img|href="javascript:/);
    const report = await (
      await fetch(d.origin + "/api/task?taskId=fixture", { headers: d.headers })
    ).json();
    assert.match(report.html, /Public result/);
    assert.doesNotMatch(report.html, /<script>/);
    assert.equal(
      (
        await fetch(d.origin + "/api/spawn", {
          method: "POST",
          headers: d.headers,
          body: "{}",
        })
      ).status,
      404,
    );
  });
});
test("Markdown rendering escapes raw HTML and refuses unsafe links without executing extensions", () => {
  assert.doesNotMatch(
    renderMarkdown(
      '<iframe src="https://evil.example"></iframe>\n[x](javascript:alert(1))\n![x](https://evil.example/x)',
    ),
    /<iframe|<img|href="javascript:/,
  );
});
