import type { Chat, Message, Note } from "./types";
import type { Turn } from "../platform/claude";

const MAIN_RULES = `You are StudyDesk, a study assistant for high school and university students.
- Answer clearly and correctly at the student's level. Use Markdown. Use headings only for long answers.
- Write math with $...$ inline and $$...$$ for display formulas.
- The student can highlight any part of your answer and ask about it separately, so keep answers focused and don't end with offers like "let me know if you want more".
- If the student attached files or images, use them.`;

const NOTE_RULES = `You are StudyDesk, a study assistant for high school and university students.
The student highlighted a passage in the conversation below and asked a question about it.
Your answer appears in a small side note next to that passage, NOT in the main chat. So:
- Answer only the question about the highlighted passage, using the conversation as context.
- Be brief: usually 2 to 6 sentences, or a short list. A small example is fine when it helps.
- Don't restate the passage, don't continue the main conversation, don't greet.
- Use Markdown; write math with $...$ inline and $$...$$ for display formulas.`;

const MAX_PROMPT_CHARS = 180_000;

export function messageContent(m: Message): string {
  let out = m.text;
  for (const a of m.attachments ?? []) {
    if (a.kind === "image") out += `\n\n[Image attached: ${a.name}]`;
    else if (a.text) out += `\n\n<file name="${a.name}">\n${a.text}\n</file>`;
  }
  return out.trim() || "(empty message)";
}

/** Turns for the main chat: standing rules, then the conversation, newest last. Oldest turns drop first. */
export function mainTurns(messages: Message[]): Turn[] {
  const convo: Turn[] = messages
    .filter((m) => m.role === "user" || (m.text.trim() && !m.error))
    .map((m) => ({ role: m.role, content: messageContent(m) }));
  let size = convo.reduce((n, t) => n + t.content.length, 0);
  while (size > MAX_PROMPT_CHARS && convo.length > 1) size -= convo.shift()!.content.length;
  while (convo.length && convo[0].role !== "user") convo.shift();
  return [{ role: "user", content: MAIN_RULES }, ...convo];
}

function transcript(chat: Chat, uptoMessageId: string, budget: number): string {
  const idx = chat.messages.findIndex((m) => m.id === uptoMessageId);
  const lines = chat.messages
    .slice(0, idx === -1 ? undefined : idx + 1)
    .filter((m) => m.text.trim())
    .map((m) => `${m.role === "user" ? "STUDENT" : "STUDYDESK"}:\n${messageContent(m)}`);
  let text = lines.join("\n\n");
  if (text.length > budget) text = "[…earlier conversation left out…]\n" + text.slice(-budget);
  return text;
}

/** Turns for a side note: rules + conversation + highlighted passage, then the note's own back-and-forth. */
export function noteTurns(chat: Chat, note: Note): Turn[] {
  const head = `${NOTE_RULES}

<conversation>
${transcript(chat, note.messageId, 60_000)}
</conversation>

HIGHLIGHTED PASSAGE:
"""${note.label}"""`;
  const turns: Turn[] = [{ role: "user", content: head }];
  for (const t of note.turns) {
    if (t.role === "assistant" && (!t.text.trim() || t.error)) continue;
    turns.push({ role: t.role, content: t.text });
  }
  return turns;
}

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 48 ? line.slice(0, 46).trimEnd() + "…" : line || "New chat";
}
