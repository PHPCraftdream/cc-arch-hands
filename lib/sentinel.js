export const SentinelModelCommand = '<!-- cah-model-command:v1 -->';
export const SentinelModelAgent = '<!-- cah-model-agent:v1 -->';
export const SentinelCodexAgent = '# cah-codex-agent:v1';
export const SentinelSkill = '<!-- cah-skill:v1 -->';
// Companion-bin files are JavaScript, so the sentinel is a line comment rather
// than an HTML comment. It rides as the second line (after the shebang) of every
// bin/lib file cah copies into ~/.claude/cah-bin/.
export const SentinelBin = '// cah-bin:v1';

export const LegacyModelCommand = '<!-- crush-model-command:v1 -->';
export const LegacyModelAgent = '<!-- crush-model-agent:v1 -->';

export const SetForModelCommand = {
  current: SentinelModelCommand,
  legacy: [LegacyModelCommand],
};

export const SetForModelAgent = {
  current: SentinelModelAgent,
  legacy: [LegacyModelAgent],
};

export const SetForCodexAgent = {
  current: SentinelCodexAgent,
  legacy: [],
};

export const SetForSkill = {
  current: SentinelSkill,
  legacy: [],
};

export const SetForBin = {
  current: SentinelBin,
  legacy: [],
};

export const Ownership = Object.freeze({
  missing: 'missing',
  mine: 'mine',
  legacy: 'legacy',
  foreign: 'foreign',
});

export function allForClass(set) {
  const out = [];
  if (set.current) out.push(set.current);
  out.push(...set.legacy);
  return out;
}

export function isOurs(content, set) {
  const s = typeof content === 'string' ? content : content.toString();
  return allForClass(set).some((marker) => s.includes(marker));
}

export function classifyContent(present, content, set) {
  if (!present) return Ownership.missing;
  const s = typeof content === 'string' ? content : content.toString();
  for (const marker of set.legacy) {
    if (s.includes(marker)) return Ownership.legacy;
  }
  if (set.current && s.includes(set.current)) return Ownership.mine;
  return Ownership.foreign;
}
