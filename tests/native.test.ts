import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillStore, projectRoot } from "../src/store.ts";
import { candidate, document, validation } from "./fixtures.ts";

async function fixture(t: test.TestContext) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-native-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const cwd = path.join(temp, "work");
  const agent = path.join(temp, "agent");
  await fs.mkdir(cwd);
  return { cwd, agent, store: new SkillStore(agent) };
}

test("passing validation publishes project skills automatically in the session cwd", async (t) => {
  const { cwd, store } = await fixture(t);
  const skill = await store.consider(candidate, cwd);
  assert.equal(skill.id, `project:${candidate.name}`);
  await store.draft(skill.id, cwd, document);
  const checked = await store.validate(
    skill.id,
    cwd,
    validation,
    "native-test",
  );
  assert.equal(checked.status, "active");
  const file = path.join(cwd, ".pi", "skills", candidate.name, "SKILL.md");
  assert.match(await fs.readFile(file, "utf8"), /pi-skills-generated:/);
  assert.deepEqual(await store.discoveryPaths(cwd), [file]);
});
test("global skills use the native agent skills directory", async (t) => {
  const { cwd, agent, store } = await fixture(t);
  const skill = await store.consider({ ...candidate, scope: "global" }, cwd);
  await store.draft(skill.id, cwd, document);
  await store.validate(skill.id, cwd, validation, "native-test");
  assert.ok(
    await fs.stat(path.join(agent, "skills", candidate.name, "SKILL.md")),
  );
});
test("project scope uses cwd rather than walking up to the Git root", async (t) => {
  const { cwd } = await fixture(t);
  await fs.mkdir(path.join(cwd, ".git"));
  const nested = path.join(cwd, "nested");
  await fs.mkdir(nested);
  assert.equal(await projectRoot(nested), nested);
});
test("existing unmarked skill folders cannot be claimed", async (t) => {
  const { cwd, store } = await fixture(t);
  const folder = path.join(cwd, ".pi", "skills", candidate.name);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "SKILL.md"), "manual procedure");
  await assert.rejects(
    store.consider(candidate, cwd),
    /unmanaged|existing|already/i,
  );
  assert.equal(
    await fs.readFile(path.join(folder, "SKILL.md"), "utf8"),
    "manual procedure",
  );
});
