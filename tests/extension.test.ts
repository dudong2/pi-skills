import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  RegisteredCommand,
  ResourcesDiscoverEvent,
  ResourcesDiscoverResult,
  Skill as PiSkill,
  SlashCommandInfo,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import piSkills, { GUIDELINES } from "../src/index.ts";
import { SkillStore } from "../src/store.ts";
import { candidate, document, validation } from "./fixtures.ts";

type Discovery = (
  event: ResourcesDiscoverEvent,
  ctx: ExtensionContext,
) => Promise<ResourcesDiscoverResult>;
type Before = (
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
) => Promise<void>;
async function fixture(t: test.TestContext) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-extension-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const cwd = path.join(temp, "work");
  const agent = path.join(temp, "agent");
  await fs.mkdir(cwd);
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  });
  let tool: ToolDefinition | undefined;
  let command: Pick<RegisteredCommand, "handler"> | undefined;
  let discovery: Discovery | undefined;
  let before: Before | undefined;
  const commands: SlashCommandInfo[] = [];
  piSkills({
    on(name: string, handler: Discovery | Before) {
      if (name === "resources_discover") discovery = handler as Discovery;
      if (name === "before_agent_start") before = handler as Before;
      return () => {};
    },
    registerTool(value: ToolDefinition) {
      tool = value;
    },
    registerCommand(_name: string, value: Pick<RegisteredCommand, "handler">) {
      command = value;
    },
    getCommands() {
      return commands;
    },
  } as unknown as ExtensionAPI);
  assert.ok(tool && command && discovery && before);
  const registered = { tool, command, discovery, before };
  const notifications: string[] = [];
  const context = {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      async confirm() {
        assert.fail("Skill lifecycle must not ask for approval.");
      },
    },
    sessionManager: { getSessionId: () => "test-session" },
    async reload() {
      assert.fail("Skill lifecycle must not require reload.");
    },
  } as unknown as ExtensionCommandContext & ExtensionToolContext;
  const call = (args: Record<string, unknown>) =>
    registered.tool.execute("call", args, undefined, undefined, context);
  const store = new SkillStore(agent);
  const draft = async () => {
    await call({ action: "consider", candidate });
    const [skill] = await store.list(cwd);
    await call({ action: "draft", id: skill.id, document });
    return skill.id;
  };
  const refresh = async (skills: PiSkill[] = []) => {
    const event = { systemPromptOptions: { skills } } as BeforeAgentStartEvent;
    await registered.before(event, context);
    return event.systemPromptOptions.skills;
  };
  return {
    cwd,
    agent,
    context,
    call,
    store,
    draft,
    refresh,
    notifications,
    commands,
    command: (args: string) => registered.command.handler(args, context),
    discover: () =>
      registered.discovery(
        { type: "resources_discover", cwd, reason: "reload" },
        context,
      ),
  };
}

test("passing validation publishes headlessly without confirmation or manual activation", async (t) => {
  const f = await fixture(t);
  const id = await f.draft();
  assert.deepEqual((await f.discover()).skillPaths, []);
  await f.call({ action: "validate", id, validation });
  assert.equal((await f.store.get(id, f.cwd)).status, "active");
  assert.equal((await f.discover()).skillPaths?.length, 1);
  const fresh = await f.refresh();
  assert.equal(fresh[0]?.name, candidate.name);
  assert.equal(
    fresh[0]?.filePath,
    path.join(f.cwd, ".pi", "skills", candidate.name, "SKILL.md"),
  );
});
test("the agent can deprecate and archive without user commands", async (t) => {
  const f = await fixture(t);
  const id = await f.draft();
  await f.call({ action: "validate", id, validation });
  const active = await f.refresh();
  await f.call({ action: "deprecate", id, reason: "Toolchain changed." });
  assert.deepEqual(await f.refresh(active), []);
  await f.call({ action: "archive", id, reason: "Superseded." });
  assert.equal((await f.store.get(id, f.cwd)).status, "archived");
});
test("publication and updates refresh the next prompt while preserving external skills", async (t) => {
  const f = await fixture(t);
  const id = await f.draft();
  const external: PiSkill = {
    name: "manual-skill",
    description: "An external manual skill.",
    filePath: path.join(f.cwd, "external", "SKILL.md"),
    baseDir: path.join(f.cwd, "external"),
    disableModelInvocation: false,
    sourceInfo: {
      path: "external",
      source: "test",
      scope: "user",
      origin: "top-level",
    },
  };
  await f.call({ action: "validate", id, validation });
  const first = await f.refresh([external]);
  assert.equal(first.length, 2);
  await f.call({
    action: "draft",
    id,
    document: { ...document, description: "Updated routing description." },
  });
  await f.call({ action: "validate", id, validation });
  const next = await f.refresh(first);
  assert.equal(next.length, 2);
  assert.equal(
    next.find((s) => s.name === candidate.name)?.description,
    "Updated routing description.",
  );
  assert.deepEqual(
    next.find((s) => s.name === external.name),
    external,
  );
});
test("external loaded skill names prevent automatic shadowing", async (t) => {
  const f = await fixture(t);
  const id = await f.draft();
  f.commands.push({
    name: `skill:${candidate.name}`,
    source: "skill",
    sourceInfo: {
      path: path.join(f.cwd, "external", "SKILL.md"),
      source: "test",
      scope: "user",
      origin: "top-level",
    },
  });
  await assert.rejects(
    f.call({ action: "validate", id, validation }),
    /already uses this name/,
  );
  assert.equal((await f.store.get(id, f.cwd)).status, "draft");
});
test("inspection commands are optional and missing inputs remain errors", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.call({ action: "draft" }), /requires id and document/);
  await assert.rejects(
    f.call({ action: "deprecate" }),
    /require id and reason/,
  );
  const id = await f.draft();
  await f.command("list");
  assert.match(f.notifications.at(-1) ?? "", /project:inspect-native-crash/);
  await f.command(`activate ${id}`);
  assert.match(f.notifications.at(-1) ?? "", /publishes automatically/);
});
test("published guidelines remove skill approval requirements but preserve operational safety", () => {
  const text = GUIDELINES.join("\n");
  assert.match(text, /Do not ask for skill-save/);
  assert.match(text, /does not authorize risky underlying actions/);
  assert.doesNotMatch(text, /ask the user|user-reviewed|\/skills activate/);
});
