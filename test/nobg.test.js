import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DENY_AMPERSAND, decide, detachedWord, findDetached } from '../bin/cah-nobg.js';
import { HookSettingsError } from '../lib/sentinel-hooks.js';
import { nobgHooks, readNobgState, updateNobg } from '../lib/nobg.js';
import { DEFAULT_CLI_TIMEOUT_MS } from '../test-support/process-batches.js';

const bin = fileURLToPath(new URL('../bin/cah-nobg.js', import.meta.url));
const cli = fileURLToPath(new URL('../bin/cah.js', import.meta.url));

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cah-nobg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('cah-nobg: what it denies', () => {
  const denied = [
    ['a trailing &', 'npm run dev &'],
    ['& between commands', 'sleep 5 & echo started'],
    ['& before a newline', 'server --port 80 &\necho ok'],
    ['a backgrounded group', '( cd app; ./run ) &'],
    ['a backgrounded brace group', '{ a; b; } &'],
    ['a redirect then &', 'server > log 2>&1 &'],
    ['&> then &', 'server &>/dev/null &'],
    ['an unquoted URL with &', 'curl http://x/?a=1&b=2'],
    ['nohup', 'nohup ./run.sh > out.log'],
    ['nohup behind sudo and env', 'sudo -E env FOO=1 nohup ./run.sh'],
    ['nohup behind timeout', 'timeout 30 nohup ./run.sh'],
    ['a variable then setsid', 'FOO=1 setsid ./run.sh'],
    ['setsid after &&', 'cd app && setsid ./run.sh'],
    ['nohup in an if body', 'if true; then nohup ./run.sh; fi'],
    ['disown', 'long_task; disown'],
    ['coproc', 'coproc worker { ./run.sh; }'],
    ['screen -dm', 'screen -dmS job ./run.sh'],
    ['tmux new -d', 'tmux new-session -d -s job ./run.sh'],
    ['& inside $( )', 'echo $(sleep 5 &)'],
    ['& inside a backtick substitution', 'echo `sleep 5 &`'],
    ['& inside a double-quoted substitution', 'echo "pid: $(sleep 5 & echo $!)"'],
    ['& inside bash -c', "bash -c 'server &'"],
    ['& inside sh -c with flags', 'sh -ec "server &"'],
    ['nohup inside bash -c', "bash -lc 'nohup ./run.sh'"],
    ['bash -c behind a wrapper', "sudo docker exec c sh -c 'server &'"],
    ['& inside eval', 'eval "server &"'],
    ['nested -c', `bash -c "sh -c 'server &'"`],
    ['& after a wait that came first', 'wait; server &'],
  ];
  for (const [name, command] of denied) {
    it(`denies ${name}`, () => {
      assert.ok(findDetached(command), command);
    });
  }

  it('names the reason: the & or the word', () => {
    assert.equal(findDetached('a &'), DENY_AMPERSAND);
    assert.equal(findDetached('nohup a'), detachedWord('nohup'));
    assert.equal(findDetached('screen -dm x'), detachedWord('screen -dm'));
  });
});

describe('cah-nobg: what it leaves alone', () => {
  const allowed = [
    ['plain commands', 'npm test && npm run build || echo failed'],
    ['&&', 'a && b && c'],
    ['2>&1', 'make 2>&1 | tee build.log'],
    ['>&2', 'echo oops >&2'],
    ['&>file', 'make &>build.log'],
    ['|&', 'make |& tee build.log'],
    ['<&', 'cat <&3'],
    ['& in single quotes', "echo 'a & b'"],
    ['& in double quotes', 'echo "a & b" "https://x/?a=1&b=2"'],
    ['an escaped &', 'echo a \\& b'],
    ['& in a comment', 'echo hi # run it with &'],
    ['& in a heredoc body', 'cat <<EOF\nserver &\nEOF\necho done'],
    ['& in a quoted heredoc body', "cat <<'EOF' > f.sh\nnohup x &\nEOF"],
    ['& in arithmetic', 'echo $((a & b))'],
    ['jobs reaped by wait', 'a & b & wait'],
    ['jobs reaped by wait on a new line', 'a &\nb &\nwait'],
    ['the word nohup as an argument', 'grep nohup notes.txt'],
    ['command -v nohup', 'command -v nohup'],
    ['the word setsid in an echo', 'echo setsid'],
    ['bash -c without detaching', "bash -c 'npm test && npm run build'"],
    ['a quoted & that is not code', "git commit -m 'fix a & b'"],
    ['screen without -d', 'screen -ls'],
    ['an empty command', ''],
  ];
  for (const [name, command] of allowed) {
    it(`allows ${name}`, () => {
      assert.equal(findDetached(command), null, command);
    });
  }

  it('stops recursing at a fixed depth instead of looping', () => {
    let command = 'echo x';
    for (let i = 0; i < 12; i++) command = `bash -c ${JSON.stringify(command)}`;
    assert.doesNotThrow(() => findDetached(command));
  });
});

