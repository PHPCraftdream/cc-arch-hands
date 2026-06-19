# task

Decompose a free-form request into a prioritized, dependency-ordered task list and add it to the session.

## Usage

```
/task Implement OAuth login with Google and GitHub
/task Migrate the user table to a new schema with zero downtime
/task Fix the flaky CI tests in the payments module
```

The argument is a free-form description of what needs to get done.

## Behavior

1. **Analyze the request.** Read the argument carefully. Identify scope, ambiguities, and any implicit prerequisites (setup, research, design choices). If the request is too vague to decompose, ask one clarifying question and stop.
2. **Decompose into sub-tasks.** Break the work into small, concrete, independently-verifiable steps. Each task should be doable in one focused session — split anything larger.
3. **Order and resolve dependencies.** Determine the execution order. For each task that depends on another, record the dependency explicitly via `blockedBy` so the planner can surface only the tasks that are actually ready to claim.
4. **Add to the session.** Create the tasks with TaskCreate in the planned order. Use the `blockedBy` field for dependencies. Do NOT start executing them — only register the plan.
5. **Report.** Print the resulting plan as a short numbered list: id, subject, and (if any) what it's blocked by. End with the count and a one-line summary.

## Important

- This skill ONLY plans — it does not execute the tasks. To start work, the user runs the tasks themselves or invokes `/babygoal` / `/babysit` separately.
- Prefer fewer, larger-grained tasks over many tiny ones. A good rule: each task is a paragraph of work, not a single line edit.
- If TaskList already has open tasks, ask the user whether to extend the existing plan or replace it before creating anything.
