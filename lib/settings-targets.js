// settings-targets.js — which settings.json files a command with --global /
// --local / --cwd writes. Global = ~/.claude/settings.json plus every ccgp
// profile's settings.json (ccgp copies it into a profile only when it starts,
// so writing it here spares the restart); --local/--cwd = one project's file.

import { join } from 'node:path';
import { Scope } from './scope.js';
import { discoverCcgpProfiles } from './ccgp-profiles.js';

export function settingsTargets(values) {
  if (values.global && (values.local || values.cwd)) {
    throw new Error('--global cannot be combined with --local or --cwd');
  }
  if (values.local || values.cwd) {
    const scope = new Scope({ global: false, strict: values.local, cwd: values.cwd });
    return [{ label: 'project', settingsPath: join(scope.claudeRoot(), 'settings.json') }];
  }
  const scope = new Scope({ global: true });
  return [
    { label: 'global', settingsPath: join(scope.claudeRoot(), 'settings.json') },
    ...discoverCcgpProfiles().map((profile) => ({
      label: `ccgp profile ${profile.name}`, settingsPath: join(profile.dir, 'settings.json'),
    })),
  ];
}
