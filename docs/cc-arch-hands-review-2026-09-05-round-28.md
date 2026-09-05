# cc-arch-hands review — round 28

- Date: 2026-09-05
- Reviewer: HS (Euler), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `e72209a`
- Primary delta: `0b8e070..e72209a`
- Result: 3 P2, 2 P3

## Findings

### P2 — installed companion tree lacks an explicit ESM boundary for Node 18

The installer copies ESM `.js` files to `~/.claude/cah-bin` without a nearby `package.json` containing `"type": "module"`. Node 22+ syntax detection masks this in current smoke tests, but the package declares Node `>=18.17.0`, where the installed scripts are parsed as CommonJS.

Required fix: install and safely remove a managed `cah-bin/package.json` ESM boundary (or use `.mjs`) and add a structural/runtime compatibility contract that does not rely on Node 22 syntax detection.

Validation: confirmed against the declared engine contract.

### P2 — non-skill install paths can overwrite a foreign successor

Commands, Claude agents, Codex agents, and bins classify a destination and later publish without an expected leaf identity. A concurrent replacement can therefore be overwritten. The bin path additionally writes directly and then runs `chmodSync` on the canonical path.

Required fix: capture stable destination snapshots, pass them to conditional atomic publication, and apply executable mode to the private temp before rename. Add leaf-replacement interlock tests for every shared implementation path.

Validation: confirmed.

### P2 — Windows rename retries do not revalidate the expected destination

`writeFileAtomic` checks `expectedDestination` once. If the first rename fails transiently and a foreign successor appears during backoff, a later retry can overwrite it.

Required fix: revalidate the expected leaf immediately before every rename attempt and abort retries after any mismatch. Add an injected transient-failure regression.

Validation: confirmed.

### P3 — update stale-lock reclaim lacks three-party fencing

Two reclaimers can observe a stale lock; after one creates a new live lock, the other can move that successor to quarantine, leave it there on token mismatch, and then acquire the canonical path. Both processes may believe they own refresh execution.

Required fix: fence reclaim so acquisition observes in-flight quarantine before and after publication; restore a mismatched successor without overwrite and abort. Add a stale A / live B / contender C interlock test.

Validation: confirmed.

### P3 — final update-cache publication lacks leaf CAS

A successful concurrent publisher can replace the cache after the final reread but before `writeFileAtomic`; the older/failed fetch then overwrites it.

Required fix: snapshot the cache leaf at the final reread and publish conditionally with `expectedDestination`; if it changed, retain/read the concurrent winner. Add an interlock at the final publication window.

Validation: confirmed.

## Verified dispositions

- Skill leaf publication and managed deletion are identity-aware.
- Generic orphan pruning and direct removals preserve foreign successors.
- Live update-lock owners no longer block hooks for ten seconds.
- `/ccheckpoint` index publication masks ordinary termination signals across the ownership transition.
- Astra aliases, counts, generated docs, and install paths remain consistent.

## Residual risks noted by HS

Multi-file skill installation may publish earlier files before a conflict on a later leaf. Test-only interlocks remain shipped behind `CAH_TEST_ONLY=1`.

## Disposition

Round 28 is not clean. Apply another HL correction cycle, accept and commit it, then run HS round 29. Stop only at `P1–P3 findings: none`.
