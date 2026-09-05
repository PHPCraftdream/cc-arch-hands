# cc-arch-hands review — round 32

- Date: 2026-09-05
- Reviewer: HS (Sagan), read-only review; tests were not run by the reviewer
- Reviewed HEAD: `93f59d5`
- Result: 2 P2, 2 P3

## Findings

### P2 — incompatible foreign ESM boundary permits a broken bin install

If `~/.claude/cah-bin/package.json` is foreign and declares CommonJS (or otherwise lacks a compatible module boundary), the installer preserves it but continues writing ESM `.js` files and reports success. Node 18 then cannot run the installed scripts.

Required fix: preflight the boundary before any bin mutation; either accept a compatible foreign `type: module` boundary or fail without partial writes. Add installed-tree smoke coverage for the incompatible case.

### P2 — probe rollback rediscovers publication ownership by content

After atomic publication but before the code captures the published snapshot, an external writer can replace the leaf with byte-identical content. Content equality can then misclassify that successor as this transition's inode and roll it back.

Required fix: have atomic publication return the identity of its published inode and use that identity for all rollback; never infer ownership from payload equality.

### P3 — foreign orphan survivors are not reported

Removed aliases and identity-changed orphan candidates can survive pruning but remain absent from `skipped`/`preserved`, including a foreign legacy Codex name.

Required fix: return every stable surviving orphan candidate from pruning and normalize/deduplicate those paths in commands, agents, Codex agents, and bins.

### P3 — generated-adjacent prose counts are stale

README/CLAUDE prose still mentions three companion bins, one shared dependency, and 35/70 generated command-agent definitions instead of the current four bins, five shared library leaves, and 44/88 definitions/bodies.

Required fix: update prose and add fixed-oracle documentation assertions outside generated markers.

## Verified model disposition

The repository consistently defines 24 Codex agents: Terra, Luna, Sol, and Astra with six effort levels each. Astra uses `gpt-6-astra`; the twelve GPT-5.5/5.4/5.4-mini active definitions are removed and sentinel-owned legacy files are pruned.

## Disposition

Round 32 is not clean. Apply another HL cycle and repeat HS review until `P1–P3 findings: none`.
