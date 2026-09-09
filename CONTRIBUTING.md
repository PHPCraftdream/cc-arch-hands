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
2. Register it in `package.json` under `bin` so `npm install -g` puts it on PATH — **and register the same file in `BinFileDefinitions` (`lib/binstall/runtime.js`)**. The npm `bin` field alone does not install the runtime hooks actually use: `settings.json` references the copies under `~/.claude/cah-bin/`, and `writeBins` copies exactly the frozen `BinFileDefinitions` entries there. Every local `lib/` module your bin imports must also be a registered entry — the derived import graph refuses an unmanaged import at install time — and publication is dependency-first, so leaves land before the bins that import them.
3. Test the installed artifact, not only the checkout: after `cah install`, the hook runs from `~/.claude/cah-bin/bin/<bin-name>.js`. Black-box tests that spawn the bin cover this; tests that only import the source do not.
4. Test files need no registration. `npm test` is bare `node --test --test-concurrency=1`, which discovers every `test/*.test.js` automatically — do not add test files to any `package.json` script (`test/discovery-contract.test.js` enforces the exact script and fails if you do).
5. **Share transcript parsing and limit math with `lib/transcript-stats.js`** — never recompute `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` inline. That formula is delicate (the cache-read fields dominate after the first turn) and lives in one place for a reason.
6. Inside bins, catch failures and exit 0. Stop/PostToolUse hooks may remain silent when there is nothing to emit. A statusLine command must emit a non-empty fallback (for example `—`); the diagnostic probe likewise keeps its placeholder. Do not apply the hooks' empty-stdout fallback to statusLine bins.

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
