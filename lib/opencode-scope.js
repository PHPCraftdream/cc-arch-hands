import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

export class StrictMissingOpencodeRootError extends Error {
  constructor(path) {
    super(`.opencode/ does not exist at the resolved working directory (refusing to create it under --local): ${path}`);
    this.name = 'StrictMissingOpencodeRootError';
  }
}

const OPENCODE_DIR = '.opencode';
export const OPENCODE_RUNTIME_SUBDIR = 'cah-opencode';

export class OpenCodeScope {
  constructor({ global = false, strict = false, cwd = '', env = process.env } = {}) {
    this.global = global;
    this.strict = strict;
    this.cwd = cwd;
    this.env = env;
  }

  projectRoot() {
    return resolve(this.cwd || process.cwd());
  }

  // OPENCODE_CONFIG_DIR overrides everything; otherwise $XDG_CONFIG_HOME/opencode
  // else ~/.config/opencode.
  configRoot() {
    const override = this.env.OPENCODE_CONFIG_DIR;
    if (override) return resolve(override);
    // xdg-basedir semantics: only an absolute XDG_CONFIG_HOME is honored; a
    // relative value is ignored and falls through to the default.
    const xdg = this.env.XDG_CONFIG_HOME;
    if (xdg && isAbsolute(xdg)) return join(resolve(xdg), 'opencode');
    return join(homedir(), '.config', 'opencode');
  }

  configRootSource() {
    if (this.env.OPENCODE_CONFIG_DIR) return 'OPENCODE_CONFIG_DIR';
    if (this.env.XDG_CONFIG_HOME && isAbsolute(this.env.XDG_CONFIG_HOME)) return 'XDG_CONFIG_HOME';
    return 'default';
  }

  opencodeRoot() {
    if (this.global) return this.configRoot();
    const root = join(this.projectRoot(), OPENCODE_DIR);
    if (this.strict) {
      let info;
      try {
        info = statSync(root);
      } catch (e) {
        if (e.code === 'ENOENT') throw new StrictMissingOpencodeRootError(root);
        throw e;
      }
      if (!info.isDirectory()) throw new StrictMissingOpencodeRootError(root);
    }
    return root;
  }

  resolveAgentsDir() {
    return join(this.opencodeRoot(), 'agents');
  }

  resolveCommandsDir() {
    return join(this.opencodeRoot(), 'commands');
  }

  resolveSkillsDir() {
    return join(this.opencodeRoot(), 'skills');
  }

  resolvePluginDir() {
    return join(this.opencodeRoot(), 'plugin');
  }

  // OpenCode v1.18.34 scans both {plugin,plugins}/*.{js,ts}; cah publishes to
  // the plural directory consistently.
  resolvePluginsDir() {
    return join(this.opencodeRoot(), 'plugins');
  }

  resolveRuntimeDir() {
    return join(this.opencodeRoot(), OPENCODE_RUNTIME_SUBDIR);
  }

  // Global rules live at <config root>/AGENTS.md. A project-local
  // .opencode/AGENTS.md is NOT auto-global in OpenCode, so a local install
  // manages the project-root AGENTS.md instead.
  instructionsPath() {
    return this.global
      ? join(this.opencodeRoot(), 'AGENTS.md')
      : join(this.projectRoot(), 'AGENTS.md');
  }

  describe() {
    if (this.global) {
      return `global (${this.configRoot()}, via ${this.configRootSource()})`;
    }
    const base = this.cwd || '.';
    if (this.strict) return `local-strict (${base}/.opencode/, .opencode must exist)`;
    return `local (${base}/.opencode/)`;
  }
}
