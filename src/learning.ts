import { randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { Skill } from "./lifecycle.ts";

const text = Type.String({ minLength: 1, maxLength: 8000 });
export const TriggerSchema = Type.Union([
  Type.Literal("complex-task"),
  Type.Literal("trial-and-error"),
  Type.Literal("non-obvious"),
  Type.Literal("user-taught"),
]);
export const TaskSchema = Type.Object(
  { sessionId: text, requestId: text, startedAt: text },
  { additionalProperties: false },
);
export const UseSchema = Type.Object(
  {
    sourceRevision: Type.Integer({ minimum: 1 }),
    reusedSteps: Type.Array(Type.Integer({ minimum: 1 }), {
      minItems: 1,
      maxItems: 30,
    }),
    adaptations: Type.Array(text, { maxItems: 30 }),
    outcome: Type.Union([Type.Literal("success"), Type.Literal("failed")]),
    evidenceRefs: Type.Array(text, { minItems: 1, maxItems: 30 }),
  },
  { additionalProperties: false },
);
export const UseRecordSchema = Type.Object(
  {
    ...UseSchema.properties,
    task: TaskSchema,
    at: text,
    sourceHash: text,
    revision: Type.Integer({ minimum: 1 }),
    hash: text,
  },
  { additionalProperties: false },
);
export const LearningSchema = Type.Object(
  {
    createdAt: text,
    captureTask: TaskSchema,
    everActivated: Type.Boolean(),
    lastAppliedAt: Type.Optional(text),
    uses: Type.Array(UseRecordSchema),
  },
  { additionalProperties: false },
);
export type TaskIdentity = Static<typeof TaskSchema>;
export type UseEvidence = Static<typeof UseSchema>;
export type Learning = Static<typeof LearningSchema>;
export const CANDIDATE_LIFETIME_MS = 90 * 86_400_000;

export function validTime(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("Invalid lifecycle timestamp.");
  return result;
}
export function checkTask(task: TaskIdentity, now: string): void {
  if (
    !Value.Check(TaskSchema, task) ||
    !task.sessionId.trim() ||
    !task.requestId.trim()
  )
    throw new Error("A real session/request identity is required.");
  if (validTime(task.startedAt) > validTime(now))
    throw new Error("Task identity has a future timestamp.");
}
export function directTask(now: string): TaskIdentity {
  return { sessionId: "direct-store", requestId: randomUUID(), startedAt: now };
}
export function sameTask(a: TaskIdentity, b: TaskIdentity): boolean {
  return a.sessionId === b.sessionId && a.requestId === b.requestId;
}
export function initializeLearning(skill: Skill, now: string): Skill {
  if (!skill.learning) {
    const historical =
      skill.events.find((e) => Number.isFinite(Date.parse(e.at)))?.at ?? now;
    skill.learning = {
      createdAt: historical,
      captureTask: {
        sessionId: "legacy",
        requestId: skill.generation,
        startedAt: historical,
      },
      everActivated:
        Boolean(skill.adoption) ||
        skill.status === "active" ||
        skill.events.some((e) => e.kind === "activate" || e.kind === "adopt"),
      uses: [],
    };
    for (const revision of skill.revisions)
      revision.task ??= skill.learning.captureTask;
  }
  // Existing activation/adoption history is a permanent deletion exclusion.
  if (
    skill.adoption ||
    skill.status === "active" ||
    skill.events.some((e) => e.kind === "activate" || e.kind === "adopt")
  )
    skill.learning.everActivated = true;
  return skill;
}
export function learningOf(skill: Skill): Learning {
  if (!skill.learning) throw new Error("Learning metadata missing.");
  return skill.learning;
}
export function expiration(skill: Skill): string | null {
  const learning = learningOf(skill);
  if (skill.adoption || learning.everActivated || skill.status === "active")
    return null;
  return new Date(
    validTime(learning.lastAppliedAt ?? learning.createdAt) +
      CANDIDATE_LIFETIME_MS,
  ).toISOString();
}
export function expired(skill: Skill, now: string): boolean {
  const at = expiration(skill);
  return at !== null && validTime(now) >= validTime(at);
}
export function assertFresh(skill: Skill, now: string): void {
  if (expired(skill, now))
    throw new Error(
      "Candidate expired after 90 unused calendar days; it cannot be refreshed by edits or reads.",
    );
}
export function canPromote(skill: Skill): boolean {
  const latest = skill.revisions.at(-1);
  if (
    !latest?.validation ||
    latest.validation.hash !== latest.hash ||
    latest.invalidatedAt !== undefined
  )
    return false;
  const learning = learningOf(skill);
  return (
    learning.everActivated ||
    learning.uses.some(
      (use) =>
        use.outcome === "success" &&
        use.hash === latest.hash &&
        use.revision === latest.number &&
        !sameTask(use.task, learning.captureTask),
    )
  );
}
export function recordApplication(
  skill: Skill,
  evidence: UseEvidence,
  task: TaskIdentity,
  now: string,
): Skill {
  if (!Value.Check(UseSchema, evidence))
    throw new Error("Invalid actual-application evidence.");
  checkTask(task, now);
  assertFresh(skill, now);
  if (skill.status === "archived")
    throw new Error("Archived skills cannot record an application.");
  const learning = learningOf(skill);
  const source = skill.revisions[evidence.sourceRevision - 1];
  const latest = skill.revisions.at(-1);
  if (!source || !latest)
    throw new Error("A saved source revision is required for reuse.");
  if (
    sameTask(task, learning.captureTask) ||
    sameTask(task, source.task ?? learning.captureTask) ||
    validTime(task.startedAt) < validTime(learning.createdAt) ||
    validTime(task.startedAt) <
      validTime((source.task ?? learning.captureTask).startedAt)
  )
    throw new Error(
      "Reuse must come from a later independent task, not the capture task or its own new draft.",
    );
  if (
    new Set(evidence.reusedSteps).size !== evidence.reusedSteps.length ||
    evidence.reusedSteps.some((step) => step > source.document.steps.length)
  )
    throw new Error(
      "Reused step numbers must identify distinct steps in the saved source revision.",
    );
  const next = structuredClone(skill);
  const state = learningOf(next);
  const existing = state.uses.findIndex(
    (use) =>
      sameTask(use.task, task) &&
      use.hash === latest.hash &&
      use.sourceRevision === source.number,
  );
  const firstApplicationAt =
    state.uses.find((use) => sameTask(use.task, task))?.at ?? now;
  const record = {
    ...evidence,
    task,
    at: firstApplicationAt,
    sourceHash: source.hash,
    revision: latest.number,
    hash: latest.hash,
  };
  if (existing >= 0) {
    const prior = state.uses[existing];
    if (JSON.stringify(prior) === JSON.stringify(record)) return next;
    state.uses[existing] = record;
  } else state.uses.push(record);
  // Each independent request renews once, when its first actual application is reported.
  if (
    !state.lastAppliedAt ||
    validTime(firstApplicationAt) > validTime(state.lastAppliedAt)
  )
    state.lastAppliedAt = firstApplicationAt;
  next.events.push({
    at: now,
    kind: "use",
    reason: `Recorded ${evidence.outcome} application of source revision ${source.number}; evidence is agent-reported, not independently executed.`,
  });
  return next;
}
export function renderCandidate(
  skill: Skill,
  revision = skill.revisions.at(-1),
): string | null {
  if (
    !revision ||
    learningOf(skill).everActivated ||
    skill.adoption ||
    skill.status === "archived"
  )
    return null;
  return `${JSON.stringify({ managedBy: "pi-skills", generation: skill.generation, name: skill.candidate.name, revision: revision.number, hash: revision.hash, document: revision.document }, null, 2)}\n`;
}
