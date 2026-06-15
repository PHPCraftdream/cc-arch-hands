export const SentinelModelCommand = '<!-- cah-model-command:v1 -->';
export const SentinelModelAgent = '<!-- cah-model-agent:v1 -->';
export const SentinelSkill = '<!-- cah-skill:v1 -->';

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

export const SetForSkill = {
  current: SentinelSkill,
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
