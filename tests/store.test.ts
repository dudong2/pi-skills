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
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-store-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const agent = path.join(temp, "agent");
  const cwd = path.join(temp, "work");
  await fs.mkdir(cwd);
  return { temp, agent, cwd, store: new SkillStore(agent) };
}
async function ready(store: SkillStore, cwd: string) {
  const skill = await store.consider(candidate, cwd);
  await store.draft(skill.id, cwd, document);
  await store.validate(skill.id, cwd, validation, "session-1");
  return store.recordUse(skill.id, cwd, useEvidence, nextTask());
}

test("malformed metadata fails closed and remains byte-identical", async (t) => {
  const { cwd, store } = await fixture(t);
  const file = store.catalogPath(cwd, "project");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{broken");
  await assert.rejects(
    store.consider(candidate, cwd),
    /Malformed skill metadata.*repair or restore/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
});
test("metadata and ownership survive reload", async (t) => {
  const { agent, cwd, store } = await fixture(t);
  const skill = await ready(store, cwd);
  const reloaded = await new SkillStore(agent).get(skill.id, cwd);
  assert.equal(reloaded.generation, skill.generation);
  assert.equal(reloaded.revisions[0].validation?.sessionId, "session-1");
});
test("only validated versions are published, with no approval or extra activation step", async (t) => {
  const { cwd, store } = await fixture(t);
  const skill = await store.consider(candidate, cwd);
  assert.deepEqual(await store.discoveryPaths(cwd), []);
  await store.draft(skill.id, cwd, document);
  assert.deepEqual(await store.discoveryPaths(cwd), []);
  await store.validate(skill.id, cwd, validation, "s");
  assert.deepEqual(await store.discoveryPaths(cwd), []);
  await store.recordUse(skill.id, cwd, useEvidence, nextTask());
  const [file] = await store.discoveryPaths(cwd);
  const old = await fs.readFile(file, "utf8");
  await store.draft(skill.id, cwd, {
    ...document,
    steps: ["A revised procedure."],
  });
  assert.equal(await fs.readFile(file, "utf8"), old);
  await store.validate(skill.id, cwd, validation, "s");
  assert.match(await fs.readFile(file, "utf8"), /A revised procedure/);
});
test("failed validation does not publish or replace the old active file", async (t) => {
  const { cwd, store } = await fixture(t);
  const skill = await ready(store, cwd);
  const file = store.skillPath(skill, cwd);
  const old = await fs.readFile(file, "utf8");
  await store.draft(skill.id, cwd, {
    ...document,
    steps: ["Unverified procedure."],
  });
  const failed = {
    ...validation,
    checks: [{ ...validation.checks[0], outcome: "fail" as const }],
  };
  await assert.rejects(store.validate(skill.id, cwd, failed, "s"), /must pass/);
  assert.equal(await fs.readFile(file, "utf8"), old);
});
test("project metadata is local, portable, and globals remain shared", async (t) => {
  const { temp, cwd, store } = await fixture(t);
  const local = await ready(store, cwd);
  const other = path.join(temp, "other");
  await fs.mkdir(other);
  await assert.rejects(store.get(local.id, other), /not found/);
  const independent = await store.consider(candidate, other);
  assert.equal(independent.id, local.id);
  assert.notEqual(independent.generation, local.generation);
  await store.consider(
    { ...candidate, scope: "global", name: "shared-procedure" },
    cwd,
  );
  assert.equal((await store.list(other)).length, 2);
  const moved = path.join(temp, "moved");
  await fs.rename(cwd, moved);
  assert.equal(
    (await store.discoveryPaths(moved))[0],
    path.join(moved, ".pi", "skills", candidate.name, "SKILL.md"),
  );
  assert.equal((await store.get(local.id, moved)).projectRoot, moved);
});
test("concurrent instances serialize metadata and published files", async (t) => {
  const { cwd, agent, store } = await fixture(t);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      new SkillStore(agent).consider(
        { ...candidate, name: `workflow-${i}` },
        cwd,
      ),
    ),
  );
  assert.equal((await store.list(cwd)).length, 8);
  const skill = await ready(store, cwd);
  const other = new SkillStore(agent);
  await Promise.all([
    store.draft(skill.id, cwd, {
      ...document,
      steps: ["First concurrent change."],
    }),
    other.validate(skill.id, cwd, validation, "s"),
    store.draft(skill.id, cwd, {
      ...document,
      steps: ["Second concurrent change."],
    }),
    other.validate(skill.id, cwd, validation, "s"),
  ]);
  const final = await store.get(skill.id, cwd);
  assert.equal(final.activeRevision, 3);
  assert.match(
    await fs.readFile(store.skillPath(final, cwd), "utf8"),
    /Second concurrent change/,
  );
});
test("stale or competing locks fail closed", async (t) => {
  const { cwd, store } = await fixture(t);
  await fs.mkdir(path.join(store.scopeRoot(cwd, "global"), ".pi-skills-lock"), {
    recursive: true,
  });
  await assert.rejects(store.consider(candidate, cwd), /locked/);
});
test("symlink roots and metadata cannot redirect writes", async (t) => {
  const { temp, agent, cwd, store } = await fixture(t);
  const outside = path.join(temp, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, agent);
  await assert.rejects(store.consider(candidate, cwd), /symlink/);
  await fs.unlink(agent);
  const metadata = store.catalogPath(cwd, "project");
  await fs.mkdir(path.dirname(metadata), { recursive: true });
  await fs.writeFile(path.join(outside, "file"), "preserve");
  await fs.symlink(path.join(outside, "file"), metadata);
  await assert.rejects(store.consider(candidate, cwd), /symlink/);
  assert.equal(
    await fs.readFile(path.join(outside, "file"), "utf8"),
    "preserve",
  );
});
test("unmarked files and auxiliary files are never claimed or removed", async (t) => {
  const { cwd, store } = await fixture(t);
  const root = store.scopeRoot(cwd, "project");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, `${candidate.name}.md`), "external skill");
  await assert.rejects(store.consider(candidate, cwd), /unmanaged/);
  assert.equal(
    await fs.readFile(path.join(root, `${candidate.name}.md`), "utf8"),
    "external skill",
  );
  await fs.unlink(path.join(root, `${candidate.name}.md`));
  const skill = await ready(store, cwd);
  const file = store.skillPath(skill, cwd);
  const auxiliary = path.join(path.dirname(file), "helper.sh");
  await fs.writeFile(auxiliary, "preserve helper");
  await store.retire(skill.id, cwd, "archived", "Superseded.");
  assert.equal(await fs.readFile(auxiliary, "utf8"), "preserve helper");
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  assert.equal((await store.get(skill.id, cwd)).status, "archived");
});
test("hand edits and removed markers block all automated overwrite/delete paths", async (t) => {
  const { cwd, store } = await fixture(t);
  const skill = await ready(store, cwd);
  const file = store.skillPath(skill, cwd);
  const edited =
    (await fs.readFile(file, "utf8")).replace(
      / {2}pi-skills-generated:.*\n/,
      "",
    ) + "\nHand edited.\n";
  await fs.writeFile(file, edited);
  await assert.rejects(
    store.draft(skill.id, cwd, document),
    /manually modified/,
  );
  await assert.rejects(
    store.validate(skill.id, cwd, validation, "s"),
    /manually modified/,
  );
  await assert.rejects(
    store.retire(skill.id, cwd, "deprecated", "Stale."),
    /manually modified/,
  );
  assert.deepEqual(await store.discoveryPaths(cwd), []);
  assert.equal(await fs.readFile(file, "utf8"), edited);
});
test("deprecation removes only the owned SKILL.md and retains verification history", async (t) => {
  const { cwd, store } = await fixture(t);
  const skill = await ready(store, cwd);
  const retired = await store.retire(
    skill.id,
    cwd,
    "deprecated",
    "Toolchain changed.",
  );
  assert.equal(retired.activeRevision, null);
  assert.deepEqual(
    retired.revisions[0].validation,
    skill.revisions[0].validation,
  );
  assert.ok(retired.revisions[0].invalidatedAt);
  assert.deepEqual(await store.discoveryPaths(cwd), []);
  assert.equal(
    (await store.validate(skill.id, cwd, validation, "recheck")).status,
    "active",
  );
});
test("active and external name collisions prevent automatic publication", async (t) => {
  const { cwd, store } = await fixture(t);
  const local = await ready(store, cwd);
  await assert.rejects(
    store.validate(local.id, cwd, validation, "s", [candidate.name]),
    /already uses/,
  );
  const global = await store.consider({ ...candidate, scope: "global" }, cwd);
  await store.draft(global.id, cwd, document);
  await store.validate(global.id, cwd, validation, "s");
  await assert.rejects(
    store.recordUse(global.id, cwd, useEvidence, nextTask()),
    /already uses/,
  );
});
test("ids cannot escape native skill roots", async (t) => {
  const { cwd, store } = await fixture(t);
  await assert.rejects(
    store.draft("project:../../outside", cwd, document),
    /Invalid skill id/,
  );
  await assert.rejects(
    store.draft("project:name:extra", cwd, document),
    /Invalid skill id/,
  );
});
test("legacy v0.1 records migrate once without deleting source data", async (t) => {
  const { agent, cwd, store } = await fixture(t);
  const original = activate(reusableSkill(cwd));
  const { generation: _generation, ...legacySkill } = original;
  const legacyFile = path.join(agent, "pi-skills", "catalog.json");
  const legacyBytes = JSON.stringify({
    version: 1,
    skills: [{ ...legacySkill, id: `project-oldhash:${candidate.name}` }],
  });
  await fs.mkdir(path.dirname(legacyFile), { recursive: true });
  await fs.writeFile(legacyFile, legacyBytes);
  await Promise.all([store.migrateLegacy(cwd), store.migrateLegacy(cwd)]);
  await store.migrateLegacy(cwd);
  assert.equal((await store.list(cwd)).length, 1);
  assert.equal(
    (await store.discoveryPaths(cwd))[0],
    path.join(cwd, ".pi", "skills", candidate.name, "SKILL.md"),
  );
  assert.equal(await fs.readFile(legacyFile, "utf8"), legacyBytes);
});
