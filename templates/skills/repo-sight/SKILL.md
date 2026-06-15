---
name: repo-sight
description: "Diagnose an unfamiliar repository from its git history, structure and behavior before reading any code, and return a ranked reading list with explicit caveats. Use when picking up a new codebase, onboarding to a project, auditing a legacy repo, or deciding where to start reading."
---

# repo-sight — see the repo before you read it

The first hour you spend on a new codebase decides whether you understand it
in a day or in a month. This skill encodes a single move: **interrogate the
repository's history, structure, and behavior with cheap probes before
opening any file**, then return a ranked reading list with explicit caveats
about what the probes could not see.

This is a synthesis of [Ally Piechowski's *"The Git Commands I Run Before
Reading Any Code"*](https://piechowski.io/post/git-commands-before-reading-code/),
Adam Tornhill's *Your Code as a Crime Scene* (behavioral code analysis), and
the classical engineering practice of tracer-bullet / vertical-slice
exploration.

---

## §1 — Mental model: three lenses, golden intersections

Any attempt to understand unfamiliar code looks through one of three
independent lenses. **Each lens is blind in its own way; truth lives in
their intersections.** Refuse to draw conclusions from a single lens.

| Lens | Question | How to look | Blind spot in isolation |
|---|---|---|---|
| **STRUCTURE** (static) | what exists and what depends on what | dir tree, language/size (`tokei`, `scc`), import graphs, manifests, types/schemas/API surface, public exports | looks clean, hides that one tidy module is patched every week |
| **HISTORY** (time) | how it became this and where it hurts | churn, co-change, bug clusters, velocity, bus factor, firefighting; `git log -p`, `git blame`, `git bisect` | finds the hot file but not *why* it is central or what it does at runtime |
| **BEHAVIOR** (dynamic) | what actually runs | run the binary; run the tests; trace ONE flow end-to-end; coverage; logs; "tracer bullet" — change one thing, watch where it leaks | proves it works, gives no map of where the logic lives |

**The intersections are where you read first:**

- **STRUCTURE ∩ HISTORY** = architectural debt (central AND volatile).
- **HISTORY ∩ BEHAVIOR** = real critical path (hot in history AND on a
  runtime path).
- **STRUCTURE ∩ BEHAVIOR** = load-bearing core (hub of the graph AND on
  the executed path).
- **STRUCTURE ∩ HISTORY ∩ BEHAVIOR** = read this first, no exceptions.

The single sharpest **risk** signal is **disagreement**: a file is
structurally central, historically hot, **and has zero tests**. That is
where everything will break next.

---

## §2 — Preflight: can the history even be trusted?

Run these *before* the five probes. If any answer is bad, the numbers below
are meaningless and you must say so in the report.

```bash
# Truncated clone? — then "1 year ago" measures cloning, not the project.
git rev-parse --is-shallow-repository
# If true:
# git fetch --unshallow

# Squash-merge workflow? — then shortlog and bug-keyword greps tell you about
# the bot that merged, not the human who wrote.
git log --merges --format='%s' -10

# Commit-message hygiene — if every message is "wip" / "update stuff", the
# bug-keyword probe is dead on arrival.
git log --format='%s' -50

# Monorepo? — run every probe per-package, not from the root.
ls -1 go.mod package.json Cargo.toml pyproject.toml 2>/dev/null
ls -1d apps packages crates services 2>/dev/null

# Repo age — too young to draw conclusions?
git log --reverse --format='%ad' --date=short | head -1
```

If shallow → `fetch --unshallow` or annotate every history-derived number as
"truncated, unreliable". If squash-only → mark shortlog as "merge-author,
not write-author". If messages are garbage → skip the bug-cluster probe
entirely and say so. If monorepo → scope everything below to one
package/app at a time.

---

## §3 — The five history probes (Piechowski, verbatim + safety nets)

Run from `src/` or `app/`, **not** the repo root (lockfiles, changelogs and
generated code will dominate the lists otherwise). All five probes together
take about two minutes.

### 3.1 What changes the most — churn

```bash
git log --format=format: --name-only --since="1 year ago" \
  | sort | uniq -c | sort -nr | head -20
```

The top of this list is almost always the file people warn newcomers about.
**High churn ≠ bad** — it can mean active development — but high churn on a
file no one wants to own is the clearest *codebase-drag* signal there is.
A 2005 Microsoft Research study found churn-based metrics predict defects
more reliably than complexity metrics alone.

### 3.2 Who built this — bus factor

```bash
git shortlog -sn --no-merges                          # all time
git shortlog -sn --no-merges --since="6 months ago"   # active now
```

If one person owns ≥ 60% of all-time commits, the bus factor is one.
**Compare both lists**: if the all-time top contributor is missing from the
six-month list, the person who built the system isn't the person
maintaining it — flag this immediately. Also check the tail: many
contributors all-time but only a handful active in the last year is the
same story at scale.

### 3.3 Where bugs cluster

```bash
git log -i -E --grep="fix|bug|broken" --name-only --format='' \
  | sort | uniq -c | sort -nr | head -20
```

Same shape as 3.1, filtered to commits whose message names a bug.
**The intersection of 3.1 and 3.3 is the report's headline file**: it keeps
breaking, it keeps getting patched, it never gets properly fixed.
Useless on repos with bad commit hygiene (caught by preflight).

### 3.4 Velocity — accelerating or dying

```bash
git log --format='%ad' --date=format:'%Y-%m' | sort | uniq -c
```

Monthly commit counts for the full history. **This is team data, not code
data.** A halving in one month is usually someone leaving. A six- to
twelve-month decline is loss of momentum. Periodic spikes followed by quiet
months means the team batches into releases rather than shipping
continuously. Tag every conclusion drawn here as *team* in the report so it
isn't confused with code judgement.

### 3.5 Crisis frequency — firefighting

```bash
git log --oneline --since="1 year ago" \
  | grep -iE 'revert|hotfix|emergency|rollback'
```

A handful of hits over a year is normal. Reverts every couple of weeks
means the team doesn't trust its deploy process. Zero hits is *also* a
signal: either the team is stable, or no one writes descriptive commit
messages (re-check preflight).

---

## §4 — Structure & behavior: filling the other two lenses

Five history probes are not enough — they own one lens. These short probes
fill the other two.

### Structure (cheap, no runtime)

```bash
# Size and language distribution.
tokei .  ||  scc .  ||  cloc .

# The contract: how is it built, tested, run?
cat package.json Makefile Taskfile.yml go.mod Cargo.toml pyproject.toml 2>/dev/null

# Reality of quality gates — CI is the real spec, not the README.
ls -1 .github/workflows .gitlab-ci.yml .circleci 2>/dev/null
cat .github/workflows/*.yml 2>/dev/null | head -200

# Authoritative ownership map (often more accurate than shortlog).
cat CODEOWNERS .github/CODEOWNERS 2>/dev/null

# Entry points (where execution actually starts).
find . -maxdepth 4 -type f \( -name 'main.go' -o -name 'main.py' \
  -o -name 'index.ts' -o -name 'index.js' -o -name 'main.rs' \
  -o -path '*/cmd/*/main.go' \) 2>/dev/null | head

# Self-admitted debt — where the team itself put red flags.
grep -rnE 'TODO|FIXME|HACK|XXX' src app internal pkg 2>/dev/null \
  | head -30
```

### Behavior (one cheap experiment)

Pick one realistic user-facing flow. Run it. Watch what executes. This is
the **tracer bullet** — it converts the map into lived understanding faster
than reading ever will.

- Find the canonical command from CI (not the README — the README lies, CI
  doesn't).
- Run the test suite once. Note which tests touch the suspect files from
  §3. **Zero coverage on a hot file is your biggest finding.**
- If feasible, add a single `print` / log line in a suspect file and re-run
  the test that should touch it. If the print never fires, the file is not
  on the path you think it is.

### Co-change coupling (history with surgical precision)

For a single suspect file, which other files change *with* it? This finds
hidden modules and unspoken dependencies the import graph cannot:

```bash
git log --pretty=format:%H --name-only -- path/to/SUSPECT \
  | grep -vE '^[0-9a-f]{40}$' | grep -v '^$' \
  | sort | uniq -c | sort -nr | head
```

---

## §5 — The descent: order matters

Cheapest, highest-leverage signal first. Each step narrows the next.

| # | ~Time | Lens | Goal | Output |
|---|---|---|---|---|
| 0 | 30s | — | preflight gates (§2) | how trustworthy the rest is |
| 1 | 1m | S | what kind of project (manifests, tree, language mix) | one-sentence identity |
| 2 | 3m | H | five probes (§3) | heatmap of hurt |
| 3 | 10m | S+B | entry points, build/test/CI, ownership, TODO scan | how it runs and who knows |
| 4 | 30m | B | one vertical flow run end-to-end | grounded mental model |
| 5 | varies | S∩H∩B | read churn ∩ bug ∩ low-coverage files via `git log -p --follow` | biography of the riskiest files |
| 6 | 5m | — | synthesize the **repo map** (§6) | the artifact |

Total budget for steps 0–4: about 45 minutes. Step 5 takes as long as it
takes — that's where reading code actually starts, *with priorities*.

---

## §6 — Output contract: the repo map

A diagnostic without an artifact is wandering with style. Always produce
exactly this structure. Empty sections stay empty with a one-line reason;
do not omit them silently.

```markdown
# Repo map — <repo name>

## Identity
One sentence: domain, language, type (web app / CLI / library / monorepo).
Size: lines of code, file count, age (first commit date).

## How to run / test / build
Canonical commands taken from CI, not the README:
- build:   <cmd>
- test:    <cmd>
- lint:    <cmd>
- start:   <cmd>

## Read these files first, in this order
Three to five files. For each:
- path
- one-line "what it does"
- why it ranked: churn rank N, bug-cluster rank N, test coverage Y/N,
  central/peripheral in imports
- entry hook: which command or test exercises it

## Team & process signal (team data, NOT code data)
- bus factor: N (top author owns X% of commits)
- active maintainers vs original authors: <list of changes>
- velocity trend: <accelerating | steady | declining>; note any inflection
- firefighting rate: N reverts/hotfixes per year
- merge strategy: <merge | squash | rebase> — affects how to read history

## Caveats — what this report could NOT see
- preflight failures (shallow / squash / hygiene / monorepo scoping)
- silos (files with a single all-time author — bus factor 1 per file)
- behavior gaps (anything not exercised by the tests you ran)
- anything you literally could not run on your machine

## Open questions for the team
Things probes can't answer — ask the humans.
```

---

## §7 — Anti-patterns this skill is built to avoid

- **Reading random files first**. Without §3, the choice of "where to
  start" is uniform-random over `find . -type f`. Useless.
- **Trusting a single number**. Churn alone does not mean "bad"; bug-grep
  alone is just keyword-fragile. **Intersections, always.**
- **Trusting the README**. CI tells you what is actually enforced; the
  README tells you what someone meant to enforce six months ago.
- **Conflating team data with code data**. Velocity drops are *people*
  signals, not *codebase* signals. Mixing them produces bad recommendations.
- **Drawing conclusions on a shallow clone or fresh repo**. The numbers are
  not lying; you are reading them wrong. Annotate the report.

---

## §8 — References

- Ally Piechowski, *"The Git Commands I Run Before Reading Any Code"*
  ([piechowski.io](https://piechowski.io/post/git-commands-before-reading-code/),
  2026)
- Adam Tornhill, *Your Code as a Crime Scene* — full methodology behind
  churn × complexity overlays, knowledge maps, temporal coupling
  (`code-maat`, `CodeScene`).
- Nagappan & Ball, *"Use of Relative Code Churn Measures to Predict System
  Defect Density"*, Microsoft Research, ICSE 2005 — why churn beats raw
  complexity as a defect predictor.
- Andy Hunt & Dave Thomas, *The Pragmatic Programmer*, chapter on
  **tracer bullets** (the §4 behavior probe).
