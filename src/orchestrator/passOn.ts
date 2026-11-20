// The tutor's one link to the Orchestrator. design/orchestrator.md, "The
// tutor passes organizing remarks on".
//
// Every tutor conversation (Ask chats, select-to-reply notes, the mistake
// review) gets this tool. The tutor never changes anything itself: it hands
// the remark on word for word, and the StudyDesk chat handles it like any
// message and shows the change card there.

import { canUseTools } from "../platform/claude";

export const PASS_ON_EVENT = "studydesk:pass-on";

export type PassOn = { text: string; where: string };

export function passOn(p: PassOn): void {
  window.dispatchEvent(new CustomEvent<PassOn>(PASS_ON_EVENT, { detail: p }));
}

function passOnTool(where: string): Claude.sample.SampleTool {
  return {
    name: "pass_to_studydesk",
    description:
      "Hands an organizing remark from the student to StudyDesk's planner, word for word: a new or moved date or deadline, being sick or busy, wanting to stop or study less, a course or chapter that changed, a result from school. You can't change their plan yourself. Still answer the learning part normally, and mention in one short line that you passed it on.",
    inputSchema: {
      type: "object",
      properties: { remark: { type: "string", description: "The student's words, word for word." } },
      required: ["remark"],
    } as unknown as Claude.sample.SampleToolInputSchema,
    execute: (input) => {
      const text = String(input.remark ?? "").trim();
      if (!text) throw new Error("Nothing to pass on.");
      passOn({ text, where });
      return "Passed on. StudyDesk takes care of it in its own chat.";
    },
  };
}

/** The tools every tutor call gets; none where this view can't run page tools. */
export async function tutorTools(where: string): Promise<Claude.sample.SampleTool[] | undefined> {
  return (await canUseTools().catch(() => false)) ? [passOnTool(where)] : undefined;
}
