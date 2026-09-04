# Review round 22 — cc-arch-hands cleanup and Fable 5.1

Date: 2026-09-04 13:59 (Europe/Berlin)

Scope: static review of the current unstaged worktree against `b9a333e`.
Per request, no tests, generators, package builds, or application commands were
run. The only external check was a read-only npm registry query. Source files
were not modified as part of this review.

## Verdict

The tracked product code is clean of agent-tree: excluding this review artifact,
there are no agent-tree files, imports, selectors, flags, manifest entries,
sentinels, package scripts, or current product-documentation references left in
the working copy. The remaining skill
installer will also preserve an old separately-stamped `agent`/`agent-new`
installation as foreign data rather than pruning it. The deleted checkpoints
are agent-tree-only session histories, so deleting them is consistent with the
extraction.

The change is not release-ready yet. Two release/documentation issues from the
previous review remain, and Fable 5.1 still lacks an independent contract test.
There are also local, non-shipping agent-tree remnants under ignored/untracked
scratch directories.

## Findings

### P1 — the release version and changelog state are contradictory

Evidence:

- `package.json:3` and `lib/update-check.js:17` identify the working package as
  `0.8.0`.
- `CHANGELOG.md:40` already declares `## [0.8.0] - 2026-09-01`.
- The breaking command opt-in change and Fable 5.1 are still under
  `Unreleased` (`CHANGELOG.md:8-38`), so they would ship in the package while
  being absent from the declared 0.8.0 release notes.
- A read-only `npm view cc-arch-hands version versions --json` check reports
  `0.7.2` as the latest published version and no published `0.8.0`; the local
  repository also has no `v0.8.0` tag.

If the next publication is 0.8.0, fold all current `Unreleased` entries into
the 0.8.0 section and set the actual release date. If 0.8.0 is intentionally
treated as an internal completed release, bump `package.json` and
`CURRENT_VERSION` and create the matching next changelog section. Do not
publish the current tree with this ambiguity.

### P2 — extraction of agent-tree is silent in user-facing release notes

The cleanup removes both the implementation and every mention of the feature,
but `CHANGELOG.md` has no `Removed`/migration entry explaining that agent-tree
moved to a separate package/repository. Existing source users can otherwise
only observe that `--agent-tree` became an unknown option.

Add a short entry naming the new repository/package and its install/migration
command. This is not an unwanted implementation residue; it is the hand-off
contract for the removed feature. Before releasing this repository, ensure the
adjacent agent-tree migration change that recognizes the old
`<!-- cah-agent-tree:v1 -->` sentinel is committed and released there.

### P2 — README still labels the top Fable shortcut as Fable 5

`README.md:73` says:

```text
/fxx  Fable 5, max effort
```

But `lib/manifest.js:2-7` and the generated table map `/fxx` to
`claude-fable-5-1`; Fable 5 is now `/f1xx`. Change the example to `Fable 5.1,
max effort` or `Fable (top), max effort`.

### P2 — Fable 5.1 mapping has no independent regression oracle

The manifest itself is internally consistent:

- `fl/fm/fh/fx/fxx` map to `claude-fable-5-1` with
  `low/medium/high/xhigh/max`;
- `f1l/f1m/f1h/f1x/f1xx` map to `claude-fable-5` with the same efforts;
- the README generated table and all visible counts consistently show 48.

However, `test/installer.test.js:83-88` looks up `fh` in
`AllModelCommands` and derives its expected generated body from that same
record. A wrong manifest model ID or effort would therefore make both the
implementation and the test expectation wrong in the same way. The CLI test
at `test/cli.test.js:361` checks only the total count.

Add a fixed-data contract test for all ten Fable aliases (at minimum `fh` and
`f1h`) that asserts the literal model IDs and efforts, plus generated command
and agent frontmatter. A small explicit assertion for
`toDisplayName('claude-fable-5-1') === 'Fable 5.1'` would protect the status-line
presentation too. The exact external availability of `claude-fable-5-1` and
its full effort matrix could not be independently confirmed from public model
documentation, so verify it against the account's authoritative model registry
before release.

### P3 — two CLI comments still describe the pre-opt-in model

- `lib/cli.js:165-166` says an empty selector means "all classes" and the
  original "do everything" default, while it now returns only
  `agents`, `skills`, and `bins`.
- `lib/cli.js:197` introduces the shared opt-in helper as applying
  `--codex-agents` but omits `--commands`.

Runtime behavior is correct; update the comments to say "default classes" and
name both opt-in flags so later maintenance does not reintroduce the removed
semantics.

### P3 — no explicit regression test locks in the agent-tree removal

Generic unknown-option/name tests currently exercise the underlying rejection
path, but nothing specifically asserts the extraction boundary. Add a compact
test that `parseOnly('agent-tree')` throws, `install --agent-tree` is rejected,
and `version`/`list --json` expose no `agent-tree` field or row. This prevents a
partial reintroduction through a future merge.

### P3 — local checkout still contains agent-tree scratch artifacts

The deliverable is clean, but the checkout directory is not fully cleaned:

- ignored `.rush/` contains agent-tree prompts, outputs, errors, and lock names;
- untracked `tmp/` contains `fix/eng/agent-tree.js`,
  `real/eng/agent-tree.js`, and `review-current/engine/agent-tree.js`, along
  with older scratch/log files;
- `/tmp/` is not ignored as a directory, so it keeps the worktree noisy and can
  be accidentally staged. Individual `*.log` files happen to be ignored.

These paths are excluded from the npm package by the `files` allowlist, so this
is not a shipping leak. Delete the obsolete local scratch data after confirming
it is no longer needed, and either add `/tmp/` to `.gitignore` or keep future
scratch work outside the repository. `.rush/` already carries its own ignore
rule.

## Agent-tree cleanup audit

Statically confirmed:

- before adding this report, no matching tracked/current content for
  `agent-tree`, `agent-new`,
  `cah-agent-tree`, `AllAgentTreeSkills`, `SentinelAgentTree`,
  `SetForAgentTree`, or `--agent-tree` outside local scratch areas;
- no agent-tree paths in the current tracked file set, `lib/`, `templates/`,
  `test/`, or package test script;
- `lib/cli.js` no longer imports, dispatches, lists, diagnoses, or versions the
  extracted class;
- `lib/manifest.js` and `lib/sentinel.js` no longer own its registry/sentinel;
- `package.json`'s `files` allowlist contains only `bin/`, `lib/`, `templates/`,
  changelog, and licenses, none of which currently contains the extracted tree;
- `writeSkills()` orphan pruning is sentinel-gated by `SetForSkill`, so an old
  `<!-- cah-agent-tree:v1 -->` installation is not mistaken for a normal skill
  and is preserved for migration by the new package;
- all package script test paths that remain correspond to the cc-arch-hands
  codebase; the agent-tree runtime/backend suites were removed;
- `git diff --check` reports no whitespace errors.

## Verification limitation

No tests were run, as requested. In particular, this review does not claim a
fresh passing result for `npm test`, `gen:docs --check`, install/uninstall smoke
tests, or package dry-run contents. Those should be run after the findings are
fixed and before publication.
