import { createHash, randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { scanContent } from "./content-scanner.ts";
import {
  assertFresh,
  canPromote,
  checkTask,
  directTask,
  learningOf,
  TriggerSchema,
  type Learning,
  type TaskIdentity,
} from "./learning.ts";

const text = Type.String({ minLength: 1, maxLength: 8000 });
const texts = Type.Array(text, { minItems: 1, maxItems: 30 });
export const Name = Type.String({
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  maxLength: 64,
});
export const CandidateSchema = Type.Object(
  {
    name: Name,
    scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
    trigger: Type.Optional(TriggerSchema),
    reuse: Type.Optional(text),
    procedure: text,
    differentiation: Type.Optional(text),
    benefit: Type.Optional(text),
    sourceRefs: texts,
    relatedSkills: Type.Array(Type.Object({ path: text, comparison: text }), {
      maxItems: 30,
    }),
  },
  { additionalProperties: false },
);
export const CaptureSchema = Type.Object(
  { ...CandidateSchema.properties, trigger: TriggerSchema },
  { additionalProperties: false },
);
export const DocumentSchema = Type.Object(
  {
    description: Type.String({ minLength: 1, maxLength: 1024 }),
    whenToUse: text,
    prerequisites: texts,
    steps: texts,
    pitfalls: texts,
    verification: texts,
    approvalBoundaries: text,
  },
  { additionalProperties: false },
);
export const ValidationSchema = Type.Object(
  {
    environment: text,
    checks: Type.Array(
      Type.Object({
        command: text,
        expected: text,
        observed: text,
        evidenceRef: text,
        outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
      }),
      { minItems: 1, maxItems: 30 },
    ),
    limitations: text,
  },
  { additionalProperties: false },
);
export type Candidate = Static<typeof CandidateSchema>;
export type SkillDocument = Static<typeof DocumentSchema>;
export type Validation = Static<typeof ValidationSchema>;
export type Status =
  | "candidate"
  | "draft"
  | "validated"
  | "active"
  | "deprecated"
  | "archived";
export interface Revision {
  number: number;
  document: SkillDocument;
  hash: string;
  invalidatedAt?: string;
  task?: TaskIdentity;
  validation?: Validation & {
    hash: string;
    at: string;
    sessionId: string;
    source: "model-report";
  };
}
export interface Adoption {
  content: string;
  relativePath: string;
  sourceSha256: string;
  at: string;
  reason: string;
}
export interface Skill {
  id: string;
  adoption?: Adoption;
  learning?: Learning;
  generation: string;
  candidate: Candidate;
  projectRoot: string | null;
  status: Status;
  revisions: Revision[];
  activeRevision: number | null;
  events: { at: string; kind: string; reason: string }[];
}

export function assertSafe(value: unknown): void {
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (!item.trim()) throw new Error("Blank text is not evidence.");
      const error = scanContent(item);
      if (error) throw new Error(error);
    }
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object")
      Object.entries(item).forEach(([key, entry]) => {
        visit(key);
        visit(entry);
      });
  };
  // JSON escaping flattens newlines and unrelated fields into synthetic commands.
  visit(value);
}

export function documentHash(document: SkillDocument): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

export function skillId(candidate: Pick<Candidate, "name" | "scope">): string {
  return `${candidate.scope}:${candidate.name}`;
}

function event(skill: Skill, kind: string, reason: string): void {
  skill.events.push({ at: new Date().toISOString(), kind, reason });
}

export function consider(
  candidate: Candidate,
  projectRoot: string,
  task?: TaskIdentity,
  now = new Date().toISOString(),
): Skill {
  if (!Value.Check(CandidateSchema, candidate))
    throw new Error("Invalid candidate evidence.");
  assertSafe(candidate);
  const captureTask = task ?? directTask(now);
  checkTask(captureTask, now);
  return {
    id: skillId(candidate),
    learning: { createdAt: now, captureTask, everActivated: false, uses: [] },
    generation: randomUUID(),
    candidate,
    projectRoot: candidate.scope === "project" ? projectRoot : null,
    status: "candidate",
    revisions: [],
    activeRevision: null,
    events: [
      {
        at: new Date().toISOString(),
        kind: "consider",
        reason: "Evidence recorded; not yet validated or discoverable.",
      },
    ],
  };
}

