---
name: task
description: "Plan a request as ordered, independently verifiable todo tasks without executing them."
---
# task

Arguments: take them from the user's request that triggered this skill.

Analyze the request, inspect relevant context if needed, and clarify missing intent. Call cah_todos; if unfinished tasks already exist, ask whether to append or replace before changing them. Decompose each user item into concrete independently verifiable leaves, ordered by prerequisites. Use unique stable verbatim task contents; keep dependencies and strategy readable inside the task content and session context (OpenCode todos have no blockedBy field). Register with todowrite, then call cah_todos and report the actual plan. Do not execute the tasks, arm timers or launch subagents. Do not invent task IDs or statuses. /babygoal is the execute-and-babysit counterpart.
