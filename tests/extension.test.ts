import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
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
import { candidate, document, validation, useEvidence } from "./fixtures.ts";

type Discovery = (
  event: ResourcesDiscoverEvent,
  ctx: ExtensionContext,
) => Promise<ResourcesDiscoverResult>;
type Before = (
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | undefined>;
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
  let request = 0;
  let timestamp = new Date().toISOString();
  let userEntry = true;
  const nextRequest = () => {
    request++;
    timestamp = new Date().toISOString();
  };
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
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () =>
        userEntry
          ? [
              {
                type: "message",
                id: `request-${request}`,
                parentId: null,
                timestamp,
                message: {
                  role: "user",
                  content: [{ type: "text", text: "Task prompt" }],
                  timestamp: Date.parse(timestamp),
                },
              },
            ]
          : [],
    },
    async reload() {
      assert.fail("Skill lifecycle must not require reload.");
    },
  } as unknown as ExtensionCommandContext & ExtensionToolContext;
  const call = (args: Record<string, unknown>) =>
    registered.tool.execute("call", args, undefined, undefined, context);
  const store = new SkillStore(agent);
  const draft = async () => {
    await call({ action: "capture", candidate, document });
    return (await store.list(cwd))[0].id;
  };
  const promote = async (id: string) => {
    await call({ action: "validate", id, validation });
    nextRequest();
    await call({ action: "record_use", id, use: useEvidence });
  };
  const recalls: BeforeAgentStartEventResult[] = [];
  const refresh = async (skills: PiSkill[] = [], prompt = "Task prompt") => {
    const event = {
      messageType: "user",
      prompt,
      systemPromptOptions: { skills },
    } as BeforeAgentStartEvent;
    const result = await registered.before(event, context);
    if (result) recalls.push(result);
    return event.systemPromptOptions.skills;
  };
  return {
    cwd,
    agent,
    context,
    call,
    store,
    draft,
    promote,
    refresh,
    nextRequest,
    recalls,
    notifications,
    commands,
    emptyBranch: () => {
      userEntry = false;
    },
    command: (args: string) => registered.command.handler(args, context),
    discover: () =>
      registered.discovery(
        { type: "resources_discover", cwd, reason: "reload" },
        context,
      ),
  };
}

test("headless capture stays provisional until an independent runtime request reuses it", async (t) => {
  const f = await fixture(t);
  const id = await f.draft();
  await f.call({ action: "validate", id, validation });
  assert.equal((await f.store.get(id, f.cwd)).status, "validated");
  assert.deepEqual((await f.discover()).skillPaths, []);
  await assert.rejects(
    f.call({
      action: "record_use",
      id,
      use: useEvidence,
      task: { requestId: "forged" },
    }),
    /independent|capture task/,
  );
  f.nextRequest();
  await f.call({ action: "record_use", id, use: useEvidence });
  assert.equal((await f.store.get(id, f.cwd)).status, "active");
  assert.equal((await f.discover()).skillPaths?.length, 1);
  assert.equal((await f.refresh())[0]?.name, candidate.name);
});
test("candidate search and bounded automatic recall work without exposing candidates as active skills", async (t) => {
  const f = await fixture(t);
  const id = await f.draft();
  const response = await f.call({
    action: "search",
    query: "vendor native crash",
  });
  assert.ok(
    response.content.some((c) => c.type === "text" && c.text.includes(id)),
  );
  assert.deepEqual(await f.refresh([], "vendor native crash"), []);
  assert.equal(f.recalls.length, 1);
  assert.equal(f.recalls[0].message?.display, false);
  assert.ok(JSON.stringify(f.recalls[0].message).includes(id));
  assert.ok(JSON.stringify(f.recalls[0].message).includes("reference data"));
});
test("normal tool access automatically expires unused candidates without confirmation", async (t) => {
  const f = await fixture(t);
  const id = await f.draft();
  const file = f.store.catalogPath(f.cwd, "project");
  const metadata = JSON.parse(await fs.readFile(file, "utf8"));
  metadata.skills[0].learning.createdAt = "2000-01-01T00:00:00.000Z";
  metadata.skills[0].learning.captureTask.startedAt =
    "2000-01-01T00:00:00.000Z";
  await fs.writeFile(file, JSON.stringify(metadata));
  const response = await f.call({ action: "search", query: "native crash" });
  assert.equal(
    JSON.parse(response.content.find((c) => c.type === "text")?.text ?? "null")
      .length,
    0,
  );
  assert.deepEqual(await f.store.list(f.cwd), []);
  assert.ok(id);
});
test("an unowned SKILL.md in a candidate folder remains an external loaded skill", async (t) => {
  const f = await fixture(t);
  const id = await f.draft();
  const file = f.store.skillPath(await f.store.get(id, f.cwd), f.cwd);
  await fs.writeFile(file, "External manual skill.");
  const external: PiSkill = {
    name: candidate.name,
    description: "External manual skill.",
    filePath: file,
    baseDir: path.dirname(file),
    disableModelInvocation: false,
    sourceInfo: {
      path: file,
      source: "test",
      scope: "project",
      origin: "top-level",
    },
  };
  assert.deepEqual(await f.refresh([external]), [external]);
});
test("the agent can deprecate and archive without user commands", async (t) => {
  const f = await fixture(t);
  const id = await f.draft();
  await f.promote(id);
  const active = await f.refresh();
  await f.call({ action: "deprecate", id, reason: "Toolchain changed." });
  assert.deepEqual(await f.refresh(active), []);
  await f.call({ action: "archive", id, reason: "Superseded." });
  assert.equal((await f.store.get(id, f.cwd)).status, "archived");
});
test("verified updates refresh the next prompt while preserving external skills", async (t) => {
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
  await f.promote(id);
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
test("external loaded names prevent promotion, but not storing a provisional procedure", async (t) => {
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
  await f.call({ action: "validate", id, validation });
  f.nextRequest();
  await assert.rejects(
    f.call({ action: "record_use", id, use: useEvidence }),
    /already uses this name/,
  );
  assert.equal((await f.store.get(id, f.cwd)).status, "validated");
});
test("real user identity is required, optional inspection remains available, and invalid actions fail clearly", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.call({ action: "draft" }), /requires id and document/);
  await assert.rejects(
    f.call({ action: "deprecate" }),
    /require id and reason/,
  );
  await assert.rejects(f.call({ action: "invalid" }), /Unsupported/);
  const id = await f.draft();
  await f.command("list");
  assert.match(f.notifications.at(-1) ?? "", /project:inspect-native-crash/);
  await f.command(`activate ${id}`);
  assert.match(f.notifications.at(-1) ?? "", /independent reuse/);
  f.emptyBranch();
  await assert.rejects(
    f.call({ action: "draft", id, document }),
    /real user request entry/,
  );
});
test("guidelines require broad capture, actual reuse, and 90-day expiry without manual approval", () => {
  const text = GUIDELINES.join("\n");
  assert.match(text, /do not ask for skill-save/i);
  assert.match(text, /does not authorize risky underlying actions/);
  assert.match(text, /original pi-hermes-memory capture cues/);
  assert.match(text, /90 unused calendar days/);
  assert.doesNotMatch(text, /ask the user|user-reviewed|\/skills activate/);
});
