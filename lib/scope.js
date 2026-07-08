import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { statSync } from 'node:fs';

const CLAUDE_DIR = '.claude';
const CODEX_DIR = '.codex';
const COMMANDS_SUBDIR = 'commands';
const AGENTS_SUBDIR = 'agents';
const SKILLS_SUBDIR = 'skills';
const BIN_SUBDIR = 'cah-bin';
export const SKILL_MANIFEST_LEAF = 'SKILL.md';

export class StrictMissingRootError extends Error {
  constructor(path) {
    super(`.claude/ does not exist at the resolved working directory (refusing to create it under --local): ${path}`);
    this.name = 'StrictMissingRootError';
  }
}

export class Scope {
  constructor({ global = false, strict = false, cwd = '' } = {}) {
    this.global = global;
    this.strict = strict;
    this.cwd = cwd;
  }

  claudeRoot() {
    if (this.global) {
      return join(homedir(), CLAUDE_DIR);
    }
    const base = this.cwd || process.cwd();
    const root = join(resolve(base), CLAUDE_DIR);
    if (this.strict) {
      let info;
      try {
        info = statSync(root);
      } catch (e) {
        if (e.code === 'ENOENT') throw new StrictMissingRootError(root);
        throw e;
      }
      if (!info.isDirectory()) throw new StrictMissingRootError(root);
    }
    return root;
  }

  resolveCommandsDir() {
    return join(this.claudeRoot(), COMMANDS_SUBDIR);
  }

  resolveAgentsDir() {
    return join(this.claudeRoot(), AGENTS_SUBDIR);
  }

  codexRoot() {
    if (this.global) {
      return join(homedir(), CODEX_DIR);
    }
    const base = this.cwd || process.cwd();
    return join(resolve(base), CODEX_DIR);
  }

  resolveCodexAgentsDir() {
    return join(this.codexRoot(), AGENTS_SUBDIR);
  }

  resolveSkillsDir() {
    return join(this.claudeRoot(), SKILLS_SUBDIR);
  }

  // Companion bins ALWAYS live in the global ~/.claude/cah-bin/, regardless of
  // this scope's --local/--cwd settings. settings.json (global or project-local)
  // references this one absolute path, so /clock survives the package being
  // moved, relinked, or uninstalled. See lib/binstall.js.
  resolveBinDir() {
    return join(homedir(), CLAUDE_DIR, BIN_SUBDIR);
  }

  describe() {
    if (this.global) return 'global (~/.claude/, ~/.codex/)';
    const base = this.cwd || '.';
    if (this.strict) return `local-strict (${base}/.claude/, ${base}/.codex/, .claude must exist)`;
    return `local (${base}/.claude/, ${base}/.codex/)`;
  }
}
