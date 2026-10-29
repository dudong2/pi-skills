import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { scanContent } from "./content-scanner.ts";

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
    reuse: text,
    procedure: text,
    differentiation: text,
    benefit: text,
    sourceRefs: texts,
    relatedSkills: Type.Array(Type.Object({ path: text, comparison: text }), {
      maxItems: 30,
    }),
  },
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
  validation?: Validation & {
    hash: string;
    at: string;
    sessionId: string;
    source: "model-report";
  };
}
export interface Skill {
  id: string;
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
      Object.values(item).forEach(visit);
  };
  visit(value);
  const error = scanContent(JSON.stringify(value));
  if (error) throw new Error(error);
}

export function documentHash(document: SkillDocument): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

export function reviewHash(skill: Skill): string {
  return createHash("sha256").update(JSON.stringify(skill)).digest("hex");
}

export function skillId(
  candidate: Pick<Candidate, "name" | "scope">,
  projectRoot: string,
): string {
  const scope =
    candidate.scope === "global"
      ? "global"
      : `project-${createHash("sha256").update(projectRoot).digest("hex")}`;
  return `${scope}:${candidate.name}`;
}

function event(skill: Skill, kind: string, reason: string): void {
  skill.events.push({ at: new Date().toISOString(), kind, reason });
}

export function consider(candidate: Candidate, projectRoot: string): Skill {
  if (!Value.Check(CandidateSchema, candidate))
    throw new Error("Invalid candidate evidence.");
  assertSafe(candidate);
  return {
    id: skillId(candidate, projectRoot),
    candidate,
    projectRoot: candidate.scope === "project" ? projectRoot : null,
    status: "candidate",
    revisions: [],
    activeRevision: null,
    events: [
      {
        at: new Date().toISOString(),
        kind: "consider",
        reason: "Evidence recorded; not approved or discoverable.",
      },
    ],
  };
}

export function draft(skill: Skill, document: SkillDocument): Skill {
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
  });
  if (next.activeRevision === null) next.status = "draft";
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
): Skill {
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
  if (next.activeRevision === null) next.status = "validated";
  event(
    next,
    "validate",
    "Model-reported evidence recorded, not independently executed or user-approved.",
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
  const next = structuredClone(skill);
  next.status = "active";
  next.activeRevision = revision.number;
  event(
    next,
    "activate",
    "User command approved this exact revision after reviewing evidence.",
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
  if (status === "archived" && skill.activeRevision !== null)
    throw new Error("Deprecate the active skill before archiving.");
  const next = structuredClone(skill);
  next.status = status;
  next.activeRevision = null;
  for (const revision of next.revisions)
    revision.invalidatedAt = new Date().toISOString();
  event(next, status, reason);
  return next;
}

export function renderSkill(skill: Skill, revision: Revision): string {
  const doc = revision.document;
  const list = (items: string[]) =>
    items.map((item, i) => `${i + 1}. ${item}`).join("\n");
  return `---\nname: ${JSON.stringify(skill.candidate.name)}\ndescription: ${JSON.stringify(doc.description)}\nmetadata:\n  pi-skills-revision: ${JSON.stringify(String(revision.number))}\n---\n\n# ${skill.candidate.name}\n\n## When to use\n\n${doc.whenToUse}\n\n## Prerequisites\n\n${list(doc.prerequisites)}\n\n## Procedure\n\n${list(doc.steps)}\n\n## Pitfalls\n\n${list(doc.pitfalls)}\n\n## Verification\n\n${list(doc.verification)}\n\n## Approval boundaries\n\n${doc.approvalBoundaries}\n`;
}
