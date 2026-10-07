import { join } from 'node:path';
import { OpencodeWorkflows, OpencodeSkillDeps } from './manifest.js';
import { writeSkills, removeSkills } from './skills.js';

export const OpencodeSkills = OpencodeWorkflows;
export { OpencodeSkillDeps };
function opencodeOptions(scope) {
  return {
    root: scope.resolveSkillsDir(),
    catalog: OpencodeSkills,
    templateKind: 'opencode-skills',
  };
}

// The ccheckpoint SKILL.md ships the same {{COMMIT_HELPER}} placeholder as the
// command template. Substitute scope-specific absolute helper paths in the
// template bytes (adapter-level wrapper) while preserving templates.root and
// all validation semantics, so --templates keeps working unchanged.
function prepareTemplates(templates, scope) {
  const helper = JSON.stringify(join(scope.resolveRuntimeDir(), 'commit-checkpoint.mjs').replaceAll('\\', '/'));
  const substitute = (bytes) => {
    const text = bytes.toString('utf8');
    if (!text.includes('{{COMMIT_HELPER}}')) return bytes;
    return Buffer.from(text.replaceAll('{{COMMIT_HELPER}}', helper), 'utf8');
  };
  return {
    root: templates.root,
    label: templates.label,
    skillTree(name, kind) {
      return templates.skillTree(name, kind).map((file) => ({
        ...file,
        bytes: kind === 'opencode-skills' ? substitute(file.bytes) : file.bytes,
      }));
    },
  };
}

export function writeOpencodeSkills(templates, scope, options = {}) {
  return writeSkills(prepareTemplates(templates, scope), scope,
    { ...options, ...opencodeOptions(scope) });
}

export function removeOpencodeSkills(templates, scope, options = {}) {
  return removeSkills(prepareTemplates(templates, scope), scope,
    { ...options, ...opencodeOptions(scope) });
}
