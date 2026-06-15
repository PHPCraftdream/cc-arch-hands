# Contributing

## Setup

```bash
git clone https://github.com/PHPCraftdream/cc-arch-hands
cd cc-arch-hands
```

No `npm install` needed — zero runtime dependencies, tests use `node:test` + `node:assert`.

## Development loop

```bash
npm test                            # full suite (49 tests)
node --test test/cli.test.js        # single file
node bin/cah.js install --templates ./templates --only skills --cwd /tmp/sandbox
```

## Adding a new model

Add one object to `AllModelCommands` in `lib/manifest.js`. Commands and agents are generated automatically at install time.

## Adding a new skill

1. Create `templates/skills/<name>/SKILL.md` (and any other files the skill needs).
2. Append `'<name>'` to `AllSkills` in `lib/manifest.js`.

Do NOT add the sentinel manually — `writeSkills` stamps it automatically.

## Tests

- Tests that mutate `AllSkills` must save/restore the array in a try/finally block.
- `node:test` describe/it + `node:assert/strict` — no external test deps.

## What NOT to touch

- The `/crush` slash-command (`<!-- crush-slash-command:v1 -->`) is not managed by `cah`. Never add install/remove logic for it.
- `agentGitSafetyClause` and `agentTestScopeClause` in `lib/agents.js` are contract text shared across all generated agents. Edit with care.

## License

By contributing you agree to license your work under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at the user's option.
