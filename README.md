# StudyDesk

A study assistant for high school and university students that runs as a
[claude.ai](https://claude.ai) artifact. Claude calls run on each user's own
Claude plan, and chats are saved privately per user in the artifact's database.

Experimental: tested by a small group before deciding whether to build a
standalone version

## What's here so far

- A chat with Claude: paste or drop screenshots, PDFs and text files.
- **Select to reply:** select any part of an answer, press Reply, and ask
  about it. The answer opens in a collapsible side note next to that passage
  instead of growing the main chat. Notes can take follow-up questions.

## Develop

```sh
npm install
npm run dev        # local preview with a stand-in for Claude
npm test           # unit tests
npm run build      # writes artifact/index.html, the page published to claude.ai
```

`npm run build` bundles everything into one HTML file (`dist/index.html`) and
then strips the document skeleton, because the artifact host adds its own
(`artifact/index.html`).

## Layout

- `src/platform/claude.ts`: the only code that calls Claude (the artifact `sample` capability).
- `src/platform/store.ts`: the only code that touches storage (artifact `db`, or `localStorage` outside claude.ai).
- `src/chat/`: the chat, side notes, selection popover and composer.
- `src/mastery/`: grading and mastery rules (streaks, review ladder, mastery, timing, points, grading agent). See `design/grading-and-mastery.md`.
- `src/platform/masteryStore.ts`: storage for skills, attempts and review items.
- `src/lib/`: markdown and math rendering, text anchors for highlights, file reading.
- `design/`: the system design in plain English, one file per module.
- `types/claude/`: type definitions for the artifact runtime (contract 0.2.96).

Capabilities the artifact declares: `sample` (with images), `db`, `user`.

## Sharing with testers

Invite each tester by email as **Editor** in the artifact's share menu, and
don't turn on a public link. People outside your account can only save data
as Editors, and only while there's no public link.

Don't put personal data or secrets in this repository; it's public.
