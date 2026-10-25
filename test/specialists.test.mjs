import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  catalogRoots,
  pluginRoot,
  resolveSpecialist,
  inlineSpecialist,
  listSpecialists,
  validateSpecialistBinding,
} from "../dist/specialists.js";
import { loadConfig, schema } from "../dist/config.js";
import { Runtime } from "../dist/runtime.js";
const baseSpec = {
  format: 1,
  namespace: "hivemind",
  id: "triage-investigator",
  name: "Triage investigator",
  version: "1.0.0",
  description: "Investigates local KB and source files",
  instructions: "SPEC_INSTRUCTIONS",
  delivery: "task-instructions",
  acceptanceCriteria: ["Return one bounded finding"],
};
function fixture(specialistCatalogs = {}) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "ab-specialists-")),
  );
  const team = path.join(root, "team-catalog");
  const file = path.join(root, "agents.yaml");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      runtime: {
        stateDir: ".agent-bridge",
        maxRuntimeMs: 5000,
        maxInlineChars: 6000,
      },
      providers: {
        mock: {
          command: process.execPath,
          args: [path.resolve("scripts/mock-acp.mjs")],
          env: { MOCK_STATE: path.join(root, "mock") },
          readOnlyEnforced: true,
        },
        other: { command: process.execPath, args: ["--version"] },
      },
      agents: { worker: { provider: "mock", description: "Fixture" } },
      specialistCatalogs,
    }),
  );
  return { root, team, file, config: loadConfig(file) };
}
function persist(catalogRoot, definition) {
  const specDir = path.join(
    catalogRoot,
    definition.namespace,
    definition.id,
  );
  mkdirSync(specDir, { recursive: true });
  const source = path.join(specDir, "specialist.yaml");
  writeFileSync(source, JSON.stringify(definition));
  return source;
}
const project = (f, definition) =>
  persist(path.join(f.root, ".specialists"), definition);
