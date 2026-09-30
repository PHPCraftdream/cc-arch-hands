---
description: Build an evidence-based repository map and prioritized reading list from structure, history and runtime behavior.
---
# repo-sight

Arguments: $@

Investigate the requested repository or subsystem without changing source, installing dependencies or launching agents unless explicitly requested. Combine three lenses: structure (entry points, manifests, imports, architecture), history (recent changes, churn, bug fixes and ownership), behavior (documented CLI/runtime paths, focused smoke evidence and existing checks). Do not equate line counts or a central import with importance.

Use read/glob/grep for files and LSP definitions/references when available. Use read-only Git commands for root, shallow-history status, recent log, shortlog and candidate-file history. Read manifests and CI before deciding which runtime command is safe; honor the user's test scope and never manufacture CPU load. A narrow actual smoke run should establish behavior where feasible; state unavailable runtime prerequisites instead of inventing evidence.

Stop once entry points, major data flow and the riskiest seam are understood. Return a concise repo map, a ranked reading list with reasons, one concrete verification command, and caveats (shallow history, generated/vendor trees, missing runtime). Treat checkpoints and personal data as context, not files to alter.
