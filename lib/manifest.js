export const AllModelCommands = [
  // Opus 4.7 — low medium high xhigh max
  { name: 'o47l', model: 'claude-opus-4-7', effort: 'low', display: 'Opus 4.7 (1M) – low' },
  { name: 'o47m', model: 'claude-opus-4-7', effort: 'medium', display: 'Opus 4.7 (1M) – medium' },
  { name: 'o47h', model: 'claude-opus-4-7', effort: 'high', display: 'Opus 4.7 (1M) – high' },
  { name: 'o47x', model: 'claude-opus-4-7', effort: 'xhigh', display: 'Opus 4.7 (1M) – xhigh' },
  { name: 'o47xx', model: 'claude-opus-4-7', effort: 'max', display: 'Opus 4.7 (1M) – max' },
  // Opus 4.6 — low medium high xhigh max
  { name: 'o46l', model: 'claude-opus-4-6', effort: 'low', display: 'Opus 4.6 (1M) – low' },
  { name: 'o46m', model: 'claude-opus-4-6', effort: 'medium', display: 'Opus 4.6 (1M) – medium' },
  { name: 'o46h', model: 'claude-opus-4-6', effort: 'high', display: 'Opus 4.6 (1M) – high' },
  { name: 'o46x', model: 'claude-opus-4-6', effort: 'xhigh', display: 'Opus 4.6 (1M) – xhigh' },
  { name: 'o46xx', model: 'claude-opus-4-6', effort: 'max', display: 'Opus 4.6 (1M) – max' },
  // Sonnet 4.6 — low medium high max (no xhigh)
  { name: 's46l', model: 'claude-sonnet-4-6', effort: 'low', display: 'Sonnet 4.6 (200k) – low' },
  { name: 's46m', model: 'claude-sonnet-4-6', effort: 'medium', display: 'Sonnet 4.6 (200k) – medium' },
  { name: 's46h', model: 'claude-sonnet-4-6', effort: 'high', display: 'Sonnet 4.6 (200k) – high' },
  { name: 's46xx', model: 'claude-sonnet-4-6', effort: 'max', display: 'Sonnet 4.6 (200k) – max' },
  // Sonnet 4.5 — low medium high
  { name: 's45l', model: 'claude-sonnet-4-5', effort: 'low', display: 'Sonnet 4.5 (200k) – low' },
  { name: 's45m', model: 'claude-sonnet-4-5', effort: 'medium', display: 'Sonnet 4.5 (200k) – medium' },
  { name: 's45h', model: 'claude-sonnet-4-5', effort: 'high', display: 'Sonnet 4.5 (200k) – high' },
  // Haiku 4.5 — low medium high
  { name: 'h45l', model: 'claude-haiku-4-5', effort: 'low', display: 'Haiku 4.5 (200k) – low' },
  { name: 'h45m', model: 'claude-haiku-4-5', effort: 'medium', display: 'Haiku 4.5 (200k) – medium' },
  { name: 'h45h', model: 'claude-haiku-4-5', effort: 'high', display: 'Haiku 4.5 (200k) – high' },
  // Top-model shortcuts — point at the freshest version of each family.
  { name: 'ol', model: 'claude-opus-4-8', effort: 'low', display: 'Opus (top, 1M) – low' },
  { name: 'om', model: 'claude-opus-4-8', effort: 'medium', display: 'Opus (top, 1M) – medium' },
  { name: 'oh', model: 'claude-opus-4-8', effort: 'high', display: 'Opus (top, 1M) – high' },
  { name: 'ox', model: 'claude-opus-4-8', effort: 'xhigh', display: 'Opus (top, 1M) – xhigh' },
  { name: 'oxx', model: 'claude-opus-4-8', effort: 'max', display: 'Opus (top, 1M) – max' },
  { name: 'sl', model: 'claude-sonnet-4-6', effort: 'low', display: 'Sonnet (top, 200k) – low' },
  { name: 'sm', model: 'claude-sonnet-4-6', effort: 'medium', display: 'Sonnet (top, 200k) – medium' },
  { name: 'sh', model: 'claude-sonnet-4-6', effort: 'high', display: 'Sonnet (top, 200k) – high' },
  { name: 'sx', model: 'claude-sonnet-4-6', effort: 'max', display: 'Sonnet (top, 200k) – max' },
  { name: 'hl', model: 'claude-haiku-4-5', effort: 'low', display: 'Haiku (top, 200k) – low' },
  { name: 'hm', model: 'claude-haiku-4-5', effort: 'medium', display: 'Haiku (top, 200k) – medium' },
  { name: 'hh', model: 'claude-haiku-4-5', effort: 'high', display: 'Haiku (top, 200k) – high' },
  // Fable 5 — top-model shortcuts, 1M context like opus.
  { name: 'fl', model: 'claude-fable-5', effort: 'low', display: 'Fable (top, 1M) – low' },
  { name: 'fm', model: 'claude-fable-5', effort: 'medium', display: 'Fable (top, 1M) – medium' },
  { name: 'fh', model: 'claude-fable-5', effort: 'high', display: 'Fable (top, 1M) – high' },
  { name: 'fx', model: 'claude-fable-5', effort: 'xhigh', display: 'Fable (top, 1M) – xhigh' },
  { name: 'fxx', model: 'claude-fable-5', effort: 'max', display: 'Fable (top, 1M) – max' },
];

export let AllSkills = ['repo-sight'];
