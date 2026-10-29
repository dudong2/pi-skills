import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  activate,
  assertSafe,
  CandidateSchema,
  consider,
  DocumentSchema,
  documentHash,
  draft,
  renderSkill,
  retire,
  reviewHash,
  skillId,
  validate,
  ValidationSchema,
  type Candidate,
  type Skill,
  type SkillDocument,
  type Validation,
} from "./lifecycle.ts";

const StoredSkill = Type.Object({
  id: Type.String(),
  candidate: CandidateSchema,
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
  version: Type.Literal(1),
  skills: Type.Array(StoredSkill),
});
interface Catalog {
  version: 1;
  skills: Skill[];
}
const queues = new Map<string, Promise<unknown>>();

export async function projectRoot(cwd: string): Promise<string> {
  const real = await fs.realpath(cwd);
  let current = real;
  while (true) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return real;
    current = parent;
  }
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

async function atomicWrite(target: string, contents: string): Promise<void> {
  await noSymlinks(target);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export class SkillStore {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  get catalogPath(): string {
    return path.join(this.root, "catalog.json");
  }

  private async load(): Promise<Catalog> {
    await noSymlinks(this.catalogPath);
    let data: string;
    try {
      if ((await fs.stat(this.catalogPath)).size > 5_000_000)
        throw new Error("Skill catalog exceeds 5 MB.");
      data = await fs.readFile(this.catalogPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, skills: [] };
      throw error;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch (cause) {
      throw new Error(
        `Malformed skill catalog at ${this.catalogPath}; repair or restore it before retrying. The original file was not changed.`,
        { cause },
      );
    }
    if (!Value.Check(CatalogSchema, decoded))
      throw new Error("Invalid skill catalog; refusing to overwrite it.");
    const catalog = decoded as Catalog;
    const ids = new Set<string>();
    for (const skill of catalog.skills) {
      if (
        ids.has(skill.id) ||
        skill.id !== skillId(skill.candidate, skill.projectRoot ?? "") ||
        (skill.candidate.scope === "project" &&
          (!skill.projectRoot || !path.isAbsolute(skill.projectRoot))) ||
        (skill.candidate.scope === "global" && skill.projectRoot !== null)
      )
        throw new Error("Invalid skill identity in catalog.");
      ids.add(skill.id);
      assertSafe(skill);
      for (const [index, revision] of skill.revisions.entries()) {
        if (
          revision.number !== index + 1 ||
          revision.hash !== documentHash(revision.document) ||
          (revision.validation &&
            (revision.validation.hash !== revision.hash ||
              revision.validation.checks.some((c) => c.outcome !== "pass")))
        )
          throw new Error("Invalid revision evidence in catalog.");
      }
      if (
        (skill.status === "active") !== (skill.activeRevision !== null) ||
        (skill.activeRevision !== null &&
          (!skill.revisions[skill.activeRevision - 1]?.validation ||
            skill.revisions[skill.activeRevision - 1]?.invalidatedAt !==
              undefined))
      )
        throw new Error("Invalid active revision in catalog.");
    }
    return catalog;
  }

  private async mutate<T>(
    operation: (catalog: Catalog) => T | Promise<T>,
  ): Promise<T> {
    const previous = queues.get(this.root) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        await noSymlinks(this.root);
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        const lock = path.join(this.root, ".mutation-lock");
        try {
          await fs.mkdir(lock, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new Error(
              `Skill store is locked: ${lock}. Retry after the writer exits; remove a stale lock only after verifying no writer is running.`,
            );
          throw error;
        }
        try {
          const catalog = await this.load();
          const result = await operation(catalog);
          const serialized = JSON.stringify(catalog, null, 2) + "\n";
          if (Buffer.byteLength(serialized) > 5_000_000)
            throw new Error("Skill catalog exceeds 5 MB.");
          await atomicWrite(this.catalogPath, serialized);
          return result;
        } finally {
          await fs.rmdir(lock);
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
    return (await this.load()).skills.filter(
      (skill) => skill.projectRoot === null || skill.projectRoot === project,
    );
  }

  async get(id: string, project: string): Promise<Skill> {
    const skill = (await this.list(project)).find((item) => item.id === id);
    if (!skill)
      throw new Error("Skill not found in this project/global scope.");
    return skill;
  }

  async consider(candidate: Candidate, project: string): Promise<Skill> {
    const skill = consider(candidate, project);
    return this.mutate((catalog) => {
      if (catalog.skills.some((entry) => entry.id === skill.id))
        throw new Error("Candidate already exists; revise it instead.");
      catalog.skills.push(skill);
      return skill;
    });
  }

  private async change(
    id: string,
    project: string,
    update: (skill: Skill, catalog: Catalog) => Skill,
  ): Promise<Skill> {
    return this.mutate((catalog) => {
      const index = catalog.skills.findIndex(
        (s) =>
          s.id === id && (s.projectRoot === null || s.projectRoot === project),
      );
      if (index < 0)
        throw new Error("Skill not found in this project/global scope.");
      const next = update(catalog.skills[index], catalog);
      catalog.skills[index] = next;
      return next;
    });
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
  ): Promise<Skill> {
    return this.change(id, project, (skill) =>
      validate(skill, evidence, sessionId),
    );
  }
  async activate(
    id: string,
    project: string,
    expectedReviewHash: string,
    externalNames: string[],
  ): Promise<Skill> {
    return this.change(id, project, (skill, catalog) => {
      if (reviewHash(skill) !== expectedReviewHash)
        throw new Error(
          "Revision or evidence changed since review; review it again.",
        );
      if (
        externalNames.includes(skill.candidate.name) ||
        catalog.skills.some(
          (s) =>
            s.id !== id &&
            s.status === "active" &&
            s.candidate.name === skill.candidate.name &&
            (s.projectRoot === null ||
              skill.projectRoot === null ||
              s.projectRoot === skill.projectRoot),
        )
      )
        throw new Error(
          "An active or external skill already uses this name; choose a distinct name.",
        );
      return activate(skill);
    });
  }
  async retire(
    id: string,
    project: string,
    status: "deprecated" | "archived",
    reason: string,
  ): Promise<Skill> {
    return this.change(id, project, (skill) => retire(skill, status, reason));
  }

  async discoveryPaths(project: string): Promise<string[]> {
    const paths: string[] = [];
    for (const skill of await this.list(project)) {
      if (skill.status !== "active" || skill.activeRevision === null) continue;
      const revision = skill.revisions[skill.activeRevision - 1];
      const contents = renderSkill(skill, revision);
      const hash = createHash("sha256").update(contents).digest("hex");
      const file = path.join(this.root, "resources", hash, "SKILL.md");
      await atomicWrite(file, contents);
      paths.push(file);
    }
    return paths;
  }
}
