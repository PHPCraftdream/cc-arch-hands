# Context meter diagnostics

The statusLine renderer can capture bounded technical observations without enabling the raw envelope probe or replacing the normal panel. This diagnoses missing context meters; it does not relax model or compaction boundaries or invent a missing context window.

## Enable

Set `CAH_CONTEXT_TRACE_DIR` to a dedicated writable directory in the environment of the actual `cah-status` process. No trace is written when the variable is unset or empty. Setting it in an unrelated shell does not enable tracing in an already-running Claude Code session. Installing bins alone does not enable tracing or change settings.

The directory is created on the first successful observation. The renderer writes stdout before attempting trace publication. Writes are best-effort and do not wait for a busy publication fence; a failed capture must not replace the panel output.

## Captured data

Each `context-<slot>.json` contains a fixed allowlist:

- observation timestamp and total render duration;
- SHA-256 session pseudonym, not the original session ID;
- missing/null/type distinctions for context and current usage;
- booleans indicating whether a session ID, model ID and transcript path were supplied;
- model classes (`missing`, `claude`, `other`), SHA-256 model pseudonyms, and the scanner's model comparison result (`true`, `false`, or `null` when unavailable);
- finite numeric window, percentage, total input and current input/cache/output counters;
- selected usage, effective limit and source (`envelope`, `transcript`, `none`);
- fallback decision reason and bounded scanner record/byte counts;
- quota input types, finite percentages, reset field types, extraction failure, model eligibility, final visibility and source for each quota;
- the 5h fallback decision and cached observation age in milliseconds. Weekly fallback is not attempted by the renderer.

No raw envelope, transcript content, model ID, path, request ID, tool payload, environment, credentials or error message is serialized. Even so, token counters, timestamps and session pseudonyms are diagnostic metadata: review captures before sharing them.

## Reasons

| Reason | Meaning |
|---|---|
| `envelope` | The envelope supplied positive measured usage and a valid window. |
| `measured` | The transcript supplied a matching measured context. |
| `window_invalid` | No finite positive numeric window was supplied; no guessed denominator is used. |
| `model_missing` / `path_missing` | Required fallback input was unavailable. |
| `unknown_model` | An assistant/request boundary could not be assigned a model. |
| `model_mismatch` / `model_conflict` | A different model or conflicting request model blocked recovery. |
| `compaction` | The scanner reached a main-chain compaction boundary. |
| `record_limit` / `byte_limit` | The bounded scan ended before a usable measurement. |
| `read_error` | The transcript could not be opened/read. |
| `no_measurement` | No positive eligible measurement was found. |
| `render_error` | Rendering failed; error text is deliberately omitted. |

Quota `reason` distinguishes `envelope` / `cache` visibility from hidden decisions. The 5h `fallbackReason` reports `session_missing`, `model_missing`, `model_not_claude`, `cache_missing`, `session_mismatch`, `slot_invalid`, `capture_invalid`, `stale`, `reset_missing`, `reset_invalid`, `reset_elapsed`, or `read_error`. `not_needed` means the input slot was already usable; `not_attempted` is used when no fallback ran. A hidden weekly slot reports `input_missing` or `input_invalid`. `render_error` overrides visibility when the whole render failed. Model pseudonyms allow comparisons without storing raw IDs, but are not encryption: known candidate IDs can be hashed and matched.

Reasons describe the decision in cah, not the upstream cause. For example, `unknown_model` does not prove a proxy alias bug. An absent observation does not prove a particular failure either: the process may not have started, may have been cancelled, or trace publication may have failed.

## Bounds and limitations

There are eight session buckets, each with 32 rotating minute slots: at most 256 trace JSON files. A bucket is selected from the session hash; a missing session ID uses bucket zero. Multiple observations in the same bucket and minute overwrite that slot; after 32 minutes it is reused. Sessions in different buckets no longer overwrite one another, but hash-bucket collisions and same-minute overwrites remain possible. This is a bounded sample, not a complete event log. Use timestamps and session pseudonyms when correlating samples. Ordinary trace JSON stays below 8 KiB; existing oversized, malformed, foreign or non-regular slot files are preserved rather than overwritten. Interrupted atomic publication can leave recovery artifacts, which are not automatically deleted by tracing.

Disable capture by removing `CAH_CONTEXT_TRACE_DIR` from the renderer environment. Existing observations remain until overwritten or explicitly removed; this feature does not automatically expire files. The regular transcript reader's scan limits and model/compaction protections remain unchanged.
