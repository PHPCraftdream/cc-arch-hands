# babygoal

Set a goal and start babysitting it in one step.

## Usage

```
/babygoal Implement authentication module with JWT tokens
/babygoal 5m Refactor the database layer
```

The first argument is an optional interval (e.g. `5m`, `1h`). Everything else is the goal description.

## Behavior

1. **Parse the argument.** If the first word matches a time interval pattern (digits + `s`/`m`/`h`), use it as the babysit interval. Otherwise default to `15m`.
2. **Set the goal.** Invoke `/goal <description>` to activate the built-in Stop hook — the session will not stop until the goal is met.
3. **Decompose and start.** Break the goal into tasks (TaskCreate), then begin executing them immediately.
4. **Start babysitting.** Once work is underway, invoke `/babysit` with the resolved interval so that progress is monitored and resumed automatically if interrupted.

## Important

- The goal description is everything after the optional interval.
- If no goal text is provided, ask the user what the goal is — do not start an empty babysit.
- Begin working on the tasks right away, do not just create them and wait.
