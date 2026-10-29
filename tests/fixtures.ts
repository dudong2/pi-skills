import { randomUUID } from "node:crypto";
import {
  consider,
  draft,
  validate,
  type Candidate,
  type SkillDocument,
  type Validation,
} from "../src/lifecycle.ts";
import {
  recordApplication,
  type TaskIdentity,
  type UseEvidence,
} from "../src/learning.ts";

export const candidate: Candidate = {
  name: "inspect-native-crash",
  scope: "project",
  trigger: "non-obvious",
  reuse: "When the same vendor binary crashes in another release.",
  procedure: "Match build IDs, resolve frames and verify source locations.",
  differentiation:
    "Compared the loaded skill index; no matching native symbolication workflow exists.",
  benefit: "Avoid repeating toolchain discovery and incorrect symbol matches.",
  sourceRefs: ["session:example/tool-result/42"],
  relatedSkills: [],
};
export const document: SkillDocument = {
  description:
    "Symbolicate vendor native crashes using matching build IDs. Use for SIGSEGV with stripped frames.",
  whenToUse:
    "A native crash has unresolved frames and matching debug artifacts are available.",
  prerequisites: [
    "Matching debug artifacts and the platform symbolizer are installed.",
  ],
  steps: [
    "Compare build IDs before resolving addresses.",
    "Resolve module-relative frame addresses.",
  ],
  pitfalls: ["Never use symbols from a different release."],
  verification: [
    "Check resolved addresses against the matching binary's source map.",
  ],
  approvalBoundaries:
    "Read-only analysis; request approval before downloading private artifacts.",
};
export const validation: Validation = {
  environment: "Local fixture binary with known debug symbols.",
  checks: [
    {
      command: "symbolizer --fixture",
      expected: "Known function and line",
      observed: "Known function and line",
      evidenceRef: "session:example/tool-result/43",
      outcome: "pass",
    },
  ],
  limitations:
    "Only the fixture toolchain was exercised; other platforms need revalidation.",
};
export const useEvidence: UseEvidence = {
  sourceRevision: 1,
  reusedSteps: [1],
  adaptations: [],
  outcome: "success",
  evidenceRefs: ["session:followup/result:51"],
};
export const nextTask = (): TaskIdentity => ({
  sessionId: "followup-session",
  requestId: randomUUID(),
  startedAt: new Date().toISOString(),
});
export function reusableSkill(project: string) {
  const saved = validate(
    draft(consider(candidate, project), document),
    validation,
    "session-1",
  );
  return recordApplication(
    saved,
    useEvidence,
    nextTask(),
    new Date().toISOString(),
  );
}
