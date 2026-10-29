import { createHash, randomUUID } from "node:crypto";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
  activate,
  assertSafe,
  CandidateSchema,
  consider,
  DocumentSchema,
  documentHash,
  draft,
  Name,
  publishedContent,
  renderAdopted,
  renderSkill,
  retire,
  skillId,
  validate,
  ValidationSchema,
  type Candidate,
  type Skill,
  type SkillDocument,
  type Validation,
} from "./lifecycle.ts";

export const METADATA_FILE = ".pi-skills.json";
const StoredSkill = Type.Object({
  id: Type.String(),
  generation: Type.String({ minLength: 1 }),
  candidate: CandidateSchema,
  adoption: Type.Optional(
    Type.Object(
      {
        content: Type.String({ minLength: 1, maxLength: 1_000_000 }),
        relativePath: Type.String({ minLength: 1 }),
        sourceSha256: Type.String({ minLength: 1 }),
        at: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  projectRoot: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union(
    ["candidate", "draft", "validated", "active", "deprecated", "archived"].map(
      (s) => Type.Literal(s),
    ),
  ),
  revisions: Type.Array(
    Type.Object({
      number: Type.Integer({ minimum: 1 }),
      document: DocumentSchema,
      hash: Type.String(),
      invalidatedAt: Type.Optional(Type.String()),
      validation: Type.Optional(
        Type.Object(
          {
            ...ValidationSchema.properties,
            hash: Type.String(),
            at: Type.String(),
            sessionId: Type.String(),
            source: Type.Literal("model-report"),
          },
          { additionalProperties: false },
        ),
      ),
    }),
  ),
  activeRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  events: Type.Array(
    Type.Object({
      at: Type.String(),
      kind: Type.String(),
      reason: Type.String(),
    }),
  ),
});
const CatalogSchema = Type.Object({
  version: Type.Literal(2),
  managedBy: Type.Literal("pi-skills"),
  skills: Type.Array(StoredSkill),
});
const LegacySchema = Type.Object({
  version: Type.Literal(1),
  skills: Type.Array(Type.Omit(StoredSkill, ["generation"])),
});
interface Catalog {
  version: 2;
  managedBy: "pi-skills";
  skills: Skill[];
}
interface ScopeCatalog {
  root: string;
  scope: "global" | "project";
  catalog: Catalog;
}
const queues = new Map<string, Promise<unknown>>();
const empty = (): Catalog => ({
  version: 2,
  managedBy: "pi-skills",
  skills: [],
});

// Project identity is the session cwd, not its enclosing Git repository.
export async function projectRoot(cwd: string): Promise<string> {
  return fs.realpath(cwd);
}

async function noSymlinks(target: string): Promise<void> {
  let current = path.resolve(target);
  while (true) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error(`Refusing symlink: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function readText(file: string): Promise<string | null> {
  await noSymlinks(file);
  try {
    if ((await fs.stat(file)).size > 5_000_000)
      throw new Error(`Managed file exceeds 5 MB: ${file}`);
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function decode<T extends TSchema>(
  data: string,
  file: string,
  schema: T,
): Static<T> {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (cause) {
    throw new Error(
      `Malformed skill metadata at ${file}; repair or restore it before retrying. The original file was not changed.`,
      { cause },
    );
  }
  if (!Value.Check(schema, value))
    throw new Error(`Invalid skill metadata; refusing to overwrite ${file}`);
  return value;
}
async function atomicWrite(
  target: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  await noSymlinks(target);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { mode, flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
function checkSkill(skill: Skill, scope: ScopeCatalog["scope"]): void {
  if (skill.id !== skillId(skill.candidate) || skill.candidate.scope !== scope)
    throw new Error("Invalid skill identity in metadata.");
  assertSafe(skill);
  if (skill.adoption) {
    const allowed =
      scope === "global"
        ? [`skills/${skill.candidate.name}/SKILL.md`]
        : [
            `.pi/skills/${skill.candidate.name}/SKILL.md`,
            `.agents/skills/${skill.candidate.name}/SKILL.md`,
          ];
    if (
      !allowed.includes(skill.adoption.relativePath) ||
      !/^---\r?\n/.test(skill.adoption.content) ||
      createHash("sha256").update(skill.adoption.content).digest("hex") !==
        skill.adoption.sourceSha256
    )
      throw new Error("Invalid adopted skill source or native skill path.");
  }
  for (const [index, revision] of skill.revisions.entries()) {
    if (
      revision.number !== index + 1 ||
      revision.hash !== documentHash(revision.document) ||
      (revision.validation &&
        (revision.validation.hash !== revision.hash ||
          revision.validation.checks.some((c) => c.outcome !== "pass")))
    )
      throw new Error("Invalid revision evidence in metadata.");
  }
  if (
    (skill.status === "active" &&
      skill.activeRevision === null &&
      !skill.adoption) ||
    (skill.status !== "active" && skill.activeRevision !== null) ||
    (skill.activeRevision !== null &&
      (!skill.revisions[skill.activeRevision - 1]?.validation ||
        skill.revisions[skill.activeRevision - 1]?.invalidatedAt !== undefined))
  )
    throw new Error("Invalid active revision in metadata.");
}

export class SkillStore {
  readonly root: string;
  constructor(agentDir: string) {
    this.root = path.resolve(agentDir);
  }
  scopeRoot(project: string, scope: "global" | "project"): string {
    return scope === "global"
      ? path.join(this.root, "skills")
      : path.join(project, ".pi", "skills");
  }
  catalogPath(project: string, scope: "global" | "project"): string {
    return path.join(this.scopeRoot(project, scope), METADATA_FILE);
  }
  skillPath(skill: Skill, project: string): string {
    if (skill.adoption)
      return path.join(
        skill.candidate.scope === "global" ? this.root : project,
        ...skill.adoption.relativePath.split("/"),
      );
    return path.join(
      this.scopeRoot(project, skill.candidate.scope),
      skill.candidate.name,
      "SKILL.md",
    );
  }

  private async load(project: string): Promise<ScopeCatalog[]> {
    const scopes: ScopeCatalog[] = [];
    for (const scope of ["global", "project"] as const) {
      const root = this.scopeRoot(project, scope);
      const file = this.catalogPath(project, scope);
      const data = await readText(file);
      let catalog = empty();
      if (data !== null) {
        catalog = decode(data, file, CatalogSchema) as Catalog;
      }
      const ids = new Set<string>();
      for (const skill of catalog.skills) {
        checkSkill(skill, scope);
        if (scope === "project") skill.projectRoot = project;
        if (ids.has(skill.id))
          throw new Error("Duplicate skill identity in metadata.");
        ids.add(skill.id);
      }
      scopes.push({ root, scope, catalog });
    }
    return scopes;
  }

  private async mutate<T>(
    project: string,
    operation: (scopes: ScopeCatalog[]) => Promise<T>,
    afterCommit?: (result: T) => Promise<void>,
  ): Promise<T> {
    const previous = queues.get(this.root) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        const locks: string[] = [];
        try {
          // All writers lock both roots in the same order, including shared global writes.
          for (const root of [
            ...new Set([
              this.scopeRoot(project, "global"),
              this.scopeRoot(project, "project"),
            ]),
          ].sort()) {
            await noSymlinks(root);
            await fs.mkdir(root, { recursive: true, mode: 0o700 });
            const lock = path.join(root, ".pi-skills-lock");
            try {
              await fs.mkdir(lock, { mode: 0o700 });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST")
                throw new Error(
                  `Skill store is locked: ${lock}. Retry after the writer exits; remove stale locks only after verifying no writer is running.`,
                );
              throw error;
            }
            locks.push(lock);
          }
          const scopes = await this.load(project);
          const before = scopes.map((s) => JSON.stringify(s.catalog));
          const originals = await Promise.all(
            scopes.map((s) => readText(path.join(s.root, METADATA_FILE))),
          );
          const result = await operation(scopes);
          const written: number[] = [];
          try {
            for (const [i, entry] of scopes.entries()) {
              const contents = JSON.stringify(entry.catalog);
              if (contents === before[i]) continue;
              if (Buffer.byteLength(contents) > 5_000_000)
                throw new Error("Skill metadata exceeds 5 MB.");
              await atomicWrite(
                path.join(entry.root, METADATA_FILE),
                `${JSON.stringify(entry.catalog, null, 2)}\n`,
              );
              written.push(i);
            }
            await afterCommit?.(result);
            return result;
          } catch (error) {
            try {
              // A failed native-file publication must not claim the new revision is active.
              for (const i of written.toReversed()) {
                const file = path.join(scopes[i].root, METADATA_FILE);
                const original = originals[i];
                if (original === null) await fs.unlink(file);
                else await atomicWrite(file, original);
              }
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "Skill publication failed and metadata rollback could not complete; do not treat the new revision as active.",
              );
            }
            throw error;
          }
        } finally {
          for (const lock of locks.reverse()) await fs.rmdir(lock);
        }
      });
    queues.set(this.root, task);
    try {
      return await task;
    } finally {
      if (queues.get(this.root) === task) queues.delete(this.root);
    }
  }

  async list(project: string): Promise<Skill[]> {
    return (await this.load(project)).flatMap((s) => s.catalog.skills);
  }
  async get(id: string, project: string): Promise<Skill> {
    const skill = (await this.list(project)).find((s) => s.id === id);
    if (!skill)
      throw new Error("Skill not found in this project/global scope.");
    return skill;
  }

  private async checkProjection(
    skill: Skill,
    project: string,
  ): Promise<string | null> {
    const file = this.skillPath(skill, project);
    const contents = await readText(file);
    if (
      contents !== null &&
      contents !== renderAdopted(skill) &&
      !skill.revisions.some((r) => renderSkill(skill, r) === contents)
    )
      throw new Error(
        `Skill was manually modified or is unmanaged; preserving ${file}`,
      );
    return contents;
  }
  private async publish(skill: Skill, project: string): Promise<void> {
    const existing = await this.checkProjection(skill, project);
    const file = this.skillPath(skill, project);
    const contents = publishedContent(skill);
    if (contents === null) {
      if (existing !== null) await fs.unlink(file);
      return;
    }
    if (contents !== existing) await atomicWrite(file, contents);
  }

  private async assertUnclaimed(skill: Skill, project: string): Promise<void> {
    const folder = path.dirname(this.skillPath(skill, project));
    await noSymlinks(folder);
    const root = this.scopeRoot(project, skill.candidate.scope);
    for (const target of [
      folder,
      path.join(root, `${skill.candidate.name}.md`),
    ]) {
      try {
        await fs.lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error(
        `Existing unmanaged skill path cannot be claimed: ${target}`,
      );
    }
  }

  // Operator-only import boundary: ordinary generation never claims an unmarked file.
  async adopt(
    candidate: Candidate,
    project: string,
    source: string,
    reason: string,
  ): Promise<Skill> {
    assertSafe(reason);
    const skill = consider(candidate, project);
    const base = candidate.scope === "global" ? this.root : project;
    const file = path.resolve(source);
    const relativePath = path.relative(base, file).split(path.sep).join("/");
    const allowed =
      candidate.scope === "global"
        ? [`skills/${candidate.name}/SKILL.md`]
        : [
            `.pi/skills/${candidate.name}/SKILL.md`,
            `.agents/skills/${candidate.name}/SKILL.md`,
          ];
    if (!allowed.includes(relativePath))
      throw new Error(
        "Adoption requires a matching native skill path in the selected scope.",
      );
    const result = await this.mutate(
      project,
      async (scopes) => {
        const entry = scopes.find((s) => s.scope === candidate.scope);
        if (!entry) throw new Error("Unknown scope.");
        const existing = entry.catalog.skills.find((s) => s.id === skill.id);
        if (existing) {
          if (existing.adoption?.relativePath !== relativePath)
            throw new Error(
              "A different managed skill already uses this name.",
            );
          await this.checkProjection(existing, project);
          return { skill: existing, created: false, mode: 0o600 };
        }
        const content = await readText(file);
        if (content === null)
          throw new Error("The external skill source does not exist.");
        assertSafe(content);
        const { frontmatter } = parseFrontmatter(content);
        if (
          !/^---\r?\n/.test(content) ||
          frontmatter.name !== candidate.name ||
          typeof frontmatter.description !== "string" ||
          !frontmatter.description.trim()
        )
          throw new Error(
            "External skill name/description/frontmatter does not match the adoption request.",
          );
        const metadata = frontmatter.metadata;
        if (
          frontmatter["pi-skills-adopted"] !== undefined ||
          (metadata &&
            typeof metadata === "object" &&
            "pi-skills-generated" in metadata)
        )
          throw new Error(
            "A marked skill without matching ownership metadata cannot be adopted.",
          );
        skill.adoption = {
          content,
          relativePath,
          sourceSha256: createHash("sha256").update(content).digest("hex"),
          at: new Date().toISOString(),
          reason,
        };
        skill.status = "active";
        skill.events.push({
          at: skill.adoption.at,
          kind: "adopt",
          reason: `${reason} Existing active procedure retained; no execution validation is claimed.`,
        });
        checkSkill(skill, candidate.scope);
        entry.catalog.skills.push(skill);
        return {
          skill,
          created: true,
          mode: (await fs.stat(file)).mode & 0o777,
        };
      },
      async (imported) => {
        if (!imported.created) return;
        if ((await readText(file)) !== imported.skill.adoption?.content)
          throw new Error(
            "External skill changed during adoption; preserving the file.",
          );
        const stamped = renderAdopted(imported.skill);
        if (stamped === null) throw new Error("Adoption source is missing.");
        await atomicWrite(file, stamped, imported.mode);
      },
    );
    return result.skill;
  }

  private async repairNativeReferences(
    id: string,
    project: string,
  ): Promise<Skill> {
    const repaired = await this.mutate(
      project,
      async (scopes) => {
        const entry = scopes.find((scope) =>
          scope.catalog.skills.some((skill) => skill.id === id),
        );
        const index =
          entry?.catalog.skills.findIndex((skill) => skill.id === id) ?? -1;
        if (!entry || index < 0)
          throw new Error("Skill not found in this project/global scope.");
        const previous = entry.catalog.skills[index];
        if (
          !previous.adoption ||
          previous.candidate.scope !== "project" ||
          previous.activeRevision !== null ||
          previous.status !== "active"
        )
          return { skill: previous, before: null, after: null, mode: 0o600 };
        const mappings = entry.catalog.skills
          .filter(
            (skill) =>
              skill.adoption?.relativePath ===
              `.pi/skills/${skill.candidate.name}/SKILL.md`,
          )
          .map(
            (skill) =>
              [
                `.agents/skills/${skill.candidate.name}/`,
                `.pi/skills/${skill.candidate.name}/`,
              ] as const,
          );
        const rewrite = (text: string) =>
          mappings.reduce(
            (value, [from, to]) => value.replaceAll(from, to),
            text,
          );
        const skill = structuredClone(previous);
        if (!skill.adoption) throw new Error("Adoption metadata missing.");
        const originalHash = skill.adoption.sourceSha256;
        skill.adoption.content = rewrite(skill.adoption.content);
        skill.adoption.sourceSha256 = createHash("sha256")
          .update(skill.adoption.content)
          .digest("hex");
        skill.candidate.sourceRefs = skill.candidate.sourceRefs.map(rewrite);
        skill.candidate.relatedSkills = skill.candidate.relatedSkills.map(
          (related) => ({ ...related, path: rewrite(related.path) }),
        );
        if (JSON.stringify(skill) === JSON.stringify(previous))
          return { skill: previous, before: null, after: null, mode: 0o600 };
        const before = await this.checkProjection(previous, project);
        if (before === null)
          throw new Error(
            "The adopted baseline is missing; refusing to recreate it during reference repair.",
          );
        skill.events.push({
          at: new Date().toISOString(),
          kind: "repair-references",
          reason: `Normalized relocated skill references and current source pointers. Baseline checksum changed from ${originalHash} to ${skill.adoption.sourceSha256}; this is a mechanical path repair, not execution validation.`,
        });
        checkSkill(skill, skill.candidate.scope);
        entry.catalog.skills[index] = skill;
        return {
          skill,
          before,
          after: renderAdopted(skill),
          mode: (await fs.stat(this.skillPath(previous, project))).mode & 0o777,
        };
      },
      async (result) => {
        if (
          result.before === null ||
          result.after === null ||
          result.before === result.after
        )
          return;
        const file = this.skillPath(result.skill, project);
        if ((await readText(file)) !== result.before)
          throw new Error(
            "Skill changed during reference repair; preserving the file.",
          );
        await atomicWrite(file, result.after, result.mode);
      },
    );
    return repaired.skill;
  }

  async moveToNative(id: string, project: string): Promise<Skill> {
    const moved = await this.mutate(
      project,
      async (scopes) => {
        const entry = scopes.find((scope) =>
          scope.catalog.skills.some((skill) => skill.id === id),
        );
        const index =
          entry?.catalog.skills.findIndex((skill) => skill.id === id) ?? -1;
        if (!entry || index < 0)
          throw new Error("Skill not found in this project/global scope.");
        const previous = entry.catalog.skills[index];
        const source = path.dirname(this.skillPath(previous, project));
        const target = path.join(
          this.scopeRoot(project, previous.candidate.scope),
          previous.candidate.name,
        );
        if (source === target)
          return { skill: previous, previous, source: null, target: null };
        if (!previous.adoption)
          throw new Error(
            "Only an explicitly adopted skill can have a non-native source path.",
          );
        await this.checkProjection(previous, project);
        const skill = structuredClone(previous);
        if (!skill.adoption) throw new Error("Adoption metadata missing.");
        const from = skill.adoption.relativePath;
        skill.adoption.relativePath =
          previous.candidate.scope === "global"
            ? `skills/${previous.candidate.name}/SKILL.md`
            : `.pi/skills/${previous.candidate.name}/SKILL.md`;
        await this.assertUnclaimed(skill, project);
        skill.events.push({
          at: new Date().toISOString(),
          kind: "relocate",
          reason: `Moved from ${from} to ${skill.adoption.relativePath}; content, assets, ownership and validation history are unchanged.`,
        });
        entry.catalog.skills[index] = skill;
        return { skill, previous, source, target };
      },
      async (result) => {
        if (result.source === null || result.target === null) return;
        await this.checkProjection(result.previous, project);
        await this.assertUnclaimed(result.skill, project);
        await fs.rename(result.source, result.target);
      },
    );
    return this.repairNativeReferences(moved.skill.id, project);
  }

  async consider(candidate: Candidate, project: string): Promise<Skill> {
    const skill = consider(candidate, project);
    return this.mutate(project, async (scopes) => {
      const entry = scopes.find((s) => s.scope === candidate.scope);
      if (!entry) throw new Error("Unknown scope.");
      if (entry.catalog.skills.some((s) => s.id === skill.id))
        throw new Error("Candidate already exists; revise it instead.");
      await this.assertUnclaimed(skill, project);
      entry.catalog.skills.push(skill);
      return skill;
    });
  }

  private async change(
    id: string,
    project: string,
    update: (skill: Skill, scopes: ScopeCatalog[]) => Skill | Promise<Skill>,
  ): Promise<Skill> {
    // Parsing an id never permits arbitrary paths.
    const [scope, name, extra] = id.split(":");
    if (
      (scope !== "global" && scope !== "project") ||
      extra !== undefined ||
      !Value.Check(Name, name)
    )
      throw new Error("Invalid skill id; use global:<name> or project:<name>.");
    const next = await this.mutate(
      project,
      async (scopes) => {
        const entry = scopes.find((s) => s.scope === scope);
        const index = entry?.catalog.skills.findIndex((s) => s.id === id) ?? -1;
        if (!entry || index < 0)
          throw new Error("Skill not found in this project/global scope.");
        const skill = entry.catalog.skills[index];
        await this.checkProjection(skill, project);
        const updated = await update(skill, scopes);
        entry.catalog.skills[index] = updated;
        return updated;
      },
      (updated) => this.publish(updated, project),
    );
    return next;
  }
  async draft(
    id: string,
    project: string,
    document: SkillDocument,
  ): Promise<Skill> {
    return this.change(id, project, (skill) => draft(skill, document));
  }
  async validate(
    id: string,
    project: string,
    evidence: Validation,
    sessionId: string,
    externalNames: string[] = [],
  ): Promise<Skill> {
    return this.change(id, project, async (skill, scopes) => {
      const checked = validate(skill, evidence, sessionId);
      if (
        externalNames.includes(skill.candidate.name) ||
        scopes.some((s) =>
          s.catalog.skills.some(
            (other) =>
              other.id !== id &&
              other.status === "active" &&
              other.candidate.name === skill.candidate.name,
          ),
        )
      )
        throw new Error(
          "An active or external skill already uses this name; choose a distinct name.",
        );
      for (const entry of scopes) {
        if (entry.scope === skill.candidate.scope) continue;
        for (const target of [
          path.join(entry.root, skill.candidate.name, "SKILL.md"),
          path.join(entry.root, `${skill.candidate.name}.md`),
        ]) {
          if ((await readText(target)) !== null)
            throw new Error(
              `An existing skill already uses this name: ${target}`,
            );
        }
      }
      return activate(checked);
    });
  }
  async retire(
    id: string,
    project: string,
    status: "deprecated" | "archived",
    reason: string,
  ): Promise<Skill> {
    return this.change(id, project, (skill) =>
      retire(
        status === "archived" && skill.status === "active"
          ? retire(skill, "deprecated", reason)
          : skill,
        status,
        reason,
      ),
    );
  }

  async discoveryPaths(project: string): Promise<string[]> {
    const paths: string[] = [];
    for (const skill of await this.list(project)) {
      const contents = publishedContent(skill);
      if (contents === null) continue;
      const file = this.skillPath(skill, project);
      // Never overwrite hand edits or recreate a manually removed file during discovery.
      if ((await readText(file)) === contents) paths.push(file);
    }
    return paths;
  }

  async migrateLegacy(project: string): Promise<void> {
    const file = path.join(this.root, "pi-skills", "catalog.json");
    const contents = await readText(file);
    if (contents === null) return;
    const legacy = decode(contents, file, LegacySchema);
    for (const old of legacy.skills) {
      if (old.projectRoot !== null && old.projectRoot !== project) continue;
      const id = skillId(old.candidate);
      if ((await this.list(project)).some((s) => s.id === id)) continue;
      const imported: Skill = {
        ...old,
        id,
        generation: randomUUID(),
        projectRoot: old.candidate.scope === "project" ? project : null,
      };
      imported.events.push({
        at: new Date().toISOString(),
        kind: "migrate",
        reason:
          "Imported from v0.1.0 without deleting the original catalog or resource files.",
      });
      checkSkill(imported, imported.candidate.scope);
      await this.mutate(
        project,
        async (scopes) => {
          const entry = scopes.find(
            (s) => s.scope === imported.candidate.scope,
          );
          if (!entry || entry.catalog.skills.some((s) => s.id === id))
            return null;
          await this.assertUnclaimed(imported, project);
          entry.catalog.skills.push(imported);
          return imported;
        },
        async (created) => {
          if (created) await this.publish(created, project);
        },
      );
    }
  }
}
