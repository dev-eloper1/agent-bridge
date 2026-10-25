import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Runtime, inputs } from "../dist/runtime.js";
import { schema, loadConfig } from "../dist/config.js";
import { remote, serve, readPaneToken } from "../dist/server.js";
import { MAX_PROMPT_CHARS } from "../dist/handoff.js";

const root = process.cwd();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (predicate(value)) return value;
    await pause(10);
  }
  throw Error("Decision test condition timed out");
}
function makeConfig(dir) {
  return {
    ...schema.parse({
      version: 1,
      runtime: { maxConcurrentTasks: 2, maxRuntimeMs: 5000 },
      providers: {
        mock: {
          command: process.execPath,
          args: [path.join(root, "scripts/mock-acp.mjs")],
          env: { MOCK_STATE: path.join(dir, "mock.json") },
          readOnlyEnforced: true,
        },
      },
      agents: {
        demo: { provider: "mock", description: "decision test", workspace: "read-only" },
      },
    }),
    root: dir,
    stateDir: path.join(dir, "state"),
    socket: path.join(dir, "unused.sock"),
    sourceFile: path.join(dir, "unused.yaml"),
    configDigest: "decisions",
  };
}
function fixture(t) {
  const dir = mkdtempSync(path.join(root, ".decisions-"));
  const runtimes = [];
  const open = () => {
    const r = new Runtime(makeConfig(dir));
    runtimes.push(r);
    return r;
  };
  t.after(async () => {
    for (const r of runtimes) await r.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return open;
}
const options = [
  { label: "sqlite", tradeoff: "durable, one more native module" },
  { label: "json", tradeoff: "simple, slow at scale" },
];
const openDecision = (r, extra = {}) =>
  r.call("decision_open", { question: "Which store?", options, ...extra });
const status = (r, task) => r.call("status", { taskId: task.taskId });
const waitStatus = (r, task, expected) =>
  until(() => status(r, task), (value) => value.status === expected);

test("dependent waits for a person's decision while unrelated work runs, then gets the choice fenced", async (t) => {
  const r = fixture(t)();
  const decision = await openDecision(r);
  assert.equal(decision.status, "open");
  assert.equal(decision.openedBy, "coordinator");
  const waiting = await r.call("spawn", {
    agentId: "demo",
    prompt: "use the chosen store",
    waitsOnDecisions: [decision.decisionId],
  });
  assert.equal(waiting.queueReason, "waiting_on_decision");
  const unrelated = await r.call("spawn", { agentId: "demo", prompt: "unrelated" });
  await waitStatus(r, unrelated, "completed");
  assert.equal((await status(r, waiting)).status, "queued");
  const resolved = r.decide({ decisionId: decision.decisionId, option: "1", surface: "mod-button" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution.option, "sqlite");
  assert.equal(resolved.resolution.claimedSurface, "mod-button");
  assert.ok(resolved.resolution.at);
  await waitStatus(r, waiting, "completed");
  const output = await r.call("result", { taskId: waiting.taskId, maxChars: 6000 });
  const text = JSON.stringify(output);
  assert.match(text, new RegExp(`source=decision:${decision.decisionId}`));
  assert.match(text, /UNTRUSTED-[a-f0-9]{16}/);
  assert.match(text, /Answer: sqlite/);
  assert.throws(
    () => r.decide({ decisionId: decision.decisionId, option: "2", surface: "mod-command" }),
    /resolved/,
  );
});

test("free text, labels and surfaces are recorded; bad answers are refused", async (t) => {
  const r = fixture(t)();
  const strict = await openDecision(r);
  assert.throws(() => r.decide({ decisionId: strict.decisionId, text: "both", surface: "mod-command" }), /free text/);
  assert.throws(() => r.decide({ decisionId: strict.decisionId, option: "9", surface: "mod-command" }), /Unknown option/);
  assert.throws(() => r.decide({ decisionId: strict.decisionId, option: "1", surface: "Not A Surface" }), /surface/);
  assert.equal(r.decide({ decisionId: strict.decisionId, option: "json", surface: "mod-command" }).resolution.claimedSurface, "mod-command");
  const free = await openDecision(r, { allowFreeText: true });
  const answer = r.decide({ decisionId: free.decisionId, text: " neither ", surface: "mod-command" });
  assert.equal(answer.resolution.text, "neither");
});

test("withdrawn decision fails its dependents with a clear reason and refuses new ones", async (t) => {
  const r = fixture(t)();
  const decision = await openDecision(r);
  const waiting = await r.call("spawn", {
    agentId: "demo",
    prompt: "never runs",
    waitsOnDecisions: [decision.decisionId],
  });
  r.withdraw({ decisionId: decision.decisionId, surface: "mod-command" });
  const failed = await waitStatus(r, waiting, "failed");
  assert.equal(failed.startedAt, undefined);
  assert.match(failed.summary, new RegExp(`Decision ${decision.decisionId} was withdrawn`));
  await assert.rejects(
    r.call("spawn", { agentId: "demo", prompt: "late", waitsOnDecisions: [decision.decisionId] }),
    /withdrawn/,
  );
});

test("expiry happens on the timer and blocks dependents", async (t) => {
  const r = fixture(t)();
  const decision = await openDecision(r, { expiresInMs: 50 });
  assert.ok(decision.expiresAt);
  const waiting = await r.call("spawn", {
    agentId: "demo",
    prompt: "never runs",
    waitsOnDecisions: [decision.decisionId],
  });
  const failed = await waitStatus(r, waiting, "failed");
  assert.match(failed.summary, /was expired/);
  assert.equal((await r.call("decision_status", { decisionId: decision.decisionId })).status, "expired");
  assert.throws(() => r.decide({ decisionId: decision.decisionId, option: "1", surface: "mod-button" }), /expired/);
});

test("decisions and waiting tasks survive a restart; resolution after restart releases work", async (t) => {
  const open = fixture(t);
  const first = open();
  const decision = await openDecision(first, { expiresInMs: 60_000 });
  const waiting = await first.call("spawn", {
    agentId: "demo",
    prompt: "after restart",
    waitsOnDecisions: [decision.decisionId],
  });
  await first.close();
  const second = open();
  const reloaded = await second.call("decision_status", { decisionId: decision.decisionId });
  assert.equal(reloaded.status, "open");
  assert.equal(reloaded.question, "Which store?");
  assert.deepEqual(reloaded.options, options);
  assert.equal(reloaded.expiresAt, decision.expiresAt);
  assert.deepEqual((await status(second, waiting)).waitsOnDecisions, [decision.decisionId]);
  second.decide({ decisionId: decision.decisionId, option: "2", surface: "mod-command" });
  await waitStatus(second, waiting, "completed");
  await second.close();
  const third = open();
  const final = await third.call("decision_status", { decisionId: decision.decisionId });
  assert.equal(final.resolution.option, "json");
  assert.equal(final.resolution.claimedSurface, "mod-command");
  assert.equal((await status(third, waiting)).status, "completed");
});

test("no MCP tool can resolve, withdraw or expire a decision", () => {
  // mcp.ts registers one tool per key of `inputs` (plus agents_run).
  const names = Object.keys(inputs);
  assert.ok(names.includes("decision_open"));
  assert.ok(names.includes("decision_status"));
  for (const name of names)
    assert.doesNotMatch(name, /decide|resolve|withdraw|expire|answer/);
  // Opening cannot smuggle in a pre-decided status or resolution.
  for (const extra of [{ status: "resolved" }, { resolution: { option: "sqlite" } }])
    assert.throws(() =>
      inputs.decision_open.parse({ question: "q", options, ...extra }),
    );
  // Labels cannot impersonate positions or each other, so a person's
  // "/workers decide <id> 2" always means what the pane showed.
  for (const bad of [
    [{ label: "2", tradeoff: "a" }, { label: "1", tradeoff: "b" }],
    [{ label: "ship", tradeoff: "a" }, { label: " Ship ", tradeoff: "b" }],
  ])
    assert.throws(() => inputs.decision_open.parse({ question: "q", options: bad }));
  // A model's reply to a task question cannot target a decision.
  assert.throws(() =>
    inputs.reply.parse({ taskId: "dec_00000000-0000-0000-0000-000000000000", questionId: "q" }),
  );
});

function daemonConfig(dir) {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    runtime: { stateDir: path.join(dir, "s"), maxConcurrentTasks: 1 },
    providers: { mock: {
      command: process.execPath,
      args: [path.join(root, "scripts/mock-acp.mjs")],
      readOnlyEnforced: true,
    } },
    agents: { one: { provider: "mock", description: "test", workspace: "read-only" } },
  }));
  return loadConfig(file);
}
function post(config, route, body, token = readPaneToken(config)) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: config.socket,
        path: route,
        method: "POST",
        agent: false,
        headers: token === null ? {} : { "x-agent-bridge-pane-token": token },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
