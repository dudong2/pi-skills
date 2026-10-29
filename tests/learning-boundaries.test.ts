import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillStore } from "../src/store.ts";
import { document, validation } from "./fixtures.ts";

const DAY = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00Z");
const candidate = {
  name: "saved-workflow",
  scope: "project" as const,
  trigger: "non-obvious" as const,
  procedure: "Resolve native crash frames using exact artifacts.",
  sourceRefs: ["session:source/result:1"],
  relatedSkills: [],
};
const use = {
  sourceRevision: 1,
  reusedSteps: [1],
  adaptations: [],
  outcome: "success" as const,
  evidenceRefs: ["session:followup/result:2"],
};
async function fixture(t: test.TestContext) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-boundaries-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const cwd = path.join(temp, "work");
  await fs.mkdir(cwd);
  let day = 0;
  const now = () => new Date(START + day * DAY);
  const store = new SkillStore(path.join(temp, "agent"), now);
  const task = (id: string) => ({
    sessionId: "session",
    requestId: id,
    startedAt: now().toISOString(),
  });
  const capture = (name = candidate.name) =>
    store.capture(
      { ...candidate, name },
      cwd,
      document,
      task(`capture-${name}`),
    );
  return {
    temp,
    cwd,
    store,
    task,
    capture,
    advance: (value: number) => {
      day = value;
    },
  };
}

