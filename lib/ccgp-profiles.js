import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Scope } from './scope.js';
import { writeModelCommands, removeModelCommands } from './commands.js';
import { writeModelAgents, removeModelAgents } from './agents.js';
import { writeSkills, removeSkills } from './skills.js';

// ccgp (https://github.com/PHPCraftdream/cc-go-proxy) runs each profile with
// CLAUDE_CONFIG_DIR=<home>/claude/<name> and copies agents/commands/skills from
// ~/.claude into it, but only when the profile starts. A global install therefore
// writes the same classes into every profile at once, so a running profile needs
// no restart. ccgp's own copy stays compatible: it re-copies only when the source
// changed, never deletes files it did not copy, and prunes only what it copied.
const APP_DIR = 'cc-go-proxy';
const HOME_ENV = 'CCGP_HOME';
const LOCAL_HOME = '.ccgp';
// The copy manifest ccgp keeps in every profile dir it manages (and its legacy name).
const MIRROR_MANIFESTS = ['.ccgp-mirror.ktav', '.ccgp-mirror.json'];
export const CCGP_PROFILE_CLASSES = Object.freeze(['commands', 'agents', 'skills']);

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function isDirectory(path) {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function isFile(path) {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

// ccgp's default home is Go's os.UserConfigDir()/cc-go-proxy. It only counts
// when that config dir is under the current home dir, so a sandboxed HOME (tests)
// never reaches the real user's profiles.
function defaultHome(env, home, platform) {
  let config;
  if (platform === 'win32') config = env.APPDATA;
  else if (platform === 'darwin') config = join(home, 'Library', 'Application Support');
  else config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
  return config && inside(home, resolve(config)) ? join(config, APP_DIR) : null;
}

// Every profile dir ccgp manages: <home>/claude/<name> holding a copy manifest,
// for CCGP_HOME, ./.ccgp and the default home. Symlinked entries and the caller's
// own Claude dir are skipped; one dir reached twice is listed once.
export function discoverCcgpProfiles({
  env = process.env, home = homedir(), cwd = process.cwd(), platform = process.platform,
  exclude = join(home, '.claude'),
} = {}) {
  const key = (path) => (platform === 'win32' ? path.toLowerCase() : path);
  const real = (path) => { try { return key(realpathSync(path)); } catch { return null; } };
  const seen = new Set([real(exclude)].filter(Boolean));
  const homes = [
    env[HOME_ENV] ? resolve(cwd, env[HOME_ENV]) : null,
    isDirectory(join(cwd, LOCAL_HOME)) ? join(cwd, LOCAL_HOME) : null,
    defaultHome(env, home, platform),
  ].filter(Boolean);
  const profiles = [];
  for (const base of homes) {
    const root = join(base, 'claude');
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      if (!MIRROR_MANIFESTS.some((name) => isFile(join(dir, name)))) continue;
      const id = real(dir);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      profiles.push({ name: entry.name, dir });
    }
  }
  return profiles;
}

// Every Claude config dir a global command covers besides ~/.claude: the ccgp
// profiles, plus CLAUDE_CONFIG_DIR when Claude Code runs from another existing
// dir. That one counts only under the current home dir (a sandboxed HOME never
// reaches the real one) and when no other entry is the same dir. Each entry has
// a `label` for reports.
export function discoverClaudeDirs(options = {}) {
  const { env = process.env, home = homedir(), platform = process.platform } = options;
  const exclude = options.exclude ?? join(home, '.claude');
  const profiles = discoverCcgpProfiles({ ...options, exclude })
    .map((profile) => ({ ...profile, label: `ccgp profile ${profile.name}` }));
  const raw = env.CLAUDE_CONFIG_DIR;
  if (!raw || !isAbsolute(raw)) return profiles;
  const dir = resolve(raw);
  if (!inside(home, dir) || !isDirectory(dir)) return profiles;
  const key = (path) => {
    try { const real = realpathSync(path); return platform === 'win32' ? real.toLowerCase() : real; } catch { return null; }
  };
  const id = key(dir);
  if (!id || [exclude, ...profiles.map((profile) => profile.dir)].some((other) => key(other) === id)) return profiles;
  return [...profiles, { name: 'CLAUDE_CONFIG_DIR', dir, label: 'CLAUDE_CONFIG_DIR' }];
}

function runClass(action, cls, templates, scope, subset) {
  if (action === 'install') {
    if (cls === 'commands') return writeModelCommands(templates, scope);
    if (cls === 'agents') return writeModelAgents(templates, scope);
    return writeSkills(templates, scope, { subset });
  }
  if (cls === 'commands') return removeModelCommands(scope);
  if (cls === 'agents') return removeModelAgents(scope);
  return removeSkills(templates, scope, { subset });
}

// Repeats the selected commands/agents/skills phases of a global install or
// uninstall in every ccgp profile. Reports through the CLI's reportClass and
// returns true when any profile phase failed (the others still run).
export function syncCcgpProfiles(action, {
  templates, phases, skillsSubset = null, reportClass, discover = discoverClaudeDirs,
}) {
  const classes = CCGP_PROFILE_CLASSES.filter((cls) => phases.includes(cls));
  if (classes.length === 0) return false;
  const verb = action === 'install' ? 'wrote' : 'removed';
  let failed = false;
  for (const profile of discover()) {
    process.stdout.write(`${profile.label ?? `ccgp profile ${profile.name}`} (${profile.dir}):\n`);
    const scope = new Scope({ claudeDir: profile.dir });
    for (const cls of classes) {
      try {
        const r = runClass(action, cls, templates, scope, skillsSubset);
        const label = cls === 'skills' && skillsSubset ? `skills (subset: ${skillsSubset.join(', ')})` : cls;
        reportClass(label, verb, action === 'install' ? r.written : r.removed, r.skipped, r.pruned || 0,
          r.preserved, r.recovery, r.maintenance);
      } catch (e) {
        process.stderr.write(`cah ${action}: ${profile.label ?? `ccgp ${profile.name}`}: ${cls}: ${e.message}\n`);
        failed = true;
      }
    }
  }
  return failed;
}
