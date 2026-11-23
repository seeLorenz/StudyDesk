# App layout

How StudyDesk's screens fit together. Agreed on 2026-11-20 after a mock and a discussion. This file covers navigation and look only; each module's own file covers what happens inside its screen.

## Four places and one chat

Changed on 2026-11-23 to the day plan ([day-plan.md](day-plan.md)): the home screen says what to do and when, instead of showing one quest.

| Place | What it's for | What's on it |
| --- | --- | --- |
| **Now** | Doing the work. The home screen. | A header that answers "what now?", the block to do now (Start, or Later…), today on the clock (school, free time, each block at its time, breaks, the nightly run), and beside it the exams ahead, quick answers and last night. Opening a block shows its quest. Earlier blocks are folded below. Now stays loaded once opened, so switching back is instant. |
| **Week** | Seeing the run-up. | Four weeks of exams: whether they fit, the tightest spot, a row per course with a mark for each block and the exam day, and this week day by day on the clock. |
| **Courses** | Checking the desk. | The semester, a card per course (how much of the target is mastered, the next exam), all dates (each with "Wrong?"), study time and files. The setup sheet and its to-do list open from here. |
| **Ask** | Understanding something. | Clicking Ask starts a new tutor chat; recent chats are listed under it to pick one up again. |

**Tell StudyDesk** (the Orchestrator's chat) sits apart at the bottom of the sidebar as a dark button and opens as a panel over whatever screen is open, expandable to a full window. Ctrl/⌘ J opens and closes it. Selecting text anywhere offers "Tell StudyDesk" next to "Reply", which opens the chat with the passage quoted.

Why: the old Today page showed one quest without a time, and the answer to "what now?" was spread over Today, Coming up, the mistake review, Organize, the setup sheet and its to-do list. Now puts it in one place; Week shows the run-up the plan is aiming at; the chat has no page of its own, so it's one keystroke from everywhere.

## Exams ahead

On Now, beside the day: the next four exams in the next four weeks, each with its date, how ready the student is (mastery toward the target grade), how many prep blocks the plan has before it, and a word: on track, tight, behind, or needs you (no material yet: one click asks StudyDesk's chat). "See the plan" opens Week. The old Coming up row is replaced by this and by Week; every hand-in and exam is still listed on Courses, each with "Wrong?".

## Courses page

- The semester (name, dates, number of courses, hours a week) with a button to the setup sheet; a card per course; all dates, each with "Wrong?"; study time per weekday; the files StudyDesk has.
- **Setup is the first state.** With no semester yet, StudyDesk opens on the setup chat with its sheet. "Start a new semester" lives in the ⋯ menu and on the setup sheet.

## Notifications

The Tell StudyDesk button shows two kinds of signal:

- **A red number:** StudyDesk needs something from you. Setting up the semester, a question waiting for an answer (`needs_answer`), a change waiting for your yes.
- **A small dot:** a new note from StudyDesk worth reading, with nothing to do (check-ins, the nightly run's summary, remarks passed on by the tutor).

Only the two most important open questions are raised in the chat by itself; the rest wait on the to-do list and in Now's quick answers. Learning things (mistake review, feedback on answers) stay on Now and never go on the badge.

## Sidebar footer and ⋯ menu

The footer shows whether the nightly run is set up and at what time. The ⋯ menu holds "Start a new semester" and the testing tools (plan today again, restart the sample semester), so they're out of the way of normal use.

## Focus mode

A button next to the StudyDesk name shrinks the sidebar to an icon strip (Now, Week, Courses, Ask, Tell StudyDesk with its badge, ⋯). The badge stays visible, so nothing is missed. The choice is remembered in this browser. Phones don't have it (the sidebar is already a drawer there).

## Phones

The sidebar becomes a drawer (menu button in the top bar, for recent chats) and a tab bar at the bottom holds Now, Week, Tell StudyDesk (a dark button in the middle, with the badge), Courses and Ask. Now stacks the day above the exams and quick answers.

## Look

- Inter for the interface, Newsreader for titles and quest text. Light and dark themes.
- **Colour only where it means something** (look "A", picked 2026-11-20): plain neutral greys in dark mode (no blue tint); blue only for "where am I" (current screen, part labels, links); green ticks for done parts; red and amber for urgency (due within a day, within three days); a red number on Tell StudyDesk when StudyDesk needs you.
- The select-to-reply highlight is strong: yellow in light mode, a bright amber in dark mode, so marked passages stand out.
- Every page starts the same way: a small uppercase kicker, a serif title, one line of context.
- Section labels are small uppercase grey; cards share one radius and border.
- Text has room to breathe (see guidelines.md).
- **Logo**: the SD planet mark (`src/assets/logo.png`, `favicon.png`), made from the full artwork by `scripts/make-logo.py`: the planet stays a dark disc, the black around it is transparent. It sits in the sidebar, the StudyDesk chat panel and the opening screen, where it breathes gently while StudyDesk loads. The claude.ai tab icon itself is chosen by the host from one generic word (`book`, see INSTALL.md), so the logo can't replace it there.
- **Text boxes stand out from the page**: every chat box and field has a field colour a step off the background and a visible edge that darkens on hover and focus, so it's always clear where to type.
- **One page pattern on every screen**: the app fills the window and never scrolls as a whole; each screen scrolls inside its own area, and a chat box stays docked at the bottom in the same spot while scrolling and at the very end.
- **Screens settle in** with a short fade instead of popping in; "Loading…" only appears when loading is actually slow.

## Notes for other modules

- **Where each date came from** (organization agent, onboarding): Coming up should show the source of each item (the calendar, a named file, or something the student said). Homework and key dates don't record their source yet, so the cards can't show it. Add a `source` field to `Assignment` and `KeyDate` when the organization agent next changes.

## Code

- `src/App.tsx`: the shell (sidebar, tab bar, ⋯ menu, which screen shows).
- `src/quests/QuestPage.tsx` with `src/now/parts.tsx`: Now. `src/now/WeekPage.tsx`: Week. The plan itself: `src/plan/` ([day-plan.md](day-plan.md)).
- `src/shell/DeskPanel.tsx`: the Courses page.
- `src/shell/ComingUp.tsx`, `src/shell/upcoming.ts`: the old Coming up row and its date logic (the date logic is still used by the chat; the row is no longer shown).
- `src/orchestrator/OrchestratorPanel.tsx`: the chat, as a panel over every screen; `onStatus` reports the badge numbers.
