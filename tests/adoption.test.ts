import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { SkillStore } from "../src/store.ts";
import { candidate, document, validation } from "./fixtures.ts";

async function fixture(t: test.TestContext) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-adopt-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const cwd = path.join(temp, "work");
  const store = new SkillStore(path.join(temp, "agent"));
  const file = path.join(cwd, ".agents", "skills", candidate.name, "SKILL.md");
  const original = `---\nname: ${candidate.name}\ndescription: Existing vendor crash workflow\nversion: 3\nmetadata:\n  author: external\n---\n\n# Existing workflow\n\nRun scripts/helper.sh only for an authorized task.\n`;
  await fs.mkdir(path.join(path.dirname(file), "scripts"), { recursive: true });
  await fs.writeFile(file, original);
  const helper = path.join(path.dirname(file), "scripts", "helper.sh");
  await fs.writeFile(helper, "#!/bin/sh\nprintf 'fixture\\n'\n", {
    mode: 0o755,
  });
  return { cwd, store, file, original, helper };
}

test("adoption preserves source and auxiliary files without inventing validation", async (t) => {
  const { cwd, store, file, original, helper } = await fixture(t);
  const skill = await store.adopt(
    candidate,
    cwd,
    file,
    "User explicitly requested management of this existing skill.",
  );
  const stamped = await fs.readFile(file, "utf8");
  assert.equal(stamped.replace(/^pi-skills-adopted:.*\n/m, ""), original);
  assert.match(stamped, /pi-skills-adopted:/);
  assert.doesNotMatch(stamped, /pi-skills-generated:/);
  assert.equal(skill.status, "active");
  assert.equal(skill.revisions.length, 0);
  assert.equal(skill.activeRevision, null);
  assert.equal(store.skillPath(skill, cwd), file);
  assert.deepEqual(await store.discoveryPaths(cwd), [file]);
  const parsed = loadSkillsFromDir({
    dir: path.dirname(file),
    source: "adoption-test",
  });
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.skills[0]?.name, candidate.name);
  assert.match(await fs.readFile(helper, "utf8"), /fixture/);
  assert.equal((await fs.stat(helper)).mode & 0o777, 0o755);
  assert.equal(
    (await store.adopt(candidate, cwd, file, "Explicit repeat.")).generation,
    skill.generation,
  );
});
test("adopted skills retain their baseline during drafts and use verified revisions afterwards", async (t) => {
  const { cwd, store, file } = await fixture(t);
  const skill = await store.adopt(
    candidate,
    cwd,
    file,
    "User requested adoption.",
  );
  const baseline = await fs.readFile(file, "utf8");
  await store.draft(skill.id, cwd, document);
  assert.equal(await fs.readFile(file, "utf8"), baseline);
  assert.equal((await store.get(skill.id, cwd)).status, "active");
  await store.validate(skill.id, cwd, validation, "test-session");
  assert.match(await fs.readFile(file, "utf8"), /pi-skills-generated:/);
  assert.equal(
    (await store.get(skill.id, cwd)).revisions[0].validation?.sessionId,
    "test-session",
  );
});
test("adoption is bounded to matching native skill paths and requires a reason", async (t) => {
  const { cwd, store, file } = await fixture(t);
  await assert.rejects(
    store.adopt(
      candidate,
      cwd,
      path.join(cwd, "outside.md"),
      "Explicit request.",
    ),
    /native skill path/,
  );
  await assert.rejects(store.adopt(candidate, cwd, file, " "), /Blank/);
  assert.deepEqual(await store.list(cwd), []);
});
test("concurrent adoption is idempotent and adopted baselines can be retired", async (t) => {
  const { cwd, store, file, helper } = await fixture(t);
  const [first, second] = await Promise.all([
    store.adopt(candidate, cwd, file, "User requested adoption."),
    store.adopt(candidate, cwd, file, "Same authorized request."),
  ]);
  assert.equal(first.generation, second.generation);
  await store.retire(first.id, cwd, "archived", "No longer needed.");
  assert.deepEqual(await store.discoveryPaths(cwd), []);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  assert.ok(await fs.stat(helper));
});
test("relocation moves the complete adopted directory into .pi without rewriting content", async (t) => {
  const { cwd, store, file, helper } = await fixture(t);
  const skill = await store.adopt(
    candidate,
    cwd,
    file,
    "User requested adoption.",
  );
  const before = await fs.readFile(file);
  const helperBefore = await fs.readFile(helper);
  const moved = await store.moveToNative(skill.id, cwd);
  const target = path.join(cwd, ".pi", "skills", candidate.name, "SKILL.md");
  assert.equal(store.skillPath(moved, cwd), target);
  assert.equal(moved.generation, skill.generation);
  assert.equal(moved.adoption?.sourceSha256, skill.adoption?.sourceSha256);
  assert.deepEqual(await fs.readFile(target), before);
  const movedHelper = path.join(path.dirname(target), "scripts", "helper.sh");
  assert.deepEqual(await fs.readFile(movedHelper), helperBefore);
  assert.equal((await fs.stat(movedHelper)).mode & 0o777, 0o755);
  await assert.rejects(fs.stat(path.dirname(file)), { code: "ENOENT" });
  assert.deepEqual(await store.discoveryPaths(cwd), [target]);
  assert.equal(
    (await store.moveToNative(skill.id, cwd)).generation,
    moved.generation,
  );
});
test("relocation repairs executable references and current metadata pointers", async (t) => {
  const { cwd, store, file } = await fixture(t);
  const oldPrefix = `.agents/skills/${candidate.name}/`;
  const newPrefix = `.pi/skills/${candidate.name}/`;
  await fs.writeFile(
    file,
    (await fs.readFile(file, "utf8")).replace(
      "scripts/helper.sh",
      `${oldPrefix}scripts/helper.sh`,
    ),
  );
  const skill = await store.adopt(
    {
      ...candidate,
      sourceRefs: [file],
      relatedSkills: [{ path: file, comparison: "Existing procedure." }],
    },
    cwd,
    file,
    "User requested adoption.",
  );
  const moved = await store.moveToNative(skill.id, cwd);
  const target = store.skillPath(moved, cwd);
  assert.match(
    await fs.readFile(target, "utf8"),
    new RegExp(`${newPrefix}scripts/helper\\.sh`),
  );
  assert.ok(!moved.adoption?.content.includes(oldPrefix));
  assert.deepEqual(moved.candidate.sourceRefs, [target]);
  assert.equal(moved.candidate.relatedSkills[0].path, target);
  assert.equal(moved.revisions.length, 0);
  assert.ok(await fs.stat(path.join(cwd, newPrefix, "scripts/helper.sh")));
  assert.deepEqual(await store.discoveryPaths(cwd), [target]);
  const again = await store.moveToNative(skill.id, cwd);
  assert.equal(again.events.length, moved.events.length);
});
test("relocation refuses an occupied destination without changing the source or metadata", async (t) => {
  const { cwd, store, file } = await fixture(t);
  const skill = await store.adopt(
    candidate,
    cwd,
    file,
    "User requested adoption.",
  );
  const target = path.join(cwd, ".pi", "skills", candidate.name, "SKILL.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "External procedure.");
  const original = await fs.readFile(file);
  const metadata = await fs.readFile(store.catalogPath(cwd, "project"));
  await assert.rejects(store.moveToNative(skill.id, cwd), /occupied|existing/i);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal(await fs.readFile(target, "utf8"), "External procedure.");
  assert.deepEqual(
    await fs.readFile(store.catalogPath(cwd, "project")),
    metadata,
  );
});
test("failed directory relocation rolls back ownership metadata", async (t) => {
  const { cwd, store, file } = await fixture(t);
  const skill = await store.adopt(
    candidate,
    cwd,
    file,
    "User requested adoption.",
  );
  const target = path.join(cwd, ".pi", "skills", candidate.name);
  const metadata = await fs.readFile(store.catalogPath(cwd, "project"));
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === target)
      throw new Error("Injected relocation failure.");
    return rename(...args);
  });
  await assert.rejects(
    store.moveToNative(skill.id, cwd),
    /Injected relocation failure/,
  );
  assert.ok(await fs.stat(file));
  assert.deepEqual(
    await fs.readFile(store.catalogPath(cwd, "project")),
    metadata,
  );
  assert.equal(store.skillPath(await store.get(skill.id, cwd), cwd), file);
});
test("hand edits to adopted files are not overwritten or deleted", async (t) => {
  const { cwd, store, file } = await fixture(t);
  const skill = await store.adopt(
    candidate,
    cwd,
    file,
    "User requested adoption.",
  );
  const edited = `${await fs.readFile(file, "utf8")}\nManual change.\n`;
  await fs.writeFile(file, edited);
  await assert.rejects(
    store.draft(skill.id, cwd, document),
    /manually modified/,
  );
  await assert.rejects(
    store.retire(skill.id, cwd, "archived", "Retired."),
    /manually modified/,
  );
  assert.equal(await fs.readFile(file, "utf8"), edited);
});
