import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { candidate, document, validation, useEvidence } from "./fixtures.ts";

test("real Pi session entries, not model-supplied identities, govern reuse promotion", async (t) => {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-session-")),
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
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const extensions = loader.getExtensions();
  assert.deepEqual(extensions.errors, []);
  // The isolated loader has no application command registry to bind.
  extensions.runtime.getCommands = () => [];
  const tool = extensions.extensions[0].tools.get("skill_manage")?.definition;
  assert.ok(tool);
  const manager = SessionManager.inMemory(temp);
  const captureRequest = manager.appendMessage({
    role: "user",
    content: "Solve a vendor native crash.",
    timestamp: Date.now(),
  });
  const context = {
    cwd: temp,
    hasUI: false,
    sessionManager: manager,
  } as unknown as ExtensionToolContext;
  const call = (args: Record<string, unknown>) =>
    tool.execute("runtime-test", args, undefined, undefined, context);
  await call({
    action: "capture",
    candidate: { ...candidate, scope: "global" },
    document,
  });
  const id = `global:${candidate.name}`;
  await call({ action: "validate", id, validation });
  const file = path.join(temp, "skills", candidate.name, "SKILL.md");
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  await assert.rejects(
    call({ action: "record_use", id, use: useEvidence }),
    /independent/,
  );
  const followupRequest = manager.appendMessage({
    role: "user",
    content: "Analyze a later crash using the saved procedure.",
    timestamp: Date.now(),
  });
  await call({ action: "record_use", id, use: useEvidence });
  assert.ok(await fs.stat(file));
  const metadata = JSON.parse(
    await fs.readFile(path.join(temp, "skills", ".pi-skills.json"), "utf8"),
  );
  assert.equal(
    metadata.skills[0].learning.captureTask.requestId,
    captureRequest,
  );
  assert.equal(
    metadata.skills[0].learning.uses[0].task.requestId,
    followupRequest,
  );
  assert.notEqual(captureRequest, followupRequest);
  assert.equal(manager.isPersisted(), false);
});
