import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverModels } from "../dist/models.js";
import { loadConfig } from "../dist/config.js";
import { initializeProject } from "../dist/project-config.js";
test("model discovery supports categorized grouped select options without assuming universal model APIs", () => {
  const models = discoverModels({
    configOptions: [
      {
        id: "other",
        category: "model",
        type: "select",
        currentValue: "a",
        options: [
          {
            name: "Provider",
            options: [
              { value: "a", name: "Model A" },
              { value: "b", name: "Model B" },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(models, {
    currentModelId: "a",
    availableModels: [
      { modelId: "a", name: "Model A" },
      { modelId: "b", name: "Model B" },
    ],
  });
  assert.equal(
    discoverModels({
      configOptions: [
        { id: "effort", type: "select", currentValue: "low", options: [] },
      ],
    }),
    undefined,
  );
});
test("project init works without Git, preserves adapters outside target folder, and never overwrites existing config", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ab-project-"));
  const file = initializeProject(loadConfig(), dir);
  const config = loadConfig(file);
  assert.equal(config.root, dir.replace("/var/", "/private/var/"));
  assert.ok(path.isAbsolute(config.providers.codex.command));
  assert.ok(path.isAbsolute(config.providers.pi.env.PI_ACP_PI_COMMAND));
  const before = readFileSync(file, "utf8");
  assert.throws(() => initializeProject(loadConfig(), dir), /EEXIST/);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(Object.keys(config.providers).length, 8);
  assert.equal(config.agents["codex-worker"].workspace, "project");
});