test("a self-authored new source revision is not independent reuse, and source step indices are checked", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  f.advance(1);
  const followup = f.task("followup");
  await f.store.draft(
    skill.id,
    f.cwd,
    { ...document, steps: ["An adaptation."] },
    followup,
  );
  await assert.rejects(
    f.store.recordUse(skill.id, f.cwd, { ...use, sourceRevision: 2 }, followup),
    /independent/,
  );
  await assert.rejects(
    f.store.recordUse(
      skill.id,
      f.cwd,
      { ...use, reusedSteps: [999] },
      followup,
    ),
    /step numbers/,
  );
  await assert.rejects(
    f.store.recordUse(
      skill.id,
      f.cwd,
      { ...use, reusedSteps: [1, 1] },
      followup,
    ),
    /distinct/,
  );
});
test("old reuse evidence cannot promote a newly edited document until that revision is applied", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  f.advance(1);
  const followup = f.task("followup");
  await f.store.recordUse(skill.id, f.cwd, use, followup);
  await f.store.draft(
    skill.id,
    f.cwd,
    { ...document, steps: ["Different instructions."] },
    followup,
  );
  await f.store.validate(skill.id, f.cwd, validation, "session");
  assert.deepEqual(await f.store.discoveryPaths(f.cwd), []);
  assert.equal(
    (await f.store.recordUse(skill.id, f.cwd, use, followup)).activeRevision,
    2,
  );
});
test("expiry removes only owned candidate data, preserving unrelated files in the folder", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  const file = f.store.candidatePath(skill, f.cwd);
  const external = path.join(path.dirname(file), "notes.txt");
  await fs.writeFile(external, "User-owned notes.");
  f.advance(90);
  assert.deepEqual((await f.store.maintain(f.cwd)).deleted, [skill.id]);
  assert.equal(await fs.readFile(external, "utf8"), "User-owned notes.");
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});
test("symlinked candidates and unexpected published files are protected from expiry", async (t) => {
  const f = await fixture(t);
  const a = await f.capture("linked-workflow");
  const b = await f.capture("external-workflow");
  const external = path.join(f.temp, "outside.txt");
  await fs.writeFile(external, "Preserve outside data.");
  const candidateFile = f.store.candidatePath(a, f.cwd);
  await fs.unlink(candidateFile);
  await fs.symlink(external, candidateFile);
  await fs.writeFile(f.store.skillPath(b, f.cwd), "External SKILL.md");
  f.advance(90);
  const result = await f.store.maintain(f.cwd);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.protected.length, 2);
  assert.equal(await fs.readFile(external, "utf8"), "Preserve outside data.");
  assert.equal(
    await fs.readFile(f.store.skillPath(b, f.cwd), "utf8"),
    "External SKILL.md",
  );
});
test("partial candidate deletion failures restore prior files and exact metadata", async (t) => {
  const f = await fixture(t);
  const a = await f.capture("first-workflow");
  const b = await f.capture("second-workflow");
  const metadata = await fs.readFile(f.store.catalogPath(f.cwd, "project"));
  const aFile = f.store.candidatePath(a, f.cwd);
  const before = await fs.readFile(aFile);
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]) === f.store.candidatePath(b, f.cwd))
      throw new Error("Injected deletion failure.");
    return unlink(...args);
  });
  f.advance(90);
  await assert.rejects(f.store.maintain(f.cwd), /Injected deletion failure/);
  assert.deepEqual(await fs.readFile(aFile), before);
  assert.deepEqual(
    await fs.readFile(f.store.catalogPath(f.cwd, "project")),
    metadata,
  );
});
test("promotion cleanup failure does not leave an uncommitted active SKILL.md", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  await f.store.validate(skill.id, f.cwd, validation, "session");
  const metadata = await fs.readFile(f.store.catalogPath(f.cwd, "project"));
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]) === f.store.candidatePath(skill, f.cwd))
      throw new Error("Injected candidate cleanup failure.");
    return unlink(...args);
  });
  f.advance(1);
  await assert.rejects(
    f.store.recordUse(skill.id, f.cwd, use, f.task("followup")),
    /Injected candidate cleanup failure/,
  );
  await assert.rejects(fs.stat(f.store.skillPath(skill, f.cwd)), {
    code: "ENOENT",
  });
  assert.deepEqual(
    await fs.readFile(f.store.catalogPath(f.cwd, "project")),
    metadata,
  );
  assert.ok(await fs.stat(f.store.candidatePath(skill, f.cwd)));
});
test("failed initial candidate publication leaves capture retryable", async (t) => {
  const f = await fixture(t);
  const rename = fs.rename;
  let fail = true;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith("candidate.json") && fail)
      throw new Error("Injected capture failure.");
    return rename(...args);
  });
  await assert.rejects(f.capture(), /Injected capture failure/);
  assert.deepEqual(await f.store.list(f.cwd), []);
  fail = false;
  assert.equal((await f.capture()).status, "draft");
});
test("valid offset timestamps remain valid after provenance is persisted", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  f.advance(1);
  await f.store.recordUse(skill.id, f.cwd, use, {
    ...f.task("offset-followup"),
    startedAt: "2025-12-31T20:00:00-05:00",
  });
  assert.equal((await f.store.get(skill.id, f.cwd)).learning?.uses.length, 1);
});
test("expiry is scoped to current cwd and shared globals, not other project directories", async (t) => {
  const f = await fixture(t);
  const local = await f.capture();
  const global = await f.store.capture(
    { ...candidate, scope: "global", name: "global-workflow" },
    f.cwd,
    document,
    f.task("global-origin"),
  );
  const other = path.join(f.temp, "other");
  await fs.mkdir(other);
  await f.store.capture(candidate, other, document, f.task("other-origin"));
  f.advance(90);
  assert.deepEqual(
    new Set((await f.store.maintain(f.cwd)).deleted),
    new Set([local.id, global.id]),
  );
  const untouched = JSON.parse(
    await fs.readFile(f.store.catalogPath(other, "project"), "utf8"),
  );
  assert.equal(untouched.skills.length, 1);
  assert.equal((await f.store.maintain(other)).deleted.length, 1);
});
test("persisted self-reuse cannot be accepted as promotion evidence", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  f.advance(1);
  await f.store.recordUse(skill.id, f.cwd, use, f.task("followup"));
  const file = f.store.catalogPath(f.cwd, "project");
  const metadata = JSON.parse(await fs.readFile(file, "utf8"));
  metadata.skills[0].learning.uses[0].task =
    metadata.skills[0].learning.captureTask;
  await fs.writeFile(file, JSON.stringify(metadata));
  await assert.rejects(
    f.store.get(skill.id, f.cwd),
    /actual-application provenance/,
  );
});
test("v2 adopted baselines are protected and stay discoverable without invented reuse", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.cwd, ".pi", "skills", candidate.name, "SKILL.md");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(
    source,
    `---\nname: ${candidate.name}\ndescription: Existing external procedure\n---\n\n# Existing procedure\n`,
  );
  const skill = await f.store.adopt(
    candidate,
    f.cwd,
    source,
    "User requested adoption.",
  );
  const metadataFile = f.store.catalogPath(f.cwd, "project");
  const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
  metadata.version = 2;
  delete metadata.skills[0].learning;
  await fs.writeFile(metadataFile, JSON.stringify(metadata));
  f.advance(500);
  assert.deepEqual((await f.store.maintain(f.cwd)).deleted, []);
  assert.deepEqual(await f.store.discoveryPaths(f.cwd), [source]);
  assert.equal((await f.store.get(skill.id, f.cwd)).learning?.uses.length, 0);
});
test("v2 formerly activated data is migrated without becoming disposable", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  await f.store.validate(skill.id, f.cwd, validation, "session");
  f.advance(1);
  await f.store.recordUse(skill.id, f.cwd, use, f.task("followup"));
  await f.store.retire(skill.id, f.cwd, "archived", "Superseded.");
  const file = f.store.catalogPath(f.cwd, "project");
  const prior = JSON.parse(await fs.readFile(file, "utf8"));
  prior.version = 2;
  for (const record of prior.skills) {
    delete record.learning;
    for (const revision of record.revisions) delete revision.task;
  }
  await fs.writeFile(file, JSON.stringify(prior));
  f.advance(500);
  assert.deepEqual((await f.store.maintain(f.cwd)).deleted, []);
  assert.equal(
    (await f.store.get(skill.id, f.cwd)).learning?.everActivated,
    true,
  );
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 3);
});
