import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSessionSettings,
  validateSessionSetting,
} from "../dist/session-settings.js";
test("modern ids, configIds, grouped choices, booleans, categories and order normalize", () => {
  const options = normalizeSessionSettings({
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        description: "Execution mode",
        category: "safety",
        type: "select",
        currentValue: "ask",
        options: [
          { value: "ask", name: "Ask", description: "Ask first" },
          { value: "bypass", name: "Bypass" },
        ],
      },
      {
        configId: "review",
        name: "Review",
        currentValue: "off",
        options: [
          {
            group: "levels",
            name: "Levels",
            options: [
              { value: "off", name: "Off" },
              {
                group: "deeper",
                options: [{ value: "strict", name: "Strict" }],
              },
            ],
          },
        ],
      },
      {
        id: "telemetry",
        name: "Telemetry",
        type: "boolean",
        currentValue: false,
      },
    ],
  });
  assert.deepEqual(
    options.map((o) => o.id),
    ["mode", "review", "telemetry"],
  );
  assert.deepEqual(
    options.map((o) => o.source),
    ["config_option", "config_option", "config_option"],
  );
  assert.equal(options[0].category, "safety");
  assert.equal(options[0].description, "Execution mode");
  assert.equal(options[0].choices[0].description, "Ask first");
  assert.deepEqual(
    options[1].choices.map((c) => c.value),
    ["off", "strict"],
    "grouped and nested choices flatten in provider order",
  );
  assert.equal(options[2].type, "boolean");
});
test("legacy modes normalize only when no modern mode option exists", () => {
  const modes = {
    currentModeId: "ask",
    availableModes: [
      { id: "ask", name: "Ask" },
      { id: "bypass", name: "Bypass" },
    ],
  };
  const legacy = normalizeSessionSettings({ modes });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].id, "mode");
  assert.equal(legacy[0].category, "mode");
  assert.equal(legacy[0].source, "legacy_mode");
  assert.equal(legacy[0].currentValue, "ask");
  assert.deepEqual(
    legacy[0].choices.map((c) => c.value),
    ["ask", "bypass"],
  );
  const modern = normalizeSessionSettings({
    modes,
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        currentValue: "ask",
        options: [{ value: "ask" }, { value: "bypass" }],
      },
    ],
  });
  assert.equal(modern.length, 1);
  assert.equal(modern[0].source, "config_option");
  const categorized = normalizeSessionSettings({
    modes,
    configOptions: [
      {
        id: "other",
        category: "mode",
        currentValue: "x",
        options: [{ value: "x" }],
      },
    ],
  });
  assert.equal(
    categorized.length,
    1,
    "a modern option in the mode category also suppresses legacy",
  );
});
test("malformed options and choices are skipped without discarding the catalog", () => {
  const options = normalizeSessionSettings({
    configOptions: [
      null,
      "junk",
      { name: "no identifier" },
      { id: "x".repeat(150), name: "oversized id" },
      {
        id: "ok",
        name: "Ok",
        currentValue: "a",
        options: [
          null,
          { name: "no value" },
          { value: "a" },
          { options: [{ value: "b" }] },
        ],
      },
    ],
  });
  assert.deepEqual(
    options.map((o) => o.id),
    ["ok"],
  );
  assert.deepEqual(
    options[0].choices.map((c) => c.value),
    ["a", "b"],
  );
});
test("options are only accepted with real state and IDs dedupe first-wins", () => {
  const options = normalizeSessionSettings({
    configOptions: [
      { id: "bool-missing", type: "boolean" },
      { id: "bool-string", type: "boolean", currentValue: "yes" },
      { id: "select-missing", type: "select", options: [{ value: "a" }] },
      {
        id: "select-empty",
        type: "select",
        currentValue: "a",
        options: [null, { name: "no value" }],
      },
      { id: "future", type: "custom", currentValue: "x" },
      { id: "flag", currentValue: true },
      { id: "flag", name: "Duplicate", currentValue: false },
    ],
  });
  assert.deepEqual(
    options.map((o) => o.id),
    ["flag"],
    "missing or mistyped state never invents an option",
  );
  assert.equal(
    options[0].currentValue,
    true,
    "the first valid occurrence wins",
  );
});
test("legacy mode requires a valid current mode among its choices", () => {
  assert.equal(
    normalizeSessionSettings({
      modes: { availableModes: [{ id: "ask" }, { id: "bypass" }] },
    }).length,
    0,
    "no currentModeId invents a mode",
  );
  assert.equal(
    normalizeSessionSettings({
      modes: {
        currentModeId: "turbo",
        availableModes: [{ id: "ask" }, { id: "bypass" }],
      },
    }).length,
    0,
    "an unknown current mode is skipped, not replaced with the first choice",
  );
  const described = normalizeSessionSettings({
    modes: {
      currentModeId: "ask",
      availableModes: [
        { id: "ask", name: "Ask", description: "Confirm each action" },
        { id: "bypass" },
      ],
    },
  });
  assert.equal(described[0].choices[0].description, "Confirm each action");
});
test("bounds drop oversized fields and cap option and choice counts", () => {
  const options = normalizeSessionSettings({
    configOptions: [
      {
        id: "bounded",
        name: "n".repeat(200),
        description: "d".repeat(600),
        currentValue: "v",
        options: Array.from({ length: 150 }, (_, i) => ({
          value: `v${i}`,
        })),
      },
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `extra-${i}`,
        currentValue: "x",
        options: [{ value: "x" }],
      })),
    ],
  });
  assert.equal(options.length, 50);
  assert.equal(options[0].name, "bounded", "oversized names fall back to id");
  assert.equal(
    options[0].description,
    undefined,
    "oversized descriptions drop",
  );
  assert.equal(options[0].choices.length, 100);
});
test("validateSessionSetting enforces exact option, value and type", () => {
  const options = normalizeSessionSettings({
    configOptions: [
      {
        id: "mode",
        currentValue: "ask",
        options: [{ value: "ask" }, { value: "bypass" }],
      },
      { id: "telemetry", type: "boolean", currentValue: false },
    ],
  });
  assert.equal(validateSessionSetting(options, "mode", "bypass").id, "mode");
  assert.equal(
    validateSessionSetting(options, "telemetry", true).type,
    "boolean",
  );
  assert.throws(
    () => validateSessionSetting(options, "ghost", "x"),
    /not advertised.*mode, telemetry/,
  );
  assert.throws(
    () => validateSessionSetting(options, "mode", "nope"),
    /must be one of: ask, bypass/,
  );
  assert.throws(
    () => validateSessionSetting(options, "mode", true),
    /must be one of/,
  );
  assert.throws(
    () => validateSessionSetting(options, "telemetry", "true"),
    /expects a boolean/,
  );
});