function watch(config, since) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: config.socket, path: "/events?since=" + since, agent: false }, (res) => {
      let body = "";
      const events = [];
      res.on("data", (chunk) => {
        body += chunk;
        let end;
        while ((end = body.indexOf("\n")) >= 0) {
          events.push(JSON.parse(body.slice(0, end)));
          body = body.slice(end + 1);
        }
      });
      resolve({ res, events });
    });
    req.on("error", reject);
  });
}

test("/human route settles decisions with its surface; /call cannot; events replay and push live", async (t) => {
  const dir = mkdtempSync(path.join(root, ".dec-"));
  const config = daemonConfig(dir);
  const daemon = await serve(config);
  const watchers = [];
  t.after(async () => {
    for (const w of watchers) w.res.destroy();
    daemon.stop();
    await daemon.runtime.close();
    await until(() => !existsSync(path.join(config.stateDir, "lock")), Boolean);
    rmSync(dir, { recursive: true, force: true });
  });
  const first = await remote(config, "decision_open", { question: "Ship it?", options });
  // Replay: a watcher connecting after the fact still sees decision.opened.
  const late = await watch(config, 0);
  watchers.push(late);
  await until(() => late.events.length, (n) => n === 1);
  assert.equal(late.events[0].kind, "decision.opened");
  assert.equal(late.events[0].decisionId, first.decisionId);
  assert.equal(late.events[0].taskId, undefined);
  assert.equal(late.events[0].requiresReply, true);
  // The model's path refuses every settling verb.
  for (const method of ["decide", "withdraw", "human", "resolve"])
    await assert.rejects(remote(config, method, { decisionId: first.decisionId }), /Unknown method/);
  const listed = await remote(config, "decision_status", {});
  assert.deepEqual(listed.decisions.map((d) => d.decisionId), [first.decisionId]);
  // The pane token is required: a 0600 file the daemon creates. This raises
  // the bar only; any process running as the owner can read it.
  const tokenFile = path.join(config.stateDir, "pane-token");
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  for (const token of [null, "", "0".repeat(64)]) {
    const refused = await post(config, "/human", {
      action: "decide", decisionId: first.decisionId, option: "1", surface: "mod-button",
    }, token);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /pane token/);
  }
  assert.equal((await remote(config, "decision_status", { decisionId: first.decisionId })).status, "open");
  // Only the named Mod surfaces are accepted.
  const forged = await post(config, "/human", {
    action: "decide", decisionId: first.decisionId, option: "1", surface: "mcp",
  });
  assert.equal(forged.status, 400);
  const decided = await post(config, "/human", {
    action: "decide", decisionId: first.decisionId, option: "1", surface: "mod-button",
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.result.resolution.claimedSurface, "mod-button");
  await until(() => late.events.length, (n) => n === 2);
  assert.equal(late.events[1].kind, "decision.resolved");
  assert.match(late.events[1].summary, /claimed surface mod-button\): sqlite/);
  // Live: withdraw and timer expiry reach a connected watcher.
  const second = await remote(config, "decision_open", { question: "Rename?", options });
  const third = await remote(config, "decision_open", { question: "Later?", options, expiresInMs: 30 });
  const since = late.events[1].cursor;
  const live = await watch(config, since);
  watchers.push(live);
  const withdrawn = await post(config, "/human", {
    action: "withdraw", decisionId: second.decisionId, surface: "mod-command",
  });
  assert.equal(withdrawn.body.result.status, "withdrawn");
  await until(() => live.events.map((e) => e.kind),
    (kinds) => kinds.includes("decision.withdrawn") && kinds.includes("decision.expired"));
  assert.deepEqual(
    live.events.filter((e) => e.decisionId === third.decisionId).map((e) => e.kind),
    ["decision.opened", "decision.expired"],
  );
  // No gaps or duplicates after the resume cursor.
  assert.deepEqual(live.events.map((e) => e.cursor), live.events.map((_, i) => since + 1 + i));
});

