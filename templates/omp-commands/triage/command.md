---
description: Inspect the OMP todo plan and propose cleanup; mutate only with explicit consent.
---
# triage

Arguments: $@

Accept no argument or --dry. Call todo view. Inspect pending, in_progress, blocked, completed and abandoned tasks by verbatim content and phase. Flag duplicate work, missing prerequisite evidence, unresolved blockers, stale active work and completion clutter only when supported by session context. Lack of visible progress in trimmed context is not proof of staleness.

Show findings, evidence and proposed actions; a clean plan is a valid result. --dry never mutates. Otherwise obtain explicit user consent before todo done/drop/rm/block/unblock or creating replacement tasks. Use the exact live contents; never invented IDs or TaskUpdate. Do not change tasks merely because another agent owns related work. After approved mutations inspect todo view and report the actual outcome. Do not implement tasks, launch agents or arm timers.
