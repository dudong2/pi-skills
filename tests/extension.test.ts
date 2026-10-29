import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  RegisteredCommand,
  ResourcesDiscoverEvent,
  ResourcesDiscoverResult,
  SlashCommandInfo,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import piSkills from "../src/index.ts";
import { SkillStore } from "../src/store.ts";
import { candidate, document, validation } from "./fixtures.ts";

type Discovery = (
  event: ResourcesDiscoverEvent,
  ctx: ExtensionContext,
) => Promise<ResourcesDiscoverResult>;
async function fixture(t: test.TestContext) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-extension-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temp;
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  });
  let tool: ToolDefinition | undefined;
  let command: Pick<RegisteredCommand, "handler"> | undefined;
  let discovery: Discovery | undefined;
  const commands: SlashCommandInfo[] = [];
  piSkills({
    on(_name: string, handler: Discovery) {
      discovery = handler;
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
  assert.ok(tool && command && discovery);
  const registered = { tool, command, discovery };
  const notifications: string[] = [];
  let reloads = 0;
  let confirmed = false;
  let reviewText = "";
  const context = {
    cwd: temp,
    hasUI: true,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      async confirm(_title: string, message: string) {
        reviewText = message;
        return confirmed;
      },
    },
    sessionManager: { getSessionId: () => "test-session" },
    async reload() {
      reloads++;
    },
  } as unknown as ExtensionCommandContext & ExtensionToolContext;
  const call = (args: Record<string, unknown>) =>
    registered.tool.execute("call", args, undefined, undefined, context);
  const store = new SkillStore(path.join(temp, "pi-skills"));
  const ready = async () => {
    await call({ action: "consider", candidate });
    const [skill] = await store.list(temp);
    await call({ action: "draft", id: skill.id, document });
    await call({ action: "validate", id: skill.id, validation });
    return skill.id;
  };
  return {
    temp,
    context,
    call,
    store,
    ready,
    notifications,
    commands,
    command: (args: string) => registered.command.handler(args, context),
    discover: () =>
      registered.discovery(
        { type: "resources_discover", cwd: temp, reason: "reload" },
        context,
      ),
    approve: () => {
      confirmed = true;
    },
    reloads: () => reloads,
    reviewText: () => reviewText,
  };
}

test("model tools cannot activate or use explicit-user-request bypass", async (t) => {
  const f = await fixture(t);
  const id = await f.ready();
  await assert.rejects(
    f.call({ action: "activate", id, explicit_user_request: true }),
    /Unsupported/,
  );
  assert.deepEqual((await f.discover()).skillPaths, []);
});
test("activation requires user confirmation and publishes only after approval", async (t) => {
  const f = await fixture(t);
  const id = await f.ready();
  await f.command(`activate ${id}`);
  assert.equal(f.reloads(), 0);
  assert.deepEqual((await f.discover()).skillPaths, []);
  f.approve();
  await f.command(`activate ${id}`);
  assert.equal(f.reloads(), 1);
  assert.match(f.reviewText(), /독립 검증이 아님/);
  assert.equal((await f.discover()).skillPaths?.length, 1);
  await f.command(`deprecate ${id} Toolchain changed.`);
  assert.equal(f.reloads(), 2);
  assert.deepEqual((await f.discover()).skillPaths, []);
  await f.command(`archive ${id} Replaced by a new procedure.`);
  assert.equal((await f.store.get(id, f.temp)).status, "archived");
});
test("noninteractive activation fails closed with no reload", async (t) => {
  const f = await fixture(t);
  const id = await f.ready();
  f.context.hasUI = false;
  await f.command(`activate ${id}`);
  assert.equal(f.reloads(), 0);
  assert.match(f.notifications.at(-1) ?? "", /requires an interactive/);
});
test("external loaded skills cannot be shadowed", async (t) => {
  const f = await fixture(t);
  const id = await f.ready();
  f.commands.push({
    name: `skill:${candidate.name}`,
    source: "skill",
    sourceInfo: {
      path: path.join(f.temp, "external", "SKILL.md"),
      source: "test",
      scope: "user",
      origin: "top-level",
    },
  });
  f.approve();
  await f.command(`activate ${id}`);
  assert.equal(f.reloads(), 0);
  assert.match(f.notifications.at(-1) ?? "", /already uses this name/);
});
test("missing inputs and malformed storage are reported rather than overwritten", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.call({ action: "draft" }), /requires id and document/);
  await f.ready();
  await fs.writeFile(f.store.catalogPath, "{broken");
  await f.command("list");
  assert.match(f.notifications.at(-1) ?? "", /Malformed skill catalog/);
  assert.equal(await fs.readFile(f.store.catalogPath, "utf8"), "{broken");
});
