// Anki for things learned by heart. A skill's cards are written once, by the
// lesson that first teaches it, and kept in the quest records. Later quests
// don't teach that skill again: they open with "study this in Anki" and test
// a few of its cards in StudyDesk, and only that test counts toward mastery.
// The export is Anki's plain-text import, which the desktop app, AnkiDroid and
// AnkiMobile all read; each card's id comes from the course and its front, so
// importing again updates cards instead of adding a second copy.

import { subId } from "../onboarding/todo";
import { QUEST_CONFIG } from "./config";
import type { Card, ProblemPart, Quest, QuestRecord, Semester } from "./types";

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const key = (c: Card) => flat(c.front).toLowerCase();

/** Every skill's cards, from the lessons that wrote them. */
export function decks(quests: Quest[]): Map<string, Card[]> {
  const out = new Map<string, Map<string, Card>>();
  for (const quest of [...quests].sort((a, b) => a.createdAt - b.createdAt))
    for (const p of quest.parts) {
      if (p.kind !== "lesson" || !p.cards?.length) continue;
      const deck = out.get(p.skillIds![0]) ?? new Map<string, Card>();
      for (const c of p.cards) deck.set(key(c), c);
      out.set(p.skillIds![0], deck);
    }
  return new Map([...out].map(([id, d]) => [id, [...d.values()]]));
}

/**
 * Turns a planned quest's problems on skills that have a deck into deck tests,
 * with an Anki step in front. Lessons on those skills become tests too: by-heart
 * material is relearned in Anki, not taught again. Only with Anki on.
 */
export function addAnki(quest: Quest, records: QuestRecord[], semester: Semester): void {
  if (!semester.questSettings?.anki) return;
  const all = decks(records.map((r) => r.quest));
  const tested = new Set<string>();
  const { cardsPerTest, baseMinutes, perCard } = QUEST_CONFIG.anki;
  let cards = 0;
  for (const part of quest.parts) {
    if (part.kind !== "lesson" && part.kind !== "practice") continue;
    for (const p of part.problems) {
      const deck = all.get(p.skillId);
      if (!deck) continue;
      // Each test takes the next cards of the deck, so the whole deck comes round over time.
      const past = records.flatMap((r) => r.quest.parts).filter((x) => x.kind !== "learn" && x.problems.some((y) => y.skillId === p.skillId && y.cards)).length;
      const start = (past * cardsPerTest) % deck.length;
      p.cards = [...deck, ...deck].slice(start, start + Math.min(cardsPerTest, deck.length));
      cards += p.cards.length;
      tested.add(p.skillId);
    }
    if (part.kind === "lesson" && part.problems[0].cards) {
      const test: ProblemPart = { kind: "practice", id: part.id, title: `Test: ${part.title}`, gate: false, problems: part.problems };
      quest.parts[quest.parts.indexOf(part)] = test;
    }
  }
  if (!tested.size) return;
  const minutes = Math.round(baseMinutes + perCard * cards);
  const names = [...tested].map((id) => semester.skills.find((s) => s.id === id)?.name ?? id);
  const first = quest.parts.findIndex((x) => x.kind !== "learn" && x.problems.some((p) => p.cards));
  quest.parts.splice(first, 0, {
    kind: "learn",
    id: "anki",
    title: `Study in Anki: ${names.join(", ")}`,
    skillIds: [...tested],
    estMinutes: minutes,
    body: `Study these cards in Anki for about ${minutes} minutes: ${names.join(", ")}. If they aren't in Anki yet, use **Export deck** at the top and import the file first. Then take the short test below; that test is what counts for your progress.`,
  });
  quest.plannedMinutes += minutes;
}

/** Anki's text import: one deck per topic, every card of the topics this quest touches. */
export function ankiDeck(quest: Quest, records: QuestRecord[], semester: Semester): { text: string; count: number } | null {
  const all = decks([...records.map((r) => r.quest).filter((q) => q.id !== quest.id), quest]);
  const course = semester.courses.find((c) => c.id === quest.courseId);
  const topicOf = (skillId: string) => semester.skills.find((s) => s.id === skillId)?.topicId;
  const topics = new Set(quest.parts.flatMap((p) => (p.kind === "learn" ? p.skillIds : p.problems.map((x) => x.skillId))).filter((id) => all.has(id)).map(topicOf));
  const rows = new Map<string, string>();
  for (const [skillId, cards] of all) {
    if (!topics.has(topicOf(skillId))) continue;
    const deck = `StudyDesk::${flat(course?.name ?? quest.courseId)}::${flat(course?.topics.find((t) => t.id === topicOf(skillId))?.name ?? "Cards")}`;
    for (const c of cards) rows.set(`sd-${quest.courseId}-${subId(key(c))}`, `${deck}\t${flat(c.front)}\t${flat(c.back)}`);
  }
  if (!rows.size) return null;
  const head = ["#separator:tab", "#html:false", "#notetype:Basic", "#guid column:1", "#deck column:2"];
  return { text: [...head, ...[...rows].map(([id, row]) => `${id}\t${row}`)].join("\n") + "\n", count: rows.size };
}
