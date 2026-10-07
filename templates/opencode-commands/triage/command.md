---
description: Inspect the todo plan and propose cleanup; mutate only with explicit consent.
---
# triage

Arguments: $ARGUMENTS

Accept no argument or --dry. Call cah_todos. Inspect pending, in_progress and completed tasks plus content-level blocker annotations by verbatim content (OpenCode has no blocked status). Flag duplicate work, missing prerequisite evidence, unresolved blockers, stale active work and completion clutter only when supported by session context. Lack of visible progress in trimmed context is not proof of staleness.

Show findings, evidence and proposed actions; a clean plan is a valid result. --dry never mutates. Otherwise obtain explicit user consent before todowrite mutations (completing, removing or rewriting tasks) or creating replacement tasks. Use the exact live contents; never invented IDs. Do not change tasks merely because another agent owns related work. After approved mutations call cah_todos and report the actual outcome. Do not implement tasks, launch subagents or arm timers.
