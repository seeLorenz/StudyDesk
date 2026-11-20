// Records of the Start New Semester flow. See design/onboarding.md.
//
// Onboarding writes only the raw facts the student gave (profile, courses,
// targets, timetable, study goal, uploads, things said word for word). The
// setup run turns them into topics, skills, grade rules, key dates, homework
// and the material catalog, which end up in the quest module's `Semester`.

import type { GradeRules } from "../mastery/grades";
import type { AssessmentResult, Day, GradeScale, Skill } from "../mastery/types";
import type { Note } from "../chat/types";
import type { Assignment, KeyDate, TimetableEntry, Topic } from "../quests/types";
import type { QuestSettings } from "../quests/config";
import type { NightlySettings, ScheduleInfo } from "../routine/nightly";

export type Level = "school" | "university";

/** Who the student is. Asked once, kept across semesters. */
export type Profile = {
  level: Level;
  school: string;
  country: string;
  gradeScale: GradeScale;
  program: string;
  year: string;
  updatedAt: number;
  /** The cloud environment and saved "StudyDesk agent" task used for hand-off. */
  handoff?: { environmentId: string; triggerId: string; artifactUrl?: string };
  /** The nightly run's scheduled task (src/platform/schedule.ts). */
  schedule?: ScheduleInfo;
  /** The student's settings for the nightly run, changed through the StudyDesk chat. */
  nightly?: NightlySettings;
};

export type CourseSetupStatus = "waiting" | "reading" | "ready" | "needs_check" | "failed";

export type DraftCourse = {
  id: string;
  name: string;
  short: string;
  credits: number | null;
  /** Guessed by the setup run from the materials; the student can change it later. */
  teachingLanguage: string;
  /** Required before setup counts as done. On the profile's grade scale. */
  targetGrade: number | null;
  setupStatus: CourseSetupStatus;
  setupError?: string;
  /** The cloud session reading this course right now, if it was handed off. */
  job?: CloudJob;
  /** Why this course is read in the page instead of a cloud session. */
  cloudFailed?: string;
};

/** A setup run handed to a cloud session (src/platform/handoff.ts). */
export type CloudJob = {
  /** The job's document, data/users/<uid>/job-<jobId>, where the session reports. */
  jobId: string;
  /** For the "Open the session" link; null when claude.ai didn't name it. */
  sessionId: string | null;
  startedAt: number;
  /** When the page last saw the job's report change, and what it looked like then. */
  changedAt: number;
  seen: string;
  /** The F1, F2… keys the session's answer uses for files, mapped to upload ids. */
  fileKeys: Record<string, string>;
  readIds: string[];
};

/** One original file the student dropped in. The file itself stays in the student's StudyDesk. */
export type Upload = {
  id: string;
  courseId: string | null;
  fileName: string;
  /** "office" files are kept as their text; "video" and "other" are listed by name only. */
  type: "pdf" | "image" | "text" | "office" | "video" | "other";
  /** What the student said about it ("last year's exam"). */
  studentNote: string;
  addedAt: number;
  /** When the setup run mapped it into the material catalog. */
  cataloguedAt: number | null;
  /** The original in the artifact's file store, when this view can store files. */
  assetId: string | null;
  pages: number | null;
  /** Folder path inside the zip it came from ("Übungen/Blatt 3.pdf"). */
  path?: string;
  /** The zip it came from (ZipRecord id). */
  zipId?: string;
  /** readable: its text or image is kept. agent: only the original is kept (a scan): a cloud session reads it. listed: known by name only (video, unknown format). */
  state?: "readable" | "agent" | "listed";
  sizeBytes?: number;
};

/** One dropped zip: its files are uploads with this zipId, assigned to a course together. */
export type ZipRecord = { id: string; fileName: string; courseId: string | null; addedAt: number; files: number };

