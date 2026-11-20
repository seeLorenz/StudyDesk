import { useState } from "react";
import type { IntakeReport } from "../onboarding/types";

// What a drop turned into, under the student's message (design/course-files.md):
// one line per zip, and one question for all videos together.

type Props = {
  report: IntakeReport;
  /** Saved descriptions by upload id (shown again after a reload). */
  described?: Record<string, string>;
  onChoose: (choice: "titles" | "describe") => void;
  onDescribe: (uploadId: string, text: string) => Promise<void>;
};

export function IntakeCard({ report, described = {}, onChoose, onDescribe }: Props) {
  const videos = report.videos ?? [];
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const example = videos[0]?.name;

  return (
    <div className="intake-card">
      {report.lines.map((l, i) => (
        <p key={i} className="intake-line">
          {l}
        </p>
      ))}
      {videos.length > 0 && (
        <div className="intake-videos">
          <p>
            {videos.length === 1 ? `We found a video, "${example}".` : `We found ${videos.length} videos, such as "${example}".`} Claude can't watch or listen to videos, so it goes by the
            title unless you describe what happens in {videos.length === 1 ? "it" : "them"}.
          </p>
          {!report.videoChoice && (
            <div className="intake-actions">
              <button type="button" className="mini-btn primary" onClick={() => onChoose("titles")}>
                Use the titles
              </button>
              <button type="button" className="mini-btn" onClick={() => onChoose("describe")}>
                I'll describe {videos.length === 1 ? "it" : "them"}
              </button>
            </div>
          )}
          {report.videoChoice === "titles" && <p className="quest-muted">Going by the titles. You can still tell StudyDesk about a video any time.</p>}
          {report.videoChoice === "describe" && (
            <div className="intake-describe">
              {videos.map((v) => {
                const value = drafts[v.uploadId] ?? described[v.uploadId] ?? "";
                return (
                  <label key={v.uploadId} className="intake-video">
                    <span className="intake-video-name">{v.name}</span>
                    <textarea
                      rows={2}
                      value={value}
                      placeholder="What does this video cover? A few words are enough. Leave it empty to go by the title."
                      onChange={(e) => {
                        const text = e.target.value;
                        setDrafts((d) => ({ ...d, [v.uploadId]: text }));
                        setSaved((s) => ({ ...s, [v.uploadId]: false }));
                      }}
                      onBlur={async () => {
                        const text = drafts[v.uploadId];
                        if (text === undefined || text.trim() === (described[v.uploadId] ?? "").trim()) return;
                        setSaving(v.uploadId);
                        try {
                          await onDescribe(v.uploadId, text.trim());
                          setSaved((s) => ({ ...s, [v.uploadId]: true }));
                        } finally {
                          setSaving(null);
                        }
                      }}
                    />
                    {saving === v.uploadId ? <span className="quest-muted">Saving…</span> : saved[v.uploadId] ? <span className="quest-muted">Saved</span> : null}
                  </label>
                );
              })}
            </div>
          )}
          <p className="quest-muted">If you have the slides or a transcript, drop those instead.</p>
        </div>
      )}
    </div>
  );
}