describe('cah-nobg: the hook', () => {
  const payload = (command, tool = 'Bash') => ({ tool_name: tool, tool_input: { command } });

  it('answers a PreToolUse deny with the reason', () => {
    const out = decide(payload('server &'));
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /run_in_background/);
  });

  it('ignores other tools, a missing command and a clean command', () => {
    assert.equal(decide(payload('server &', 'Edit')), null);
    assert.equal(decide({ tool_name: 'Bash', tool_input: {} }), null);
    assert.equal(decide(payload('npm test')), null);
    assert.equal(decide(null), null);
  });

  it('as a process: prints the deny on stdout, stays silent otherwise, fails open on junk', () => {
    const run = (input) => spawnSync(process.execPath, [bin], { input, encoding: 'utf8' });
    const denied = run(JSON.stringify(payload('server &')));
    assert.equal(denied.status, 0);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const clean = run(JSON.stringify(payload('ls')));
    assert.equal(clean.status, 0);
    assert.equal(clean.stdout, '');
    const junk = run('not json');
    assert.equal(junk.status, 0);
    assert.equal(junk.stdout, '');
  });
});

describe('nobg settings wiring', () => {
  const BIN = 'C:/Users/me/.claude/cah-bin/bin/cah-nobg.js';

  it('adds one Bash PreToolUse hook, keeps foreign ones, and removes only its own', (t) => {
    const dir = sandbox(t);
    const path = join(dir, 'settings.json');
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
    writeFileSync(path, JSON.stringify({ model: 'x', hooks: { PreToolUse: [foreign] } }, null, 2) + '\n');

    assert.equal(updateNobg(path, 'enable', { binPath: BIN }), 'enabled');
    assert.equal(updateNobg(path, 'enable', { binPath: BIN }), 'already-enabled');
    assert.equal(readNobgState(path, BIN), 'enabled');
    const on = JSON.parse(readFileSync(path, 'utf8'));
    const wanted = nobgHooks(BIN);
    assert.deepEqual(on.hooks.PreToolUse, [foreign, wanted.PreToolUse]);
    assert.equal(on.hooks.PreToolUse[1].matcher, 'Bash');
    assert.equal(on.hooks.PreToolUse[1].hooks[0].command, `node "${BIN}"`);
    assert.equal(on.hooks.PreToolUse[1].hooks[0].async, undefined, 'a blocking hook must not be async');

    assert.equal(updateNobg(path, 'enable', { binPath: 'D:/other/cah-nobg.js' }), 'updated');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).hooks.PreToolUse.length, 2);

    assert.equal(updateNobg(path, 'disable'), 'disabled');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { model: 'x', hooks: { PreToolUse: [foreign] } });
    assert.equal(updateNobg(path, 'disable'), 'not-enabled');
    assert.equal(readNobgState(path, BIN), 'disabled');
  });

  it('creates a missing file and refuses invalid JSON or an unsafe bin path', (t) => {
    const dir = sandbox(t);
    const fresh = join(dir, 'new', 'settings.json');
    assert.equal(updateNobg(fresh, 'disable'), 'not-enabled');
    assert.equal(existsSync(fresh), false);
    assert.equal(updateNobg(fresh, 'enable', { binPath: BIN }), 'enabled');

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ nope');
    assert.throws(() => updateNobg(broken, 'enable', { binPath: BIN }), HookSettingsError);
    assert.equal(readFileSync(broken, 'utf8'), '{ nope');
    assert.throws(() => nobgHooks('C:/Users/$me/cah-nobg.js'), HookSettingsError);
  });
});

describe('cah nobg', () => {
  function run(home, ccgp, ...args) {
    return spawnSync(process.execPath, [cli, 'nobg', ...args], {
      cwd: home, encoding: 'utf8', timeout: DEFAULT_CLI_TIMEOUT_MS,
      env: { ...process.env, HOME: home, USERPROFILE: home, CCGP_HOME: ccgp },
    });
  }

  it('global scope covers ~/.claude and every ccgp profile; --cwd only the project', (t) => {
    const dir = sandbox(t);
    const home = join(dir, 'home');
    const ccgp = join(dir, 'ccgp');
    const profile = join(ccgp, 'claude', 'work');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, '.ccgp-mirror.ktav'), 'files: []\n');
    const project = join(dir, 'project');
    mkdirSync(join(project, '.claude'), { recursive: true });

    mkdirSync(home);
    const missing = run(home, ccgp, 'on');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /cah install --only bins/);

    const binPath = join(home, '.claude', 'cah-bin', 'bin', 'cah-nobg.js');
    mkdirSync(join(binPath, '..'), { recursive: true });
    writeFileSync(binPath, '// placeholder\n');

    const on = run(home, ccgp, 'on');
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /^global \(.*\): enabled$/m);
    assert.match(on.stdout, /^ccgp profile work \(.*\): enabled$/m);
    assert.equal(readNobgState(join(home, '.claude', 'settings.json'), binPath), 'enabled');
    assert.equal(readNobgState(join(profile, 'settings.json'), binPath), 'enabled');

    const local = run(home, ccgp, 'on', '--cwd', project);
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /^project \(.*\): enabled$/m);
    assert.doesNotMatch(local.stdout, /ccgp profile/);

    const status = run(home, ccgp, 'status');
    assert.match(status.stdout, /^global \(.*\): enabled$/m);

    const off = run(home, ccgp, 'off');
    assert.equal(off.status, 0, off.stderr);
    assert.equal(readNobgState(join(profile, 'settings.json'), binPath), 'disabled');
    assert.equal(readNobgState(join(project, '.claude', 'settings.json'), binPath), 'enabled');

    assert.equal(run(home, ccgp, 'sideways').status, 2);
    assert.equal(run(home, ccgp, 'on', '--global', '--local').status, 2);
  });
});
