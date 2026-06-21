# Contributing

## Setup

```bash
git clone https://github.com/PHPCraftdream/cc-arch-hands
cd cc-arch-hands
```

No `npm install` needed — zero runtime dependencies, tests use `node:test` + `node:assert`.

## Development loop

```bash
npm test                            # full suite
node --test test/cli.test.js        # single file
node bin/cah.js install --templates ./templates --only skills --cwd /tmp/sandbox
```

## Adding a new model

Add one object to `AllModelCommands` in `lib/manifest.js`. Commands and agents are generated automatically at install time.

## Adding a new skill

1. Create `templates/skills/<name>/SKILL.md` (and any other files the skill needs).
2. Append `'<name>'` to `AllSkills` in `lib/manifest.js`.

Do NOT add the sentinel manually — `writeSkills` stamps it automatically.

## Adding a companion bin (for hooks / statusLine)

If a new skill needs to install a Stop hook or a statusLine in user `settings.json`:

1. Add a Node script under `bin/<bin-name>.js` with `#!/usr/bin/env node`.
2. Register it in `package.json` under `bin` so `npm install -g` puts it on PATH.
3. Add the test file to the `test` script in `package.json` too.
4. **Share transcript parsing and limit math with `lib/transcript-stats.js`** — never recompute `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` inline. That formula is delicate (the cache-read fields dominate after the first turn) and lives in one place for a reason.
5. Inside the bin: fail-silent on every error path (`try/catch` everything, exit 0 with no stdout). A broken hook must never block the user's session.

## Tests

- Tests that mutate `AllSkills` must save/restore the array in a try/finally block.
- `node:test` describe/it + `node:assert/strict` — no external test deps.
- For bin scripts, prefer black-box tests that spawn the bin with a constructed stdin payload and assert on stdout — see `test/checkpoint-hint.test.js`, `test/clock.test.js`, `test/stamp.test.js` as references.
- Pure helper modules (`lib/transcript-stats.js`) get unit tests in their own `test/*.test.js`.

## What NOT to touch

- The `/crush` slash-command (`<!-- crush-slash-command:v1 -->`) is not managed by `cah`. Never add install/remove logic for it.
- `agentGitSafetyClause` and `agentTestScopeClause` in `lib/agents.js` are contract text shared across all generated agents. Edit with care.
- The cache-aware token sum in `lib/transcript-stats.js` `findContextTokens` — if you change the formula, also update the link to the official `code.claude.com/docs/en/statusline` reference comment.

## License

By contributing you agree to license your work under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at the user's option.
