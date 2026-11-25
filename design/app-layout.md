# App layout

How StudyDesk's screens fit together. Agreed on 2026-11-20 after a mock and a discussion. This file covers navigation and look only; each module's own file covers what happens inside its screen.

## Four places

The sidebar has four places, each named after what you do there:

| Place | What it's for | What's on it |
| --- | --- | --- |
| **Today** | Doing the work. The home screen. | Mistake review (after grading, starts collapsed), today's quest (its header shows only "Why today"; extra notes behind "More about this quest"), and **Coming up** under the header. Today stays loaded once opened, so switching back is instant. |
| **Ask** | Understanding something. | Clicking Ask starts a new tutor chat; recent chats are listed under it to pick one up again. |
| **Courses** | Checking what StudyDesk knows. | The semester, a card per course, and a page per course ([courses.md](courses.md)). |
| **Organize** | Running your desk. | The Orchestrator chat on the left, the To do list on the right. |

Organize sits apart at the bottom of the sidebar as a dark button, because it works from every screen. Ctrl/⌘ J opens it as a quick panel over whatever you're looking at; on the Organize page itself it puts the cursor in the chat.

Why the names: there used to be two chats ("Ask" and "Talk to StudyDesk") and you had to know which one to use. Now the name says the job: Ask = learn, Courses = check, Organize = change.

## Coming up

On Today it starts **folded to one line** ("Coming up: Calc quiz in 5 days · LA exam in 7 days · +3 more"), so the quest stays the main thing (changed after the first try felt cluttered). Clicking it opens a row of cards: every hand-in, exam and quiz in the next six weeks, soonest first, with a countdown. It scrolls sideways with arrow buttons (no visible scrollbar). Cards due within a day get a red top edge, within three days a yellow one.

The point is **verification, not just trust**: the student sees at a glance whether StudyDesk knows every deadline. Each card has a small "Wrong?" link that opens Organize with that item quoted, so a wrong or missing date is fixed in one message.

Keep it uncluttered: one line of facts per card, no extra badges.

## Organize page

- **Main area:** the Orchestrator chat (the same conversation as the quick panel). It takes the free width; its messages and box sit in a centred column of at most 760px, like Ask, so there's no empty gap.
- **Right:** the To do list (what StudyDesk still needs from the student) as a 400px side panel. "Answer in the chat" puts an item's questions into the chat beside it. Done items fold into one "✓ N done" line that opens them again.
- **Hiding To do** (2026-11-25): a button in its header hides it behind a slim strip, to focus on the chat. The strip carries the same red number or dot as the Organize badge, and a click brings the panel back. Remembered in this browser, like focus mode. It doesn't open by itself when something new arrives: jumping panels mid-chat is jarring and the number already says it.
- **Phones** switch between "Chat | To do"; the To do tab carries the same badge.
- The semester, courses, dates, study time and files moved to **Courses** (2026-11-24). Course progress lives there and not on Today, because Today should stay about today.
- **Setup is Organize's first state.** With no semester yet, Organize is the setup chat with its sheet. "Start a new semester" lives in the ⋯ menu, not as its own tab. Once a semester is set up, that is the only way onto the setup page; finishing setup hands over to Today.

## Notifications

Organize shows two kinds of signal:

- **A red number:** StudyDesk needs something from you. Setting up the semester, a question waiting for an answer (`needs_answer`), a change waiting for your yes, the one-time "Turn on the nightly run" step until the first night has run (design/scheduled-runs.md).
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
- **Logo**: the SD planet mark (`src/assets/logo.png`, `favicon.png`), made from the full artwork by `scripts/make-logo.py`: the planet stays a dark disc, the black around it is transparent. It sits in the sidebar, the Organize panel and the opening screen, where it breathes gently while StudyDesk loads. The claude.ai tab icon itself is chosen by the host from one generic word (`book`, see INSTALL.md), so the logo can't replace it there.
- **Text boxes stand out from the page**: every chat box and field has a field colour a step off the background and a visible edge that darkens on hover and focus, so it's always clear where to type.
- **One page pattern on every screen**: the app fills the window and never scrolls as a whole; each screen scrolls inside its own area, and a chat box stays docked at the bottom in the same spot while scrolling and at the very end.
- **Screens settle in** with a short fade instead of popping in; "Loading…" only appears when loading is actually slow.

## Notes for other modules

- **Where each date came from** (organization agent, onboarding): Coming up should show the source of each item (the calendar, a named file, or something the student said). Homework and key dates don't record their source yet, so the cards can't show it. Add a `source` field to `Assignment` and `KeyDate` when the organization agent next changes.

## Code

- `src/App.tsx`: the shell (sidebar, tab bar, ⋯ menu, which screen shows).
- `src/shell/ComingUp.tsx`, `src/shell/upcoming.ts`: the Coming up row and its date logic.
- `src/courses/CoursesPage.tsx`: the Courses tab and each course's page.
- `src/orchestrator/OrchestratorPanel.tsx`: the chat; with `dock` it renders into the Organize page instead of as a panel (and the To do list into `todoDock`, `src/onboarding/TodoList.tsx`), and `onStatus` reports the badge numbers.
