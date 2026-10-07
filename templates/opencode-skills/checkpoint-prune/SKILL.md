---
name: checkpoint-prune
description: "Preview and remove selected project checkpoint files, with confirmation for batch deletion and a --dry mode."
---
# checkpoint-prune

Arguments: take them from the user's request that triggered this skill.

Resolve the caller Git repository with git rev-parse --show-toplevel. Refuse outside Git. Operate only on regular .md files in that repository's docs/checkpoints/, never on redirected directories, symlinks, other projects or subdirectories. Missing directory means nothing to prune.

Parse optional --dry first; it never deletes. Select by these rules: no argument = all checkpoints; digits followed by d or h = mtime older than that age; digits alone = keep the N most recently modified files; otherwise = exact safe filename, with optional .md, never a prefix or path. Reject invalid arguments rather than broadening the selection.

Show selected names, mtime, size and mode. If empty, report nothing to prune. Ask for confirmation before batch deletion, including no argument; only an explicit exact single filename authorizes deletion without a second confirmation. Use file APIs to unlink each selected file after rechecking its location and regular-file identity. Stop on the first error and report removed versus preserved files. Never remove the directory itself or stage/commit changes. Use /checkpoint-resume --list for read-only browsing.
