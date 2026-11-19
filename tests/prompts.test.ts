import { describe, expect, it } from "vitest";
import { mainTurns, noteTurns } from "../src/chat/prompts";
import type { Chat } from "../src/chat/types";

const chat: Chat = {
  id: "c", title: "t", createdAt: 0, updatedAt: 0,
  messages: [
    { id: "u1", role: "user", text: "What is osmosis?", createdAt: 1 },
    { id: "a1", role: "assistant", text: "Osmosis is the diffusion of water across a membrane.", createdAt: 2 },
    { id: "u2", role: "user", text: "And diffusion?", createdAt: 3 },
    { id: "a2", role: "assistant", text: "Later answer", createdAt: 4 },
  ],
  notes: [],
};

describe("prompts", () => {
  it("main turns start and end with the student", () => {
    const t = mainTurns(chat.messages.slice(0, 3));
    expect(t[0].role).toBe("user");
    expect(t.at(-1)).toEqual({ role: "user", content: "And diffusion?" });
  });

  it("note turns include the passage and only the conversation up to it", () => {
    const t = noteTurns(chat, {
      id: "n", messageId: "a1", quote: "a membrane", label: "a membrane", nth: 0, collapsed: false, createdAt: 5,
      turns: [{ role: "user", text: "Which membrane?" }, { role: "assistant", text: "" }],
    });
    expect(t[0].content).toContain('"""a membrane"""');
    expect(t[0].content).not.toContain("Later answer");
    expect(t.at(-1)).toEqual({ role: "user", content: "Which membrane?" });
  });
});
