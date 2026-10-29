import type { Skill } from "./lifecycle.ts";
import { expired, expiration, learningOf } from "./learning.ts";

export function searchSkills(
  skills: Skill[],
  query: string,
  now: string,
  limit = 10,
  candidatesOnly = false,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 30)
    throw new Error("Search limit must be between 1 and 30.");
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "from",
    "have",
    "what",
    "how",
    "can",
    "you",
    "please",
  ]);
  const tokens = [
    ...new Set(normalize(query.slice(0, 8000)).match(/[\p{L}\p{N}]+/gu) ?? []),
  ]
    .filter((token) => token.length > 1 && !stop.has(token))
    .slice(0, 100);
  if (!tokens.length) return [];
  return skills
    .filter(
      (s) =>
        !expired(s, now) &&
        !["archived", "deprecated"].includes(s.status) &&
        (!candidatesOnly || !learningOf(s).everActivated),
    )
    .map((skill) => {
      const latest = skill.revisions.at(-1);
      const description =
        latest?.document.description ?? skill.candidate.procedure;
      const name = normalize(skill.candidate.name.replaceAll("-", " "));
      const short = normalize(description);
      const body = normalize(
        JSON.stringify(latest?.document ?? skill.candidate.procedure),
      );
      const score = tokens.reduce(
        (sum, token) =>
          sum +
          (name.includes(token) ? 5 : 0) +
          (short.includes(token) ? 3 : 0) +
          (body.includes(token) ? 1 : 0),
        0,
      );
      return {
        id: skill.id,
        status: skill.status,
        origin: skill.adoption ? "adopted" : "generated",
        description: description.slice(0, 500),
        revision: latest?.number ?? null,
        validation: latest?.validation ? "reported-pass" : "unverified",
        expiresAt: expiration(skill),
        score,
      };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}