async function finish(runtime, args) {
  const task = await runtime.call("spawn", {
    agentId: "worker",
    prompt: "Investigate fixture",
    ...args,
  });
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const result = await runtime.call("result", {
      taskId: task.taskId,
      maxChars: 6000,
    });
    if (
      ["completed", "failed", "cancelled", "timed_out"].includes(result.status)
    )
      return result;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Task did not finish");
}
test("catalog roots cover project, global and configured paths; reserved names fail", () => {
  const f = fixture({ team: { path: "team-catalog" } });
  const roots = catalogRoots(f.config);
  assert.equal(roots.project, path.join(f.root, ".specialists"));
  assert.equal(roots.global, path.join(homedir(), ".specialists"));
  assert.equal(roots.team, path.join(f.root, "team-catalog"));
  const raw = JSON.parse(readFileSync(f.file));
  for (const reserved of ["project", "global", "plugin", "inline"]) {
    raw.specialistCatalogs = { [reserved]: { path: "x" } };
    assert.throws(() => schema.parse(raw), /reserved/, reserved);
  }
  delete raw.specialistCatalogs;
  assert.deepEqual(schema.parse(raw).specialistCatalogs, {});
});
test("project and configured specialists resolve; ambiguity and path mismatch fail closed", () => {
  const f = fixture({ team: { path: "team-catalog" } });
  project(f, baseSpec);
  const snapshot = resolveSpecialist(f.config, "hivemind/triage-investigator");
  assert.equal(snapshot.catalog, "project");
  assert.equal(snapshot.reference, "project:hivemind/triage-investigator");
  assert.equal(snapshot.instructions, "SPEC_INSTRUCTIONS");
  persist(f.team, {
    ...baseSpec,
    version: "2.0.0",
    instructions: "TEAM_INSTRUCTIONS",
  });
  assert.throws(
    () => resolveSpecialist(f.config, "hivemind/triage-investigator"),
    /project:hivemind\/triage-investigator or team:hivemind\/triage-investigator/,
  );
  assert.equal(
    resolveSpecialist(f.config, "team:hivemind/triage-investigator")
      .instructions,
    "TEAM_INSTRUCTIONS",
  );
  assert.throws(
    () => resolveSpecialist(f.config, "missing:hivemind/triage-investigator"),
    /Unknown specialist catalog/,
  );
  assert.throws(
    () => resolveSpecialist(f.config, "team:hivemind/none"),
    /not found/,
  );
  const mismatched = path.join(
    f.root,
    ".specialists",
    "hivemind",
    "renamed",
  );
  mkdirSync(mismatched, { recursive: true });
  writeFileSync(
    path.join(mismatched, "specialist.yaml"),
    JSON.stringify(baseSpec),
  );
  assert.throws(
    () => resolveSpecialist(f.config, "project:hivemind/renamed"),
    /match its directory/,
  );
  assert.throws(() =>
    resolveSpecialist(f.config, "project:../triage-investigator"),
  );
  assert.throws(() =>
    resolveSpecialist(f.config, "project:hivemind/../triage-investigator"),
  );
});
test("plugin catalog defaults to the install root and resolves from any project", async () => {
  const f = fixture({ team: { path: "team-catalog" } });
  assert.equal(pluginRoot, path.resolve("./") + path.sep);
  assert.equal(catalogRoots(f.config).plugin, path.resolve(".specialists"));
  f.config.pluginRoot = path.join(f.root, "plugin-install");
  assert.equal(
    catalogRoots(f.config).plugin,
    path.join(f.root, "plugin-install", ".specialists"),
  );
  persist(path.join(f.config.pluginRoot, ".specialists"), {
    ...baseSpec,
    namespace: "lab",
    id: "queen",
    instructions: "PLUGIN_INSTRUCTIONS",
  });
  const snapshot = resolveSpecialist(f.config, "lab/queen");
  assert.equal(snapshot.catalog, "plugin");
  assert.equal(snapshot.reference, "plugin:lab/queen");
  assert.equal(snapshot.instructions, "PLUGIN_INSTRUCTIONS");
  assert.equal(
    resolveSpecialist(f.config, "plugin:lab/queen").digest,
    snapshot.digest,
  );
  const runtime = new Runtime(f.config);
  try {
    const listed = await runtime.call("specialists_catalog", {});
    const entry = listed.find((e) => e.reference === "plugin:lab/queen");
    assert.equal(entry.catalog, "plugin");
    assert.equal(entry.instructions, undefined);
    const contract = await runtime.call("specialists_schema", {});
    assert.ok(contract.locations.reservedNames.includes("plugin"));
    assert.equal(
      contract.availableCatalogs.plugin,
      path.join(f.config.pluginRoot, ".specialists"),
    );
  } finally {
    runtime.close();
  }
  persist(f.team, { ...baseSpec, namespace: "lab", id: "queen" });
  assert.throws(
    () => resolveSpecialist(f.config, "lab/queen"),
    /plugin:lab\/queen or team:lab\/queen/,
  );
  assert.equal(
    resolveSpecialist(f.config, "plugin:lab/queen").instructions,
    "PLUGIN_INSTRUCTIONS",
  );
  assert.equal(
    resolveSpecialist(f.config, "team:lab/queen").instructions,
    "SPEC_INSTRUCTIONS",
  );
});
test("a project that is the plugin checkout shares one catalog without ambiguity", () => {
  const f = fixture();
  f.config.pluginRoot = f.root;
  project(f, { ...baseSpec, namespace: "lab", id: "queen" });
  const snapshot = resolveSpecialist(f.config, "lab/queen");
  assert.equal(snapshot.reference, "project:lab/queen");
  assert.equal(resolveSpecialist(f.config, "plugin:lab/queen").catalog, "plugin");
  const entries = listSpecialists(f.config).filter(
    (e) => e.namespace === "lab" && e.id === "queen",
  );
  assert.deepEqual(
    entries.map((e) => e.reference),
    ["project:lab/queen"],
  );
  // A symlinked path to the same folder is still the same catalog.
  const link = path.join(f.root, "linked-install");
  symlinkSync(f.root, link);
  f.config.pluginRoot = link;
  assert.equal(
    resolveSpecialist(f.config, "lab/queen").reference,
    "project:lab/queen",
  );
});
test("redirected, oversized, malformed and unknown-field specialists fail closed without hiding valid entries", () => {
  const f = fixture();
  project(f, baseSpec);
  const catalogRoot = path.join(f.root, ".specialists");
  writeFileSync(path.join(catalogRoot, "catalog.yaml"), "name: fixture");
  const bad = (id, content) => {
    mkdirSync(path.join(catalogRoot, "bad", id), { recursive: true });
    writeFileSync(path.join(catalogRoot, "bad", id, "specialist.yaml"), content);
  };
  bad(
    "unknown-field",
    JSON.stringify({
      ...baseSpec,
      namespace: "bad",
      id: "unknown-field",
      hooks: {},
    }),
  );
  bad("malformed", "not: [valid");
  bad("oversized", "x".repeat(33000));
  const outside = path.join(f.root, "outside.yaml");
  writeFileSync(
    outside,
    JSON.stringify({ ...baseSpec, namespace: "bad", id: "linked" }),
  );
  mkdirSync(path.join(catalogRoot, "bad", "linked"), { recursive: true });
  symlinkSync(
    outside,
    path.join(catalogRoot, "bad", "linked", "specialist.yaml"),
  );
  const entries = listSpecialists(f.config);
  const valid = entries.find(
    (e) => e.catalog === "project" && e.id === "triage-investigator",
  );
  assert.ok(valid);
  assert.equal(valid.instructions, undefined);
  assert.equal(valid.acceptanceCriteriaCount, 1);
  const errors = entries.filter(
    (e) => e.error && (!e.catalog || e.catalog === "project" || e.reference?.startsWith("project:")),
  );
  assert.equal(errors.length, 4);
  for (const reference of [
    "project:bad/unknown-field",
    "project:bad/malformed",
    "project:bad/oversized",
    "project:bad/linked",
  ])
    assert.throws(() => resolveSpecialist(f.config, reference));
  symlinkSync(
    path.join(catalogRoot, "hivemind"),
    path.join(catalogRoot, "alias"),
  );
  assert.throws(
    () => resolveSpecialist(f.config, "project:alias/triage-investigator"),
    /Unsafe/,
  );
});
test("binding validation rejects incompatible providers and unenforced read-only", () => {
  const f = fixture();
  project(f, {
    ...baseSpec,
    requiresReadOnly: true,
    providers: ["mock"],
  });
  const snapshot = resolveSpecialist(
    f.config,
    "project:hivemind/triage-investigator",
  );
  assert.match(
    validateSpecialistBinding(snapshot, f.config, "worker").toolPolicy,
    /read-only/,
  );
  f.config.providers.mock.readOnlyEnforced = false;
  assert.throws(
    () => validateSpecialistBinding(snapshot, f.config, "worker"),
    /requires provider-enforced/,
  );
  f.config.agents.worker.provider = "other";
  assert.throws(
    () => validateSpecialistBinding(snapshot, f.config, "worker"),
    /does not support/,
  );
});
test("catalog lists, queries, inspects and reports binding compatibility", async () => {
  const f = fixture({ team: { path: "team-catalog" } });
  project(f, baseSpec);
  persist(f.team, {
    ...baseSpec,
    namespace: "docs",
    id: "style-checker",
    name: "Style checker",
    description: "Checks documentation style",
    providers: ["nope"],
  });
  const runtime = new Runtime(f.config);
  try {
    const all = await runtime.call("specialists_catalog", {});
    const fixtureEntries = all.filter(
      (e) => !e.error && (e.catalog === "project" || e.catalog === "team"),
    );
    assert.equal(fixtureEntries.length, 2);
    const found = await runtime.call("specialists_catalog", { query: "TRIAGE" });
    assert.ok(
      found.some(
        (e) => e.reference === "project:hivemind/triage-investigator",
      ),
    );
    const foundEntry = found.find(
      (e) => e.reference === "project:hivemind/triage-investigator",
    );
    assert.equal(foundEntry.instructions, undefined);
    const exact = await runtime.call("specialists_catalog", {
      reference: "team:docs/style-checker",
      agentId: "worker",
    });
    assert.equal(exact.instructions, "SPEC_INSTRUCTIONS");
    assert.match(exact.bindingError, /does not support/);
    const compatible = await runtime.call("specialists_catalog", {
      reference: "hivemind/triage-investigator",
      agentId: "worker",
    });
    assert.equal(compatible.bindingError, undefined);
    assert.equal(compatible.binding.delivery, "task-instructions");
    const bound = await runtime.call("specialists_catalog", {
      agentId: "worker",
    });
    const incompatible = bound.find(
      (e) => e.catalog === "team" && e.id === "style-checker",
    );
    assert.match(incompatible.bindingError, /does not support/);
    await assert.rejects(
      runtime.call("specialists_catalog", { agentId: "ghost" }),
    );
    await assert.rejects(
      runtime.call("specialists_catalog", { reference: "hivemind/unknown" }),
      /not found/,
    );
  } finally {
    runtime.close();
  }
});
test("schema returns the authoring contract, actual catalog roots and validate writes nothing", async () => {
  const f = fixture({ team: { path: "team-catalog" } });
  const runtime = new Runtime(f.config);
  try {
    const contract = await runtime.call("specialists_schema", {});
    assert.ok(contract.specialistSpec.required.namespace);
    assert.match(contract.specialistSpec.required.delivery, /task-instructions/);
    assert.match(contract.specialistSpec.prohibited, /never|no commands/);
    assert.match(contract.locations.project, /\.specialists\//);
    assert.ok(contract.locations.reservedNames.includes("inline"));
    assert.equal(
      contract.availableCatalogs.project,
      path.join(f.root, ".specialists"),
    );
    assert.equal(
      contract.availableCatalogs.global,
      path.join(homedir(), ".specialists"),
    );
    assert.equal(
      contract.availableCatalogs.team,
      path.join(f.root, "team-catalog"),
    );
    const validated = await runtime.call("specialists_validate", {
      specialistSpec: baseSpec,
      agentId: "worker",
    });
    assert.equal(validated.reference, "inline:hivemind/triage-investigator");
    assert.equal(validated.catalog, "inline");
    assert.match(validated.digest, /^[a-f0-9]{64}$/);
    assert.equal(validated.instructions, undefined);
    assert.equal(validated.binding.delivery, "task-instructions");
    const incompatible = await runtime.call("specialists_validate", {
      specialistSpec: { ...baseSpec, providers: ["nope"] },
      agentId: "worker",
    });
    assert.match(incompatible.bindingError, /does not support/);
    await assert.rejects(
      runtime.call("specialists_validate", {
        specialistSpec: baseSpec,
        agentId: "ghost",
      }),
      /Unknown agent/,
    );
    await assert.rejects(
      runtime.call("specialists_validate", {
        specialistSpec: { ...baseSpec, model: "opus" },
      }),
    );
    assert.equal(existsSync(path.join(f.root, ".specialists")), false);
    assert.equal(
      existsSync(path.join(f.root, ".agent-bridge", "agents")),
      false,
    );
  } finally {
    runtime.close();
  }
});
test("inline specialistSpec validates to an inline snapshot", () => {
  const snapshot = inlineSpecialist(baseSpec);
  assert.equal(snapshot.catalog, "inline");
  assert.equal(snapshot.reference, "inline:hivemind/triage-investigator");
  assert.equal(snapshot.source, "inline");
  assert.equal(snapshot.digest, inlineSpecialist({ ...baseSpec }).digest);
  assert.throws(() => inlineSpecialist({ ...baseSpec, extra: 1 }));
});
test("specialistRef execution pins the spec, merges criteria and survives edits and restart", async () => {
  const f = fixture();
  const source = project(f, baseSpec);
  let runtime = new Runtime(f.config);
  try {
    const first = await finish(runtime, {
      specialistRef: "hivemind/triage-investigator",
      prompt: "Investigate this case",
      acceptanceCriteria: ["Task-specific criterion"],
    });
    assert.equal(first.status, "completed");
    assert.equal(
      first.specialist.reference,
      "project:hivemind/triage-investigator",
    );
    assert.equal(first.specialist.version, "1.0.0");
    assert.equal(first.specialist.catalog, "project");
    assert.equal(first.template, undefined);
    assert.match(first.output, /SPEC_INSTRUCTIONS/);
    assert.equal(first.acceptanceCriteriaCount, 2);
    const transcript = runtime.store.readArtifactText(
      first.taskId,
      "transcript.jsonl",
    );
    const prompt = transcript
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .find((x) => x.type === "coordinator.prompt");
    assert.match(prompt.text, /hivemind\/triage-investigator@1\.0\.0/);
    assert.ok(
      prompt.text.indexOf("Return one bounded finding") <
        prompt.text.indexOf("Task-specific criterion"),
    );
    writeFileSync(
      source,
      JSON.stringify({
        ...baseSpec,
        version: "2.0.0",
        instructions: "CHANGED_INSTRUCTIONS",
      }),
    );
    await assert.rejects(
      runtime.call("spawn", {
        agentId: "worker",
        prompt: "Follow up",
        specialistRef: "hivemind/triage-investigator",
        agentSessionId: first.agentSessionId,
      }),
      /pinned/,
    );
    await assert.rejects(
      runtime.call("spawn", {
        agentId: "worker",
        prompt: "Follow up",
        specialistRef: "global:hivemind/triage-investigator",
        agentSessionId: first.agentSessionId,
      }),
      /pinned|differs|not found/,
    );
    unlinkSync(source);
    runtime.close();
    runtime = new Runtime(f.config);
    const next = await finish(runtime, {
      agentSessionId: first.agentSessionId,
      prompt: "Follow up after restart",
    });
    assert.equal(next.status, "completed");
    assert.equal(next.specialist.digest, first.specialist.digest);
    assert.match(next.output, /SPEC_INSTRUCTIONS/);
    assert.doesNotMatch(next.output, /CHANGED_INSTRUCTIONS/);
  } finally {
    runtime.close();
  }
});
test("inline specialistSpec executes, pins and survives restart without touching the filesystem", async () => {
  const f = fixture();
  let runtime = new Runtime(f.config);
  try {
    const first = await finish(runtime, {
      specialistSpec: baseSpec,
      prompt: "Investigate this case",
      acceptanceCriteria: ["Task-specific criterion"],
    });
    assert.equal(first.status, "completed");
    assert.equal(
      first.specialist.reference,
      "inline:hivemind/triage-investigator",
    );
    assert.equal(first.specialist.catalog, "inline");
    assert.match(first.output, /SPEC_INSTRUCTIONS/);
    assert.equal(first.acceptanceCriteriaCount, 2);
    assert.equal(existsSync(path.join(f.root, ".specialists")), false);
    await assert.rejects(
      runtime.call("spawn", {
        agentId: "worker",
        prompt: "Follow up",
        specialistSpec: { ...baseSpec, instructions: "CHANGED" },
        agentSessionId: first.agentSessionId,
      }),
      /pinned/,
    );
    await assert.rejects(
      runtime.call("spawn", {
        agentId: "worker",
        prompt: "Follow up",
        specialistRef: "hivemind/triage-investigator",
        agentSessionId: first.agentSessionId,
      }),
      /pinned|differs|not found/,
    );
    runtime.close();
    runtime = new Runtime(f.config);
    const next = await finish(runtime, {
      agentSessionId: first.agentSessionId,
      prompt: "Follow up after restart",
    });
    assert.equal(next.status, "completed");
    assert.equal(next.specialist.digest, first.specialist.digest);
    assert.match(next.output, /SPEC_INSTRUCTIONS/);
  } finally {
    runtime.close();
  }
});
test("exactly one of template, specialistRef and specialistSpec is accepted", async () => {
  const f = fixture();
  project(f, baseSpec);
  const runtime = new Runtime(f.config);
  try {
    const pairs = [
      {
        specialistRef: "hivemind/triage-investigator",
        specialistSpec: baseSpec,
      },
      { specialistRef: "hivemind/triage-investigator", template: "reviewer" },
      { specialistSpec: baseSpec, template: "reviewer" },
      {
        specialistRef: "hivemind/triage-investigator",
        specialistSpec: baseSpec,
        template: "reviewer",
      },
    ];
    for (const extra of pairs)
      await assert.rejects(
        runtime.call("spawn", { agentId: "worker", prompt: "x", ...extra }),
        /exactly one/,
      );
  } finally {
    runtime.close();
  }
});
test("listing stays bounded at one hundred specialist directories per catalog", () => {
  const f = fixture();
  for (let i = 0; i < 105; i++)
    project(f, {
      ...baseSpec,
      namespace: "bulk",
      id: `agent-${String(i).padStart(3, "0")}`,
    });
  const entries = listSpecialists(f.config);
  assert.equal(
    entries.filter((e) => !e.error && e.catalog === "project").length,
    100,
  );
  assert.ok(entries.some((e) => /maximum 100/.test(e.error ?? "")));
});

test("specialize skill encodes the approved authoring contract", () => {
  const skill = readFileSync("skills/specialize/SKILL.md", "utf8");
  assert.match(skill, /name: specialize/);
  assert.match(skill, /for this task|one-off|ephemeral/i);
  assert.match(skill, /availableCatalogs/);
  assert.match(skill, /specialists_validate/);
  assert.match(skill, /explicit confirmation/);
  assert.match(skill, /entire ecosystem|whole.*catalog/i);
  assert.match(skill, /whole destructive operation/);
  assert.match(skill, /ambiguous request/);
  assert.match(skill, /never writes|never write/i);
  assert.match(skill, /never claim.*enforce permissions/i);
});