/** What the student sees under a message that dropped files: one line per zip or group, and the videos question. */
export type IntakeReport = {
  lines: string[];
  /** Videos found; the student may describe them (Claude can't watch or listen). */
  videos?: Array<{ uploadId: string; name: string }>;
  /** "titles" (default) or "describe" once the student chose. */
  videoChoice?: "titles" | "describe";
};

/** Something the student said, passed on word for word ("the exam is on 28 Jan"). */
export type StudentFact = { id: string; courseId: string | null; text: string; addedAt: number };

/** Where a skill is covered in a real file, so later only those lines are read. */
export type CatalogEntry = { skillId: string; uploadId: string; where: string };

/** "chat" while the student and the Orchestrator fill the sheet; older drafts may hold step names from the first version. */
export type SetupStep = "chat" | "running" | "done";

/** One message of the setup chat. Files are kept as uploads; the message only names them. */
export type SetupMessage = { id: string; role: "user" | "assistant"; text: string; files?: string[]; /** The kept files of this message, so later turns can send its images again. */ uploadIds?: string[]; intake?: IntakeReport; createdAt: number; error?: string };

/** What the setup run found for one course. */
export type CourseSetup = {
  courseId: string;
  summary: string;
  teachingLanguage: string;
  topics: Topic[];
  skills: Skill[];
  gradeRules: GradeRules | null;
  keyDates: KeyDate[];
  assignments: Assignment[];
  catalog: CatalogEntry[];
  /** Where the student's word and a file disagree (the student's word wins). */
  conflicts: string[];
  /** What the run still couldn't find out. */
  questions: string[];
  /** "materials" when files were read, "general" when only general knowledge was used. */
  basis: "materials" | "general";
  /** The answer was cut short, so the map may be incomplete. */
  truncated: boolean;
  finishedAt: number;
};

/** The semester being set up. One per student; resumes where it stopped. */
export type SemesterDraft = {
  id: string;
  name: string;
  startDate: Day;
  endDate: Day;
  status: "setting_up" | "active";
  setupStep: SetupStep;
  /** Which course the "each course" step is on. */
  courseIndex: number;
  courses: DraftCourse[];
  timetable: TimetableEntry[];
  /** Minutes per weekday, index 0 = Sunday. */
  studyGoal: number[];
  uploads: Upload[];
  /** Dropped zips (their files are in uploads). */
  zips?: ZipRecord[];
  facts: StudentFact[];
  results: Record<string, CourseSetup>;
  /** The setup chat with the Orchestrator. */
  chat?: SetupMessage[];
  /** When lectures and commitments were last imported from Google Calendar. */
  calendarImportedAt?: number | null;
  /** Side notes from select-to-reply on the chat and the setup report. */
  notes?: Note[];
  /** To-do items on the done screen the student ticked off ("upload", "q-<courseId>"). */
  todoDone?: string[];
  /** The student chose to set up without cloud sessions for now. */
  handoffSkipped?: boolean;
  /** Days without studying, set through the Orchestrator ("I'm sick tomorrow"). */
  daysOff?: Array<{ date: Day; reason: string }>;
  /** Real results from school, entered through the Orchestrator. */
  assessments?: AssessmentResult[];
  /** Hints, lesson length, new skills per quest, set through the Orchestrator. */
  questSettings?: QuestSettings;
  /** Deep sweep dates the student asked for, by course id (they win over the organization agent's own dates). */
  sweepDates?: Record<string, Day>;
  createdAt: number;
  updatedAt: number;
};

/** The recommended daily workload after the placement check. */
export type Recommendation = {
  perCourse: Array<{ courseId: string; remainingSkills: number; minutesNeeded: number; deadline: Day; studyDays: number; dailyMinutes: number }>;
  /** Quest minutes per study day, all courses together. */
  dailyQuestMinutes: number;
  /** Suggested study goal per weekday (index 0 = Sunday), lectures included like the student's own goal. */
  studyGoal: number[];
};
