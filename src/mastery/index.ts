// Grading and mastery: the rules from design/grading-and-mastery.md.
// Agents judge (grading.ts), code counts (everything else).

export * from "./types";
export { CONFIG } from "./config";
export { toDay, addDays, daysBetween } from "./days";
export { replay, dueSkills, questPoints, outcomeOf, type Exam, type ReplayResult } from "./replay";
export { courseMastery, topicMastery, examReadiness, credit, isRequired, type MasteryResult, type ExamReadiness } from "./mastery";
export { slownessFactor, expectedMinutes, questBudget, activeMinutesByDay, type Budget } from "./timing";
export { gradeStanding, gradeFor, assessmentAttempts, type GradeRules, type GradeStanding } from "./grades";
export {
  gradeProblems,
  parseGrading,
  gradingTurns,
  recordResult,
  answerSlip,
  GradingFailed,
  type GradingProblem,
  type GradingResult,
} from "./grading";
