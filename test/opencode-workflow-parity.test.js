import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpencodeWorkflows } from '../lib/manifest.js';
import { BABYSIT_TICK_PROMPT } from '../templates/opencode-runtime/scheduler/cah-babysit-scheduler.js';

const templates = fileURLToPath(new URL('../templates', import.meta.url));
const ARGUMENTS_LINE = 'Arguments: $ARGUMENTS';
const SKILL_ARGUMENTS_LINE = "Arguments: take them from the user's request that triggered this skill.";

function split(path) {
  const match = readFileSync(path, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match, `${path}: YAML frontmatter`);
  return { frontmatter: match[1], body: match[2] };
}

// Each workflow ships as a slash command and as a skill from two template
// trees; the bodies must stay one text so the two never drift apart.
describe('OpenCode workflow command/skill parity', () => {
  for (const name of OpencodeWorkflows) {
    it(`${name}: the skill body is the command body without the templated arguments line`, () => {
      const command = split(join(templates, 'opencode-commands', name, 'command.md'));
      const skill = split(join(templates, 'opencode-skills', name, 'SKILL.md'));
      assert.ok(command.body.includes(ARGUMENTS_LINE), 'commands keep $ARGUMENTS substitution');
      assert.equal(skill.body, command.body.replace(ARGUMENTS_LINE, SKILL_ARGUMENTS_LINE));
      assert.ok(!skill.body.includes('$ARGUMENTS'), 'skills are not templated: no literal $ARGUMENTS');
      assert.match(skill.frontmatter, new RegExp(`^name: ${name}$`, 'm'));
      assert.match(command.frontmatter, /^description: \S/m);
    });
  }

  it('no template tells the model to call the nonexistent todoread tool', () => {
    assert.doesNotMatch(BABYSIT_TICK_PROMPT, /todoread/);
    assert.match(BABYSIT_TICK_PROMPT, /cah_todos/);
  });
});
