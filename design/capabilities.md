# Capabilities: what StudyDesk's chats can do

Both chats the student talks to (the StudyDesk chat, on Ctrl J and on the Organize page, and the semester setup page) get one shared list at the end of their rules, from `src/agents/capabilities.ts`:

- **What you can do:** the actions this chat has tools for.
- **Only elsewhere in StudyDesk:** what only the other chat can do, so Claude can say where to go.
- **StudyDesk can't:** things that don't exist (the app's look, sending emails, opening links, videos).

**The rule:** before acting, Claude checks the request against the list. If something isn't on it, Claude says plainly in one line that StudyDesk can't do that yet. It never pretends, and never works around it by saving a fact. It saves the request as a **wish** in the student's words.

Why a list in the prompt and not a lookup step: the list is in front of Claude on every call, so checking it costs no extra call.

## Wishes

- Saved on the student's profile (`profile.wishes`: text and time). In the StudyDesk chat this goes through `change` with `add_wish`, so it shows a change card with Undo. On the setup page it goes through `update_sheet`'s `wish`.
- Each wish comes with a **Send to developer** button. It opens a pre-filled GitHub issue on seeLorenz/StudyDesk that holds only the wish text, and the student presses Submit there. Nothing about the student (name, school, data) goes into it.

## Keeping it in sync

Each entry names, per chat, the tool that provides it there. Both chats pass their tools through `toolsFor(chat, tools)`. A chat only gets the tools the list grants it, and any mismatch is logged. A test reads the tools each chat really builds and fails when they differ from the list. Adding a feature (Anki export, say) means one entry plus its tool; a missing entry fails the test.

The setup chat is only for setting a semester up. Once the semester is set up, the setup page can't be reached any more (only "Start a new semester" opens it again), and to-do items start in the StudyDesk chat. So after setup there is one chat with all the tools.
