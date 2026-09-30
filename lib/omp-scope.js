import { homedir } from 'node:os';
import { join } from 'node:path';
import { AllCodexAgents } from './manifest.js';

export const OmpAgents = AllCodexAgents;
export const SentinelOmpAgent = '<!-- cah-omp-agent:v1 -->';
export const SetForOmpAgent = { current: SentinelOmpAgent, legacy: [] };

export class OmpScope {
  constructor(profile = '') {
    if (profile && (!/^[a-zA-Z0-9_-]+$/.test(profile)
        || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(profile))) {
      throw new Error('Invalid --omp-profile name: use letters, digits, hyphens or underscores, not a reserved device name');
    }
    this.profile = profile === 'default' ? '' : profile;
  }

  agentRoot() {
    const root = join(homedir(), '.omp');
    return this.profile ? join(root, 'profiles', this.profile, 'agent') : join(root, 'agent');
  }

  resolveAgentsDir() {
    return join(this.agentRoot(), 'agents');
  }
}
