import { AllCodexSkills } from './manifest.js';
import { writeSkills, removeSkills } from './skills.js';

function codexOptions(scope) {
  return {
    root: scope.resolveCodexSkillsDir(),
    catalog: AllCodexSkills,
    templateKind: 'codex-skills',
  };
}

export function writeCodexSkills(templates, scope, options = {}) {
  return writeSkills(templates, scope, { ...options, ...codexOptions(scope) });
}

export function removeCodexSkills(templates, scope, options = {}) {
  return removeSkills(templates, scope, { ...options, ...codexOptions(scope) });
}
