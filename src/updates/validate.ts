// "Did the update work": checks every stored record against what this version
// of StudyDesk expects, before anything upgraded is saved. design/updates.md.
//
// The rules list the fields the code relies on to load each kind of record.
// When a release changes a record's shape, change its rule here together
// with the upgrade step that produces it.

import { COLLECTION_KIND_LIST, DOC_KIND_LIST, type CollectionKind, type DocKind, type Rec, type Snapshot } from "./layout";

type FieldType = "string" | "number" | "boolean" | "array" | "object" | "string|null" | "number|null";
/** Field name → type; a trailing "?" on the name makes it optional (missing or undefined is fine). */
type Rule = Record<string, FieldType>;

const DOC_RULES: Record<DocKind, Rule> = {
  profile: { "level?": "string", "school?": "string", "country?": "string", "updatedAt?": "number", "handoff?": "object", "schedule?": "object", "nightly?": "object" },
  setup: { id: "string", name: "string", status: "string", courses: "array", "timetable?": "array", "studyGoal?": "array", "uploads?": "array", "facts?": "array", "results?": "object", "chat?": "array" },
  semester: { id: "string", name: "string", courses: "array", "skills?": "array", "targets?": "array", "assignments?": "array", "keyDates?": "array", "timetable?": "array", "studyGoal?": "array" },
  orchestrator: { "memory?": "object", "changes?": "array", "confirms?": "array", "jobs?": "array", "notifications?": "array", "notes?": "array" },
  routine: { "org?": "object", "nights?": "array" },
  updates: { "dataVersion?": "number", "backups?": "array" },
};

const COLLECTION_RULES: Record<CollectionKind, Rule> = {
  askChats: { id: "string", messages: "array", "notes?": "array", "title?": "string" },
  uploadContents: { "text?": "string", "image?": "string" },
  archivedSemesters: { id: "string", name: "string", courses: "array" },
  questRecords: { quest: "object", progress: "object" },
  questReviews: { id: "string", messages: "array" },
  answerPhotos: { "dataUrl?": "string" },
  masterySkills: { id: "string", courseId: "string", name: "string" },
  masteryTargets: { courseId: "string" },
  masteryAttempts: { id: "string", skillId: "string", day: "string", verdict: "string", "points?": "number", "maxPoints?": "number" },
  masteryReviews: { attemptId: "string", "status?": "string" },
  orchestratorChat: { "semesterId?": "string", "day?": "string", messages: "array" },
  routineOutbox: { id: "string", kind: "string" },
};

function typeOk(v: unknown, t: FieldType): boolean {
  switch (t) {
    case "array":
      return Array.isArray(v);
    case "object":
      return !!v && typeof v === "object" && !Array.isArray(v);
    case "string|null":
      return v === null || typeof v === "string";
    case "number|null":
      return v === null || (typeof v === "number" && Number.isFinite(v));
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    default:
      return typeof v === t;
  }
}

/** Problems with one record, as plain lines. Empty when it's fine. */
export function checkRecord(rec: Rec, rule: Rule, where: string): string[] {
  const out: string[] = [];
  for (const [key, t] of Object.entries(rule)) {
    const optional = key.endsWith("?");
    const name = optional ? key.slice(0, -1) : key;
    const v = rec[name];
    if (v === undefined) {
      if (!optional) out.push(`${where}: "${name}" is missing`);
      continue;
    }
    if (!typeOk(v, t)) out.push(`${where}: "${name}" should be ${t === "array" ? "a list" : t === "object" ? "an object" : `a ${t}`}`);
  }
  return out;
}

export type Validation = { ok: boolean; problems: string[] };

/** Checks a whole snapshot. Lists at most `max` problems. Pure. */
export function validateSnapshot(s: Snapshot, max = 20): Validation {
  const problems: string[] = [];
  for (const k of DOC_KIND_LIST) {
    const d = s[k];
    if (d) problems.push(...checkRecord(d, DOC_RULES[k], k));
  }
  for (const k of COLLECTION_KIND_LIST) {
    for (const [id, d] of Object.entries(s[k])) {
      problems.push(...checkRecord(d, COLLECTION_RULES[k], `${k}/${id}`));
      if (problems.length > max) break;
    }
  }
  const qr = s.questRecords;
  for (const [id, r] of Object.entries(qr)) {
    const q = r.quest as Rec | undefined;
    if (q && typeof q === "object") problems.push(...checkRecord(q, { id: "string", date: "string", courseId: "string" }, `questRecords/${id}/quest`));
  }
  return { ok: problems.length === 0, problems: problems.slice(0, max) };
}
