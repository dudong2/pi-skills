import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { SkillStore } from "../src/store.ts";
import { document, validation } from "./fixtures.ts";

const DAY = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");
const candidate = {
  name: "debug-vendor-crash",
  scope: "project" as const,
  trigger: "complex-task" as const,
  procedure: "Resolve vendor native crash frames using the matching build ID.",
  sourceRefs: ["session:first/result:42"],
  relatedSkills: [],
};
const usage = {
  sourceRevision: 1,
  reusedSteps: [1],
  adaptations: [],
  outcome: "success" as const,
  evidenceRefs: ["session:second/result:51"],
};
async function fixture(t: test.TestContext) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-learning-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "work");
  await fs.mkdir(cwd);
  let day = 0;
  const now = () => new Date(START + day * DAY);
  const task = (id: string) => ({
    sessionId: "session",
    requestId: id,
    startedAt: now().toISOString(),
  });
  const store = new SkillStore(path.join(root, "agent"), now);
  const capture = () => store.capture(candidate, cwd, document, task("first"));
  return {
    cwd,
    store,
    task,
    capture,
    now,
    advance: (value: number) => {
      day = value;
    },
  };
}

test("capture uses broad upstream cues and keeps a complete searchable candidate outside the active index", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  assert.equal(skill.status, "draft");
  assert.deepEqual(await f.store.discoveryPaths(f.cwd), []);
  assert.deepEqual(
    loadSkillsFromDir({
      dir: path.join(f.cwd, ".pi", "skills"),
      source: "candidate-isolation",
    }).skills,
    [],
  );
  const file = path.join(
    f.cwd,
    ".pi",
    "skills",
    candidate.name,
    "candidate.json",
  );
  assert.ok((await fs.readFile(file, "utf8")).includes(document.steps[0]));
  const hits = await f.store.search(f.cwd, "native crash");
  assert.equal(hits[0]?.id, skill.id);
  assert.equal(hits[0]?.status, "draft");
  await f.store.validate(skill.id, f.cwd, validation, "session");
  assert.equal((await f.store.get(skill.id, f.cwd)).status, "validated");
  assert.deepEqual(await f.store.discoveryPaths(f.cwd), []);
});
test("same request cannot self-promote, even after validation", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  await f.store.validate(skill.id, f.cwd, validation, "session");
  await assert.rejects(
    f.store.recordUse(skill.id, f.cwd, usage, f.task("first")),
    /independent|capture task/,
  );
  assert.deepEqual(await f.store.discoveryPaths(f.cwd), []);
});
test("a later real application can adapt the candidate and promote only the verified new revision", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  f.advance(1);
  const second = f.task("second");
  await f.store.draft(
    skill.id,
    f.cwd,
    { ...document, steps: ["A verified adaptation for a different vendor."] },
    second,
  );
  await f.store.validate(skill.id, f.cwd, validation, "session");
  assert.deepEqual(await f.store.discoveryPaths(f.cwd), []);
  const promoted = await f.store.recordUse(
    skill.id,
    f.cwd,
    { ...usage, adaptations: ["Matched a different vendor artifact."] },
    second,
  );
  assert.equal(promoted.status, "active");
  assert.equal(promoted.activeRevision, 2);
  assert.equal(promoted.learning?.everActivated, true);
  assert.match(
    await fs.readFile(f.store.skillPath(promoted, f.cwd), "utf8"),
    /different vendor/,
  );
  await assert.rejects(
    fs.stat(
      path.join(
        path.dirname(f.store.skillPath(promoted, f.cwd)),
        "candidate.json",
      ),
    ),
    { code: "ENOENT" },
  );
});
test("reuse without a passing validation report is not promotion", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  f.advance(1);
  await f.store.recordUse(skill.id, f.cwd, usage, f.task("second"));
  assert.deepEqual(await f.store.discoveryPaths(f.cwd), []);
  assert.equal(
    (await f.store.validate(skill.id, f.cwd, validation, "session")).status,
    "active",
  );
});
test("search, view and draft edits do not extend the 90 calendar day candidate lifetime", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  f.advance(89);
  await f.store.search(f.cwd, "native crash");
  await f.store.get(skill.id, f.cwd);
  await f.store.draft(
    skill.id,
    f.cwd,
    { ...document, description: "An edited description." },
    f.task("edit-only"),
  );
  assert.equal((await f.store.maintain(f.cwd)).deleted.length, 0);
  f.advance(90);
  assert.deepEqual(await f.store.search(f.cwd, "native crash"), []);
  const cleaned = await f.store.maintain(f.cwd);
  assert.deepEqual(cleaned.deleted, [skill.id]);
  assert.deepEqual(await f.store.list(f.cwd), []);
  await assert.rejects(
    fs.stat(
      path.join(f.cwd, ".pi", "skills", candidate.name, "candidate.json"),
    ),
    { code: "ENOENT" },
  );
});
test("an actual unsuccessful application extends lifetime, but repeating the report cannot refresh it", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  f.advance(80);
  const attempt = f.task("attempt");
  const failed = { ...usage, outcome: "failed" as const };
  await f.store.recordUse(skill.id, f.cwd, failed, attempt);
  f.advance(100);
  await f.store.recordUse(skill.id, f.cwd, failed, attempt);
  assert.equal((await f.store.maintain(f.cwd)).deleted.length, 0);
  f.advance(170);
  assert.deepEqual((await f.store.maintain(f.cwd)).deleted, [skill.id]);
});
test("renewal starts at first actual application, not at the earlier request start", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  f.advance(70);
  const task = f.task("long-followup");
  f.advance(80);
  await f.store.recordUse(
    skill.id,
    f.cwd,
    { ...usage, outcome: "failed" },
    task,
  );
  f.advance(165);
  assert.deepEqual((await f.store.maintain(f.cwd)).deleted, []);
  f.advance(170);
  assert.deepEqual((await f.store.maintain(f.cwd)).deleted, [skill.id]);
});
test("once promoted, even a retired skill is excluded from automatic candidate deletion", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  f.advance(1);
  await f.store.validate(skill.id, f.cwd, validation, "session");
  await f.store.recordUse(skill.id, f.cwd, usage, f.task("second"));
  await f.store.retire(skill.id, f.cwd, "archived", "Superseded.");
  f.advance(400);
  assert.deepEqual((await f.store.maintain(f.cwd)).deleted, []);
  assert.equal((await f.store.get(skill.id, f.cwd)).status, "archived");
});
test("expiration preserves hand-edited candidate files", async (t) => {
  const f = await fixture(t);
  const skill = await f.capture();
  const file = path.join(
    f.cwd,
    ".pi",
    "skills",
    candidate.name,
    "candidate.json",
  );
  await fs.writeFile(file, "manual changes");
  f.advance(90);
  const result = await f.store.maintain(f.cwd);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.protected[0]?.id, skill.id);
  assert.equal(await fs.readFile(file, "utf8"), "manual changes");
});
