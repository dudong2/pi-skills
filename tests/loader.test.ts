import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  loadSkillsFromDir,
  SettingsManager,
  type ResourcesDiscoverResult,
} from "@earendil-works/pi-coding-agent";
import { reviewHash } from "../src/lifecycle.ts";
import { SkillStore } from "../src/store.ts";
import { candidate, document, validation } from "./fixtures.ts";

test("Pi's real TypeScript extension loader and skill parser accept the package", async (t) => {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-loader-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temp;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const loader = new DefaultResourceLoader({
    cwd: temp,
    agentDir: temp,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ],
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.ok(extension.tools.has("skill_manage"));
  assert.ok(extension.commands.has("skills"));
  const handler = extension.handlers.get("resources_discover")?.[0];
  assert.ok(handler);
  const discover = async () =>
    (await handler(
      { type: "resources_discover", cwd: temp, reason: "reload" },
      {},
    )) as ResourcesDiscoverResult;
  assert.deepEqual((await discover()).skillPaths, []);
  const store = new SkillStore(path.join(temp, "pi-skills"));
  const skill = await store.consider({ ...candidate, scope: "global" }, temp);
  await store.draft(skill.id, temp, document);
  const checked = await store.validate(
    skill.id,
    temp,
    validation,
    "loader-test",
  );
  await store.activate(skill.id, temp, reviewHash(checked), []);
  const [skillPath] = (await discover()).skillPaths ?? [];
  assert.ok(skillPath);
  const loaded = loadSkillsFromDir({
    dir: path.dirname(skillPath),
    source: "pi-skills-test",
  });
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.skills[0]?.name, candidate.name);
  await store.retire(skill.id, temp, "deprecated", "Fixture retired.");
  assert.deepEqual((await discover()).skillPaths, []);
});