export function draft(
  skill: Skill,
  document: SkillDocument,
  task?: TaskIdentity,
  now = new Date().toISOString(),
): Skill {
  assertFresh(skill, now);
  const revisionTask = task ?? learningOf(skill).captureTask;
  checkTask(revisionTask, now);
  if (skill.status === "archived")
    throw new Error(
      "Archived skills cannot be edited; create a new candidate.",
    );
  if (!Value.Check(DocumentSchema, document))
    throw new Error("Invalid structured skill document.");
  assertSafe(document);
  const next = structuredClone(skill);
  next.revisions.push({
    number: next.revisions.length + 1,
    document,
    hash: documentHash(document),
    task: revisionTask,
  });
  if (next.status !== "active") next.status = "draft";
  event(
    next,
    "draft",
    "New revision requires validation; existing active revision is unchanged.",
  );
  return next;
}

export function validate(
  skill: Skill,
  validation: Validation,
  sessionId: string,
  now = new Date().toISOString(),
): Skill {
  assertFresh(skill, now);
  if (skill.status === "archived" || skill.revisions.length === 0)
    throw new Error("A non-archived draft is required.");
  if (!Value.Check(ValidationSchema, validation))
    throw new Error("Invalid validation evidence.");
  assertSafe(validation);
  if (validation.checks.some((check) => check.outcome !== "pass"))
    throw new Error("All validation checks must pass.");
  const next = structuredClone(skill);
  const revision = next.revisions.at(-1);
  if (!revision) throw new Error("Draft missing.");
  revision.invalidatedAt = undefined;
  revision.validation = {
    ...validation,
    hash: revision.hash,
    at: new Date().toISOString(),
    sessionId,
    source: "model-report",
  };
  if (next.status !== "active") next.status = "validated";
  event(
    next,
    "validate",
    "Model-reported evidence recorded, not independently executed.",
  );
  return next;
}

export function activate(skill: Skill): Skill {
  const revision = skill.revisions.at(-1);
  if (
    skill.status === "archived" ||
    !revision?.validation ||
    revision.invalidatedAt !== undefined ||
    revision.validation.hash !== documentHash(revision.document) ||
    revision.hash !== revision.validation.hash
  ) {
    throw new Error(
      "The latest revision needs matching validation evidence before activation.",
    );
  }
  if (!canPromote(skill))
    throw new Error(
      "A successful independent reuse report is required to promote this candidate.",
    );
  const next = structuredClone(skill);
  learningOf(next).everActivated = true;
  next.status = "active";
  next.activeRevision = revision.number;
  event(
    next,
    "activate",
    "Published this exact revision after validation and independent reuse, or as an update to a previously activated skill.",
  );
  return next;
}

export function retire(
  skill: Skill,
  status: "deprecated" | "archived",
  reason: string,
): Skill {
  assertSafe(reason);
  if (skill.status === "archived")
    throw new Error("Skill is already archived.");
  if (status === "archived" && skill.status === "active")
    throw new Error("Deprecate the active skill before archiving.");
  const next = structuredClone(skill);
  next.status = status;
  next.activeRevision = null;
  for (const revision of next.revisions)
    revision.invalidatedAt = new Date().toISOString();
  event(next, status, reason);
  return next;
}

export function renderAdopted(skill: Skill): string | null {
  if (!skill.adoption) return null;
  return skill.adoption.content.replace(
    /^---(\r?\n)/,
    (_header, newline: string) =>
      `---${newline}pi-skills-adopted: ${JSON.stringify(skill.generation)}${newline}`,
  );
}

export function publishedContent(skill: Skill): string | null {
  if (skill.status !== "active") return null;
  if (skill.activeRevision === null) return renderAdopted(skill);
  return renderSkill(skill, skill.revisions[skill.activeRevision - 1]);
}

export function renderSkill(skill: Skill, revision: Revision): string {
  const doc = revision.document;
  const list = (items: string[]) =>
    items.map((item, i) => `${i + 1}. ${item}`).join("\n");
  return `---\nname: ${JSON.stringify(skill.candidate.name)}\ndescription: ${JSON.stringify(doc.description)}\nmetadata:\n  pi-skills-generated: ${JSON.stringify(skill.generation)}\n  pi-skills-revision: ${JSON.stringify(String(revision.number))}\n---\n\n# ${skill.candidate.name}\n\n## When to use\n\n${doc.whenToUse}\n\n## Prerequisites\n\n${list(doc.prerequisites)}\n\n## Procedure\n\n${list(doc.steps)}\n\n## Pitfalls\n\n${list(doc.pitfalls)}\n\n## Verification\n\n${list(doc.verification)}\n\n## Approval boundaries\n\n${doc.approvalBoundaries}\n`;
}