test("decision events opened by a task name both; stored events must name a task or a decision", async (t) => {
  const open = fixture(t);
  const r = open();
  const task = await r.call("spawn", { agentId: "demo", prompt: "opener" });
  await waitStatus(r, task, "completed");
  const decision = await openDecision(r, { openedBy: task.taskId });
  const event = r.store.state.events.findLast((e) => e.type === "decision.opened");
  assert.equal(event.taskId, task.taskId);
  assert.equal(event.decisionId, decision.decisionId);
  assert.equal(event.agentId, "demo");
  const events = await r.call("events", {});
  assert.equal(events.events.at(-1).kind, "decision.opened");
  await r.close();
  // Restart validates the stored decision events.
  const again = open();
  assert.equal(again.store.state.events.at(-1).decisionId, decision.decisionId);
  await again.close();
  const state = structuredClone(again.store.state);
  delete state.events.at(-1).taskId;
  delete state.events.at(-1).decisionId;
  const dir = mkdtempSync(path.join(root, ".decisions-bad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "state"));
  writeFileSync(path.join(dir, "state", "state.json"), JSON.stringify(state));
  assert.throws(() => new Runtime(makeConfig(dir)), /task\/decision reference/);
});

test("question and option text must be safe to display, and labels distinct as displayed", () => {
  const parse = (extra) => inputs.decision_open.parse({ question: "Which store?", options, ...extra });
  const bad = [
    { options: [{ label: "ship\u001b[31m", tradeoff: "a" }, { label: "ship", tradeoff: "b" }] },
    { options: [{ label: "ship\u200b", tradeoff: "a" }, { label: "hold", tradeoff: "b" }] },
    { options: [{ label: "ship\u202e", tradeoff: "a" }, { label: "hold", tradeoff: "b" }] },
    { options: [{ label: "ship", tradeoff: "fast\u0007" }, { label: "hold", tradeoff: "b" }] },
    { options: [{ label: "ｓｈｉｐ", tradeoff: "a" }, { label: "ship", tradeoff: "b" }] },
    { options: [{ label: "ship  it", tradeoff: "a" }, { label: "Ship it", tradeoff: "b" }] },
    { options: [{ label: "２", tradeoff: "a" }, { label: "hold", tradeoff: "b" }] },
    { question: "Pick\u001b]0;owned\u0007 one" },
  ];
  for (const extra of bad) assert.throws(() => parse(extra), undefined, JSON.stringify(extra));
  // Ordinary text, including line breaks in the question, is accepted.
  assert.equal(parse({ question: "Which store?\nPick one." }).question, "Which store?\nPick one.");
});

test("a typed label matches its displayed form; free text is capped at open time", async (t) => {
  const r = fixture(t)();
  const d = await r.call("decision_open", {
    question: "Ship?",
    options: [{ label: "Ship it", tradeoff: "now" }, { label: "Hold", tradeoff: "later" }],
    allowFreeText: true,
    maxFreeTextChars: 10,
  });
  assert.equal(d.maxFreeTextChars, 10);
  assert.throws(
    () => r.decide({ decisionId: d.decisionId, text: "x".repeat(11), surface: "mod-button" }),
    /at most 10/,
  );
  assert.throws(
    () => r.decide({ decisionId: d.decisionId, text: "ok\u001b[2J", surface: "mod-button" }),
    /control or invisible/,
  );
  assert.equal(
    r.decide({ decisionId: d.decisionId, option: "ship  IT", surface: "mod-command" }).resolution.option,
    "Ship it",
  );
});

test("spawn reserves room for the longest answer, so a valid answer cannot fail an accepted task", async (t) => {
  const r = fixture(t)();
  const d = await openDecision(r, { allowFreeText: true, maxFreeTextChars: 2000 });
  const longest = "y".repeat(2000);
  // Find the largest prompt that fits with the longest answer, by probing.
  let lo = 1, hi = MAX_PROMPT_CHARS;
  const fits = async (n) => {
    try {
      inputs.spawn.parse({ agentId: "demo", prompt: "p".repeat(n) });
      const probe = await openDecision(r, { allowFreeText: true, maxFreeTextChars: 2000 });
      await r.call("spawn", { agentId: "demo", prompt: "p".repeat(n), waitsOnDecisions: [probe.decisionId] });
      r.withdraw({ decisionId: probe.decisionId, surface: "mod-command" });
      return true;
    } catch (error) {
      assert.match(error.message, new RegExp(`longest possible answers.*${MAX_PROMPT_CHARS}`));
      return false;
    }
  };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (await fits(mid)) lo = mid; else hi = mid - 1;
  }
  assert.ok(lo < MAX_PROMPT_CHARS - 2000, "the answer budget is reserved");
  // A task accepted right at the limit still runs when the answer is as long as allowed.
  const waiting = await r.call("spawn", {
    agentId: "demo",
    prompt: "p".repeat(lo),
    waitsOnDecisions: [d.decisionId],
  });
  r.decide({ decisionId: d.decisionId, text: longest, surface: "mod-button" });
  const done = await waitStatus(r, waiting, "completed");
  assert.equal(done.status, "completed");
});

test("expiry timers are restored after a restart", async (t) => {
  const open = fixture(t);
  const first = open();
  const stillOpen = await openDecision(first, { expiresInMs: 400 });
  const pastDue = await openDecision(first, { expiresInMs: 1 });
  await first.close();
  // pastDue expired while nothing was running; stillOpen expires later.
  await pause(20);
  const second = open();
  const waiting = await second.call("spawn", {
    agentId: "demo",
    prompt: "never runs",
    waitsOnDecisions: [stillOpen.decisionId],
  });
  // No call touches the decisions from here: only a restored timer can expire them.
  await until(
    () => second.store.state.decisions[pastDue.decisionId].status,
    (status) => status === "expired",
  );
  await until(
    () => second.store.state.decisions[stillOpen.decisionId].status,
    (status) => status === "expired",
  );
  assert.match((await waitStatus(second, waiting, "failed")).summary, /was expired/);
  assert.ok(second.store.state.events.some(
    (e) => e.type === "decision.expired" && e.decisionId === stillOpen.decisionId,
  ));
});
