# Ideas for later

Ideas that came up while building StudyDesk but aren't part of the current version. Nothing here is designed or built yet. When an idea gets picked up, it moves into its own module file with a proper design.

## Developer log mode

A switch that shows what the agents and Claude sessions are doing behind the scenes, and why. For each session (Orchestrator, tutor, organization agent, grading, the nightly run) it would show the reasoning behind its decisions, which files and data it opened, the tools it called, and what it changed. The point is to see what's going on inside the models, so you can tell why a quest, grade or change came out the way it did, and debug prompts when something goes wrong. It should be off by default and meant for developers, not something students see in normal use.
