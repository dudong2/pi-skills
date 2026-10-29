import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reviewHash } from "../src/lifecycle.ts";
import { SkillStore, projectRoot } from "../src/store.ts";
import { candidate, document, validation } from "./fixtures.ts";

async function fixture(t: test.TestContext) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-test-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "store");
  return { temp, root, store: new SkillStore(root) };
}
async function ready(store: SkillStore, project = "/repo") {
  const skill = await store.consider(candidate, project);
  await store.draft(skill.id, project, document);
  return store.validate(skill.id, project, validation, "session-1");
}

test("malformed catalog fails closed and remains byte-identical", async (t) => {
  const { root, store } = await fixture(t);
  await fs.mkdir(root);
  await fs.writeFile(store.catalogPath, "{broken");
  await assert.rejects(
    store.consider(candidate, "/repo"),
    /Malformed skill catalog.*repair or restore/,
  );
  assert.equal(await fs.readFile(store.catalogPath, "utf8"), "{broken");
});
test("validation metadata survives a store reload", async (t) => {
  const { store, root } = await fixture(t);
  const skill = await ready(store);
  assert.equal(
    (await new SkillStore(root).get(skill.id, "/repo")).revisions[0].validation
      ?.sessionId,
    "session-1",
  );
});
test("only active revisions are discoverable, including after a pending revision", async (t) => {
  const { store } = await fixture(t);
  const initial = await store.consider(candidate, "/repo");
  assert.deepEqual(await store.discoveryPaths("/repo"), []);
  await store.draft(initial.id, "/repo", document);
  assert.deepEqual(await store.discoveryPaths("/repo"), []);
  const checked = await store.validate(initial.id, "/repo", validation, "s");
  assert.deepEqual(await store.discoveryPaths("/repo"), []);
  await store.activate(initial.id, "/repo", reviewHash(checked), []);
  const [file] = await store.discoveryPaths("/repo");
  assert.match(await fs.readFile(file, "utf8"), /Compare build IDs/);
  await store.draft(initial.id, "/repo", {
    ...document,
    steps: ["New unvalidated step."],
  });
  assert.deepEqual(await store.discoveryPaths("/repo"), [file]);
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /New unvalidated/);
  await store.retire(
    initial.id,
    "/repo",
    "deprecated",
    "The environment changed.",
  );
  assert.deepEqual(await store.discoveryPaths("/repo"), []);
});
test("projects remain isolated while globals are shared", async (t) => {
  const { store } = await fixture(t);
  const local = await store.consider(candidate, "/repo-a");
  await assert.rejects(store.get(local.id, "/repo-b"), /not found/);
  await assert.rejects(store.draft(local.id, "/repo-b", document), /not found/);
  await store.consider(
    { ...candidate, scope: "global", name: "shared-workflow" },
    "/repo-a",
  );
  assert.equal((await store.list("/repo-b")).length, 1);
});
test("concurrent store instances do not lose candidates", async (t) => {
  const { root, store } = await fixture(t);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      new SkillStore(root).consider(
        { ...candidate, name: `workflow-${i}` },
        "/repo",
      ),
    ),
  );
  assert.equal((await store.list("/repo")).length, 8);
});
test("stale or competing locks fail closed", async (t) => {
  const { root, store } = await fixture(t);
  await fs.mkdir(path.join(root, ".mutation-lock"), { recursive: true });
  await assert.rejects(store.consider(candidate, "/repo"), /locked/);
});
test("symlink store and catalog cannot redirect writes", async (t) => {
  const { temp, root, store } = await fixture(t);
  const outside = path.join(temp, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, root);
  await assert.rejects(store.consider(candidate, "/repo"), /symlink/);
  await fs.unlink(root);
  await fs.mkdir(root);
  await fs.writeFile(path.join(outside, "file"), "preserve");
  await fs.symlink(path.join(outside, "file"), store.catalogPath);
  await assert.rejects(store.consider(candidate, "/repo"), /symlink/);
  assert.equal(
    await fs.readFile(path.join(outside, "file"), "utf8"),
    "preserve",
  );
});
test("activation rejects changed revisions and external name collisions", async (t) => {
  const { store } = await fixture(t);
  const skill = await ready(store);
  await assert.rejects(
    store.activate(skill.id, "/repo", reviewHash(skill), [candidate.name]),
    /already uses/,
  );
  await store.draft(skill.id, "/repo", {
    ...document,
    steps: ["Revised after review."],
  });
  await assert.rejects(
    store.activate(skill.id, "/repo", reviewHash(skill), []),
    /changed since review/,
  );
});
test("global/project active name collisions are rejected", async (t) => {
  const { store } = await fixture(t);
  const local = await ready(store);
  await store.activate(local.id, "/repo", reviewHash(local), []);
  const global = await store.consider(
    { ...candidate, scope: "global" },
    "/repo",
  );
  await store.draft(global.id, "/repo", document);
  const checked = await store.validate(global.id, "/repo", validation, "s");
  await assert.rejects(
    store.activate(global.id, "/repo", reviewHash(checked), []),
    /already uses/,
  );
});
test("activation rejects evidence changed during user review", async (t) => {
  const { store } = await fixture(t);
  const skill = await ready(store);
  await store.validate(
    skill.id,
    "/repo",
    { ...validation, limitations: "Changed evidence after the review opened." },
    "session-2",
  );
  await assert.rejects(
    store.activate(skill.id, "/repo", reviewHash(skill), []),
    /changed since review/,
  );
});
test("deprecation invalidates old validation before reactivation", async (t) => {
  const { store } = await fixture(t);
  const skill = await ready(store);
  await store.activate(skill.id, "/repo", reviewHash(skill), []);
  await store.retire(
    skill.id,
    "/repo",
    "deprecated",
    "The toolchain is unsafe now.",
  );
  const deprecated = await store.get(skill.id, "/repo");
  await assert.rejects(
    store.activate(skill.id, "/repo", reviewHash(deprecated), []),
    /validation/,
  );
});
test("project root uses canonical repo root even from a nested directory", async (t) => {
  const { temp } = await fixture(t);
  await fs.mkdir(path.join(temp, ".git"));
  await fs.mkdir(path.join(temp, "src", "nested"), { recursive: true });
  assert.equal(
    await projectRoot(path.join(temp, "src", "nested")),
    await fs.realpath(temp),
  );
});
