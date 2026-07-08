export const AllModelCommands = [
  // Fable 5 — top-tier, 1M context.
  { name: 'fl', model: 'claude-fable-5', effort: 'low', display: 'Fable (top, 1M) – low' },
  { name: 'fm', model: 'claude-fable-5', effort: 'medium', display: 'Fable (top, 1M) – medium' },
  { name: 'fh', model: 'claude-fable-5', effort: 'high', display: 'Fable (top, 1M) – high' },
  { name: 'fx', model: 'claude-fable-5', effort: 'xhigh', display: 'Fable (top, 1M) – xhigh' },
  { name: 'fxx', model: 'claude-fable-5', effort: 'max', display: 'Fable (top, 1M) – max' },
  // Opus (top) — claude-opus-4-8, freshest opus family.
  { name: 'ol', model: 'claude-opus-4-8', effort: 'low', display: 'Opus (top, 1M) – low' },
  { name: 'om', model: 'claude-opus-4-8', effort: 'medium', display: 'Opus (top, 1M) – medium' },
  { name: 'oh', model: 'claude-opus-4-8', effort: 'high', display: 'Opus (top, 1M) – high' },
  { name: 'ox', model: 'claude-opus-4-8', effort: 'xhigh', display: 'Opus (top, 1M) – xhigh' },
  { name: 'oxx', model: 'claude-opus-4-8', effort: 'max', display: 'Opus (top, 1M) – max' },
  // Opus 4.7 — low medium high xhigh max
  { name: 'o47l', model: 'claude-opus-4-7', effort: 'low', display: 'Opus 4.7 (1M) – low' },
  { name: 'o47m', model: 'claude-opus-4-7', effort: 'medium', display: 'Opus 4.7 (1M) – medium' },
  { name: 'o47h', model: 'claude-opus-4-7', effort: 'high', display: 'Opus 4.7 (1M) – high' },
  { name: 'o47x', model: 'claude-opus-4-7', effort: 'xhigh', display: 'Opus 4.7 (1M) – xhigh' },
  { name: 'o47xx', model: 'claude-opus-4-7', effort: 'max', display: 'Opus 4.7 (1M) – max' },
  // Opus 4.6 — low medium high xhigh max
  { name: 'o4l', model: 'claude-opus-4-6', effort: 'low', display: 'Opus 4.6 (1M) – low' },
  { name: 'o4m', model: 'claude-opus-4-6', effort: 'medium', display: 'Opus 4.6 (1M) – medium' },
  { name: 'o4h', model: 'claude-opus-4-6', effort: 'high', display: 'Opus 4.6 (1M) – high' },
  { name: 'o4x', model: 'claude-opus-4-6', effort: 'xhigh', display: 'Opus 4.6 (1M) – xhigh' },
  { name: 'o4xx', model: 'claude-opus-4-6', effort: 'max', display: 'Opus 4.6 (1M) – max' },
  // Sonnet (top) — claude-sonnet-5, full five-level effort scale, 1M context.
  { name: 'sl', model: 'claude-sonnet-5', effort: 'low', display: 'Sonnet (top, 1M) – low' },
  { name: 'sm', model: 'claude-sonnet-5', effort: 'medium', display: 'Sonnet (top, 1M) – medium' },
  { name: 'sh', model: 'claude-sonnet-5', effort: 'high', display: 'Sonnet (top, 1M) – high' },
  { name: 'sx', model: 'claude-sonnet-5', effort: 'xhigh', display: 'Sonnet (top, 1M) – xhigh' },
  { name: 'sxx', model: 'claude-sonnet-5', effort: 'max', display: 'Sonnet (top, 1M) – max' },
  // Sonnet 4.6 — low medium high max (skips xhigh: Sonnet 4.6 jumps straight
  // from high to max in Claude Code's effort scale).
  { name: 's4l', model: 'claude-sonnet-4-6', effort: 'low', display: 'Sonnet 4.6 (200k) – low' },
  { name: 's4m', model: 'claude-sonnet-4-6', effort: 'medium', display: 'Sonnet 4.6 (200k) – medium' },
  { name: 's4h', model: 'claude-sonnet-4-6', effort: 'high', display: 'Sonnet 4.6 (200k) – high' },
  { name: 's4xx', model: 'claude-sonnet-4-6', effort: 'max', display: 'Sonnet 4.6 (200k) – max' },
  // Sonnet 4.5 — low medium high
  { name: 's45l', model: 'claude-sonnet-4-5', effort: 'low', display: 'Sonnet 4.5 (200k) – low' },
  { name: 's45m', model: 'claude-sonnet-4-5', effort: 'medium', display: 'Sonnet 4.5 (200k) – medium' },
  { name: 's45h', model: 'claude-sonnet-4-5', effort: 'high', display: 'Sonnet 4.5 (200k) – high' },
  // Haiku (top) — claude-haiku-4-5, low medium high.
  { name: 'hl', model: 'claude-haiku-4-5', effort: 'low', display: 'Haiku (top, 200k) – low' },
  { name: 'hm', model: 'claude-haiku-4-5', effort: 'medium', display: 'Haiku (top, 200k) – medium' },
  { name: 'hh', model: 'claude-haiku-4-5', effort: 'high', display: 'Haiku (top, 200k) – high' },
  // Haiku 4.5 — low medium high
  { name: 'h45l', model: 'claude-haiku-4-5', effort: 'low', display: 'Haiku 4.5 (200k) – low' },
  { name: 'h45m', model: 'claude-haiku-4-5', effort: 'medium', display: 'Haiku 4.5 (200k) – medium' },
  { name: 'h45h', model: 'claude-haiku-4-5', effort: 'high', display: 'Haiku 4.5 (200k) – high' },
];

