import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);

function read(name) {
  return readFileSync(new URL(name, ROOT), 'utf8');
}

describe('release and generated-doc contracts', () => {
  it('publish workflow requires tag, package, and CURRENT_VERSION to match', () => {
    const workflow = read('.github/workflows/publish.yml');
    assert.match(workflow, /PACKAGE_VERSION=.*package\.json/);
    assert.match(workflow, /CURRENT_VERSION=.*update-check\.js/);
    assert.match(workflow, /tag=\$VERSION package=\$PACKAGE_VERSION CURRENT_VERSION=\$CURRENT_VERSION/);
    assert.match(workflow, /npm publish .*--tag next/);
  });

  it('prerelease publication is never sent to latest', () => {
    const workflow = read('.github/workflows/publish.yml');
    assert.match(workflow, /if \[\[ "\$VERSION" == \*-\* \]\]/);
    assert.doesNotMatch(workflow, /npm publish[^\n]*--tag latest/);
  });

  it('ccheckpoint preflights staged state and synchronizes only after success', () => {
    const skill = read('templates/skills/ccheckpoint/SKILL.md');
    const shellBlocks = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
    assert.equal(shellBlocks.length, 1, 'preflight and temp commit must be one shell invocation');
    const protocol = shellBlocks[0];
    assert.match(protocol, /^\s*checkpoint_path="<absolute path to checkpoint>"/);
    assert.match(protocol, /git diff --cached --quiet -- "\$checkpoint_path"/);
    assert.match(protocol, /already has staged changes/);
    assert.ok(protocol.indexOf('checkpoint_path=') < protocol.indexOf('git diff --cached --quiet'));
    assert.ok(protocol.indexOf('git diff --cached --quiet') < protocol.indexOf('git_index_file="$(mktemp)"'));
    assert.match(protocol, /git_index_file="\$\(mktemp\)"[\s\S]*?rm -f "\$git_index_file"[\s\S]*?GIT_INDEX_FILE=.*git read-tree HEAD/);
    assert.match(protocol, /GIT_INDEX_FILE=.*git diff --cached --quiet --[\s\S]*?commit unchanged: checkpoint already matches HEAD/);
    assert.match(protocol, /GIT_INDEX_FILE=.*git commit -m[\s\S]*?if \[ "\$status" -ne 0 \][\s\S]*?exit "\$status"[\s\S]*?git reset --/);
    assert.match(protocol, /commit failed; real index preserved/);
    assert.match(protocol, /trap cleanup EXIT HUP INT TERM/);
    assert.match(protocol, /git reset -- "\$checkpoint_path"\s+status=\$\?\s+exit "\$status"/);
  });

  it('README describes no-effort Haiku and shared-bin uninstall explicitly', () => {
    const readme = read('README.md');
    assert.match(readme, /\/h\s+Haiku \(top\), no effort control/);
    assert.match(readme, /`\/h45`/);
    assert.match(readme, /uninstall --only bins.*shared bins globally/);
    assert.doesNotMatch(readme, /`\/hl`.*low effort/);
  });
});
