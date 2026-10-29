import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activate, consider, draft, validate } from "../src/lifecycle.ts";
import { SkillStore } from "../src/store.ts";
import {
  candidate,
  document,
  validation,
  useEvidence,
  nextTask,
  reusableSkill,
} from "./fixtures.ts";

async function fixture(t: test.TestContext) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-failures-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const cwd = path.join(temp, "work");
  const agent = path.join(temp, "agent");
  await fs.mkdir(cwd);
  return { cwd, agent, store: new SkillStore(agent) };
}

test("failed publication preserves the old file and can be retried without user approval", async (t) => {
  const { cwd, store } = await fixture(t);
  const skill = await store.consider(candidate, cwd);
  await store.draft(skill.id, cwd, document);
  await store.validate(skill.id, cwd, validation, "s");
  await store.recordUse(skill.id, cwd, useEvidence, nextTask());
  const file = store.skillPath(skill, cwd);
  const original = await fs.readFile(file, "utf8");
  await store.draft(skill.id, cwd, {
    ...document,
    steps: ["Retry-safe new procedure."],
  });
  const rename = fs.rename;
  let failing = true;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === file && failing)
      throw new Error("Injected publication failure.");
    return rename(...args);
  });
  await assert.rejects(
    store.validate(skill.id, cwd, validation, "s"),
    /Injected publication failure/,
  );
  assert.equal(await fs.readFile(file, "utf8"), original);
  assert.equal((await store.get(skill.id, cwd)).activeRevision, 1);
  assert.deepEqual(await store.discoveryPaths(cwd), [file]);
  assert.deepEqual(
    (await fs.readdir(path.dirname(file))).filter((name) =>
      name.endsWith(".tmp"),
    ),
    [],
  );
  failing = false;
  await store.validate(skill.id, cwd, validation, "s");
  assert.match(await fs.readFile(file, "utf8"), /Retry-safe new procedure/);
});
for (const layout of ["directory", "standalone"] as const) {
  test(`legacy migration cannot shadow an existing native ${layout} skill`, async (t) => {
    const { cwd, agent, store } = await fixture(t);
    const skill = activate(reusableSkill(cwd));
    const { generation: _generation, ...legacy } = skill;
    const source = path.join(agent, "pi-skills", "catalog.json");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(
      source,
      JSON.stringify({ version: 1, skills: [legacy] }),
    );
    const file =
      layout === "directory"
        ? path.join(cwd, ".pi", "skills", candidate.name, "SKILL.md")
        : path.join(cwd, ".pi", "skills", `${candidate.name}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "manual external procedure");
    await assert.rejects(store.migrateLegacy(cwd), /unmanaged/);
    assert.equal(await fs.readFile(file, "utf8"), "manual external procedure");
    assert.deepEqual(await store.list(cwd), []);
  });
}
test("manually removed skills are not recreated during discovery", async (t) => {
  const { cwd, store } = await fixture(t);
  const skill = await store.consider(candidate, cwd);
  await store.draft(skill.id, cwd, document);
  await store.validate(skill.id, cwd, validation, "s");
  await store.recordUse(skill.id, cwd, useEvidence, nextTask());
  const file = store.skillPath(skill, cwd);
  await fs.unlink(file);
  assert.deepEqual(await store.discoveryPaths(cwd), []);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});
