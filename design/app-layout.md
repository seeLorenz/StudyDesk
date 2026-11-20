# App layout

How StudyDesk's screens fit together. Agreed on 2026-11-20 after a mock and a discussion. This file covers navigation and look only; each module's own file covers what happens inside its screen.

## Three places

The sidebar has three places, each named after what you do there:

| Place | What it's for | What's on it |
| --- | --- | --- |
| **Today** | Doing the work. The home screen. | Mistake review (after grading), today's quest, and the **Coming up** row under the quest's header. |
| **Ask** | Understanding something. | Clicking Ask starts a new tutor chat; recent chats are listed under it to pick one up again. |
| **Organize** | Running your desk. | The Orchestrator chat on the left, everything StudyDesk knows about the semester on the right. |

Organize sits apart at the bottom of the sidebar as a dark button, because it works from every screen. Ctrl/⌘ J opens it as a quick panel over whatever you're looking at; on the Organize page itself it puts the cursor in the chat.

Why the names: there used to be two chats ("Ask" and "Talk to StudyDesk") and you had to know which one to use. Now the name says the job: Ask = learn, Organize = change or check your desk.

## Coming up

A row of cards on Today: every hand-in, exam and quiz in the next six weeks, soonest first, with a countdown. It scrolls sideways with arrow buttons (no visible scrollbar). Cards due within a day get a red top edge, within three days a yellow one.

The point is **verification, not just trust**: the student sees at a glance whether StudyDesk knows every deadline. Each card has a small "Wrong?" link that opens Organize with that item quoted, so a wrong or missing date is fixed in one message.

Keep it uncluttered: one line of facts per card, no extra badges.

## Organize page

- **Left:** the Orchestrator chat (the same conversation as the quick panel).
- **Right, top to bottom:** the semester (name, dates, number of courses, hours a week) with a button to the setup sheet; a card per course (how much of the target is mastered, open mistakes, the next exam or hand-in); all dates, each with "Wrong?"; study time per weekday; the files StudyDesk has.
- Course progress lives here and not on Today, because Today should stay about today.
- **Setup is Organize's first state.** With no semester yet, Organize is the setup chat with its sheet. "Start a new semester" lives in the ⋯ menu and on the setup sheet, not as its own tab.

## Notifications

Organize shows two kinds of signal:

- **A red number:** StudyDesk needs something from you. Setting up the semester, a question waiting for an answer (`needs_answer`), a change waiting for your yes.
- **A small dot:** a new note from StudyDesk worth reading, with nothing to do (check-ins, the nightly run's summary, remarks passed on by the tutor).

Learning things (mistake review, feedback on answers) stay on Today and never go on the badge.

## Sidebar footer and ⋯ menu

The footer shows whether the nightly run is set up and at what time. The ⋯ menu holds "Start a new semester" and the testing tools (build a new quest for today, restart the sample semester), so they're out of the way of normal use.

## Focus mode

A button next to the StudyDesk name shrinks the sidebar to an icon strip (Today, Ask, Organize with its badge, ⋯). The badge stays visible, so nothing is missed. The choice is remembered in this browser. Phones don't have it (the sidebar is already a drawer there).

## Phones

The sidebar becomes a drawer (menu button in the top bar, for recent chats) and a tab bar at the bottom holds Today, Ask and Organize, with the same badge. Organize stacks the chat above the data.

## Look

- Inter for the interface, Newsreader for titles and quest text. Light and dark themes.
- **Colour only where it means something** (look "A", picked 2026-11-20): plain neutral greys in dark mode (no blue tint); blue only for "where am I" (current screen, part labels, links); green ticks for done parts; red and amber for urgency (due within a day, within three days); a red number on Organize when StudyDesk needs you.
- The select-to-reply highlight is strong: yellow in light mode, a bright amber in dark mode, so marked passages stand out.
- Every page starts the same way: a small uppercase kicker, a serif title, one line of context.
- Section labels are small uppercase grey; cards share one radius and border.
- Text has room to breathe (see guidelines.md).

## Notes for other modules

- **Where each date came from** (organization agent, onboarding): Coming up should show the source of each item (the calendar, a named file, or something the student said). Homework and key dates don't record their source yet, so the cards can't show it. Add a `source` field to `Assignment` and `KeyDate` when the organization agent next changes.

## Code

- `src/App.tsx`: the shell (sidebar, tab bar, ⋯ menu, which screen shows).
- `src/shell/ComingUp.tsx`, `src/shell/upcoming.ts`: the Coming up row and its date logic.
- `src/shell/DeskPanel.tsx`: the right side of the Organize page.
- `src/orchestrator/OrchestratorPanel.tsx`: the chat; with `dock` it renders into the Organize page instead of as a panel, and `onStatus` reports the badge numbers.
