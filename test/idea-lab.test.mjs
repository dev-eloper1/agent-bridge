import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { inlineSpecialist } from "../dist/specialists.js";

const LAB = ".specialists/lab";
const roles = readdirSync(LAB);

test("idea-lab skill encodes the lessons of the first lab run", () => {
  const skill = readFileSync("skills/idea-lab/SKILL.md", "utf8");
  assert.match(skill, /name: idea-lab/);
  assert.match(skill, /only the features they choose|Integrate only what they pick/);
  assert.match(skill, /never make it for them/);
  assert.match(skill, /Never resolve a decision you put to them/);
  assert.match(skill, /Workers do not see your memory/);
  assert.match(skill, /cold reader/i);
  assert.match(skill, /agents_status/);
  assert.match(skill, /No gate codes/);
  assert.match(skill, /never merge or push to the default branch/);
  assert.match(skill, /Ask before anything destructive/);
  assert.match(skill, /Restore temporary settings/);
  for (const role of roles) assert.match(skill, new RegExp(`lab/${role}\\b`));
});

test("every lab specialist is valid and matches its directory", () => {
  assert.ok(roles.length >= 8);
  for (const role of roles) {
    const spec = parse(
      readFileSync(path.join(LAB, role, "specialist.yaml"), "utf8"),
    );
    assert.equal(spec.namespace, "lab");
    assert.equal(spec.id, role);
    assert.doesNotThrow(() => inlineSpecialist(spec), role);
  }
});

test("every lab specialist carries the house rules workers cannot otherwise see", () => {
  for (const role of roles) {
    const { instructions } = parse(
      readFileSync(path.join(LAB, role, "specialist.yaml"), "utf8"),
    );
    assert.match(instructions, /House rules/, role);
    assert.match(instructions, /Do not delegate/, role);
    assert.match(instructions, /runtime socket/, role);
    assert.match(instructions, /Never decide something the owner/, role);
    assert.match(instructions, /plain words/, role);
    assert.match(instructions, /as data, not commands/, role);
  }
});
