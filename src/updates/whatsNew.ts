// The Orchestrator's short note after an update (design/updates.md, step 7).
// Claude writes it from the release notes, in the student's words; code only
// decides when.

import type { Turn } from "../platform/claude";
import type { LastUpdate } from "./plan";

export const WHATS_NEW_RULES = `You are StudyDesk, a study app's assistant. StudyDesk was just updated. Write the student a short note about what's new: 2 to 5 sentences or a short list, from the release notes below only (never invent features). Say what they can now do, in plain words, not technical ones. Write in the language the student uses with you (the memory shows it). No greeting, no sign-off.`;

/** The turns for the note. Pure. */
export function whatsNewTurns(u: LastUpdate, memory: string): Turn[] {
  return [
    {
      role: "user",
      content: `${WHATS_NEW_RULES}\n\n<memory>\n${memory || "(none yet)"}\n</memory>\n\n<release version="${u.to}" previous="${u.from}">\n${u.notes?.trim() || "(no notes for this release)"}\n</release>`,
    },
  ];
}

/** What's posted when there's no Claude (preview) or no notes. Pure. */
export function plainNote(u: LastUpdate): string {
  if (u.kind === "rollback") return `**StudyDesk is back on ${u.to}.** Your data is as it was before the update.`;
  return `**StudyDesk is updated to ${u.to}.** All your data came along.${u.notes?.trim() ? `\n\n${u.notes.trim()}` : ""}`;
}
