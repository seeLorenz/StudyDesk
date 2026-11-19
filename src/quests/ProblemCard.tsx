import { useState } from "react";
import { Markdown } from "../chat/Markdown";
import { AnswerBox } from "./AnswerBox";
import type { AnswerFile, ProblemWork, QuestProblem } from "./types";

const VERDICT_LABEL = { solved: "Solved", slip: "Slip?", not_understood: "Not yet" } as const;

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Props = {
  n: number;
  problem: QuestProblem;
  skillName: string;
  work: ProblemWork;
  locked: boolean;
  graded: boolean;
  timing: boolean;
  /** When the worked answer may be shown; null = now. */
  answerLockedUntil: string | null;
  onChange: (patch: Partial<ProblemWork>) => void;
  onAddFile: (file: AnswerFile, blob?: Blob) => void;
  onActivity: () => void;
  onPause: () => void;
  onSlipAnswer: (confirmed: boolean) => void;
};

export function ProblemCard({ n, problem, skillName, work, locked, graded, timing, answerLockedUntil, onChange, onAddFile, onActivity, onPause, onSlipAnswer }: Props) {
  const [showKey, setShowKey] = useState(false);
  const hintsLeft = problem.hints.length - work.hintsShown;
  const editable = !locked && !graded;

  return (
    <article className={"problem" + (graded ? ` is-${work.verdict}` : "")} aria-labelledby={`${problem.id}-h`}>
      <header className="problem-head">
        <h4 id={`${problem.id}-h`}>
          {problem.label ? `Task ${problem.label}` : `Problem ${n}`}
          <span className="problem-skill">{skillName}</span>
        </h4>
        <span className="problem-meta">
          {graded ? (
            <span className={`verdict v-${work.verdict}`}>
              {VERDICT_LABEL[work.verdict!]} · {work.points}/{problem.maxPoints}
            </span>
          ) : (
            <>
              about {problem.expMinutes} min
              {work.activeSeconds > 0 || timing ? (
                <span className={"timer" + (timing ? " is-on" : "")} title="Active time on this problem">
                  {clock(work.activeSeconds)}
                  {timing && (
                    <button type="button" className="timer-btn" onClick={onPause} aria-label="Pause timer">
                      Pause
                    </button>
                  )}
                </span>
              ) : null}
            </>
          )}
        </span>
      </header>

      <Markdown text={problem.prompt} />

      {problem.hints.length > 0 && (
        <div className="qhints">
          {problem.hints.slice(0, work.hintsShown).map((h, i) => (
            <div key={i} className="qhint">
              <span className="qhint-n">Hint {i + 1}</span>
              <Markdown text={h} />
            </div>
          ))}
          {work.sawSimilar && problem.similarSolved && (
            <div className="qhint similar">
              <span className="qhint-n">A solved similar problem</span>
              <Markdown text={problem.similarSolved} />
              <p className="qhint-back">Now go back to the task and try it your way. This one gives no streak credit.</p>
            </div>
          )}
          {editable && hintsLeft > 0 && (
            <button
              type="button"
              className="mini-btn"
              onClick={() => {
                onActivity();
                onChange({ hintsShown: work.hintsShown + 1 });
              }}
            >
              {work.hintsShown === 0 ? "I'm stuck: give me a hint" : `Another hint (${hintsLeft} left)`}
            </button>
          )}
          {editable && hintsLeft === 0 && !work.sawSimilar && problem.similarSolved && (
            <button
              type="button"
              className="mini-btn"
              onClick={() => {
                onActivity();
                onChange({ sawSimilar: true });
              }}
            >
              Show me a solved similar problem
            </button>
          )}
        </div>
      )}

      {!graded && (
        <AnswerBox
          id={`${problem.id}-answer`}
          text={work.answerText}
          files={work.files}
          disabled={!editable}
          onText={(answerText) => onChange({ answerText })}
          onAddFile={onAddFile}
          onRemoveFile={(id) => onChange({ files: work.files.filter((f) => f.id !== id) })}
          onActivity={onActivity}
        />
      )}

      {graded && (
        <div className="result">
          {(work.answerText || work.files.length > 0) && (
            <div className="result-answer">
              <span className="result-label">Your answer</span>
              {work.answerText && <p>{work.answerText}</p>}
              {work.files.map((f) => (
                <span key={f.id} className="file-chip">
                  {f.thumb ? <img src={f.thumb} alt="" /> : null}
                  <span className="file-name">{f.name}</span>
                </span>
              ))}
            </div>
          )}
          <Markdown text={work.feedback ?? ""} />
          {work.verdict === "slip" && work.slipQuestion && (
            <div className="slip">
              <p>{work.slipQuestion}</p>
              {work.slipAnswer ? (
                <p className="slip-done">
                  {work.slipAnswer === "confirmed" ? "Counted as a slip: your streak is safe." : "Counted as a real mistake. It goes on your review list."}
                </p>
              ) : (
                <div className="slip-btns">
                  <button type="button" className="mini-btn primary" onClick={() => onSlipAnswer(true)}>
                    Yes, just a slip
                  </button>
                  <button type="button" className="mini-btn" onClick={() => onSlipAnswer(false)}>
                    No, I got it wrong
                  </button>
                </div>
              )}
            </div>
          )}
          {answerLockedUntil ? (
            <p className="key-locked">The full worked answer unlocks after the hand-in ({answerLockedUntil}).</p>
          ) : (
            <>
              <button type="button" className="link-btn" onClick={() => setShowKey((s) => !s)}>
                {showKey ? "Hide the worked answer" : "Show the worked answer"}
              </button>
              {showKey && (
                <div className="key">
                  <Markdown text={problem.answerKey} />
                </div>
              )}
            </>
          )}
          {work.activeSeconds > 0 && (
            <p className="result-time">
              Took {clock(work.activeSeconds)} (estimate {problem.expMinutes} min){work.hintsShown ? `, ${work.hintsShown} ${work.hintsShown === 1 ? "hint" : "hints"}` : ""}.
            </p>
          )}
        </div>
      )}
    </article>
  );
}