export const AllCodexAgents = [
  { name: 'l55', model: 'gpt-5.5', effort: 'low', display: 'GPT-5.5 - low' },
  { name: 'm55', model: 'gpt-5.5', effort: 'medium', display: 'GPT-5.5 - medium' },
  { name: 'h55', model: 'gpt-5.5', effort: 'high', display: 'GPT-5.5 - high' },
  { name: 'x55', model: 'gpt-5.5', effort: 'xhigh', display: 'GPT-5.5 - xhigh' },
  { name: 'l54', model: 'gpt-5.4', effort: 'low', display: 'GPT-5.4 - low' },
  { name: 'm54', model: 'gpt-5.4', effort: 'medium', display: 'GPT-5.4 - medium' },
  { name: 'h54', model: 'gpt-5.4', effort: 'high', display: 'GPT-5.4 - high' },
  { name: 'x54', model: 'gpt-5.4', effort: 'xhigh', display: 'GPT-5.4 - xhigh' },
  { name: 'l54m', model: 'gpt-5.4-mini', effort: 'low', display: 'GPT-5.4 mini - low' },
  { name: 'm54m', model: 'gpt-5.4-mini', effort: 'medium', display: 'GPT-5.4 mini - medium' },
  { name: 'h54m', model: 'gpt-5.4-mini', effort: 'high', display: 'GPT-5.4 mini - high' },
  { name: 'x54m', model: 'gpt-5.4-mini', effort: 'xhigh', display: 'GPT-5.4 mini - xhigh' },
];

export let AllSkills = ['repo-sight', 'babysit', 'babygoal', 'task', 'checkpoint', 'checkpoint-prune', 'resume', 'triage', 'checkpoint-watch', 'clock'];

// Dependencies between skills and install classes. When a user installs a
// specific skill by name (e.g. `--only clock`), cli.js auto-includes any
// classes listed here and prints a notice so the dependency is transparent.
// Keys must be names from AllSkills; values are subsets of VALID_CLASSES.
export const SkillDeps = Object.freeze({
  clock: Object.freeze(['bins']),
  'checkpoint-watch': Object.freeze(['bins']),
});
