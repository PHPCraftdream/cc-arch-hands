import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DENY_AMPERSAND, decide, detachedWord, findDetached } from '../bin/cah-nobg.js';
import { SettingsFileError } from '../lib/settings-file.js';
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
    ['nohup', 'nohup ./run.sh > out.log', 'nohup'],
    ['nohup behind sudo and env', 'sudo -E env FOO=1 nohup ./run.sh', 'nohup'],
    ['nohup behind timeout', 'timeout 30 nohup ./run.sh', 'nohup'],
    ['a variable then setsid', 'FOO=1 setsid ./run.sh', 'setsid'],
    ['setsid after &&', 'cd app && setsid ./run.sh', 'setsid'],
    ['nohup in an if body', 'if true; then nohup ./run.sh; fi', 'nohup'],
    ['disown', 'long_task; disown', 'disown'],
    ['coproc', 'coproc worker { ./run.sh; }', 'coproc'],
    ['screen -dm', 'screen -dmS job ./run.sh', 'screen -dmS'],
    ['tmux new -d', 'tmux new-session -d -s job ./run.sh', 'tmux new-session -d'],
    ['& inside $( )', 'echo $(sleep 5 &)'],
    ['& inside a backtick substitution', 'echo `sleep 5 &`'],
    ['& inside a double-quoted substitution', 'echo "pid: $(sleep 5 & echo $!)"'],
    ['& inside bash -c', "bash -c 'server &'"],
    ['& inside sh -c with flags', 'sh -ec "server &"'],
    ['nohup inside bash -c', "bash -lc 'nohup ./run.sh'", 'nohup'],
    ['bash -c behind a wrapper', "sudo docker exec c sh -c 'server &'"],
    ['& inside eval', 'eval "server &"'],
    ['nested -c', `bash -c "sh -c 'server &'"`],
    ['& after a wait that came first', 'wait; server &'],
    ['a quoted shell path with -c', '"C:/Program Files/Git/bin/bash.exe" -c "server &"'],
    ['bash.exe -c', 'bash.exe -c "server &"'],
    ['a quoted nohup', '"nohup" ./run.sh', 'nohup'],
    ['an escaped nohup', '\\nohup ./run.sh', 'nohup'],
    ['nohup behind sudo -u user', 'sudo -u www nohup ./run.sh', 'nohup'],
    ['nohup behind env -u VAR', 'env -u X nohup ./run.sh', 'nohup'],
    ['nohup behind timeout -s SIG N', 'timeout -s KILL 30 nohup ./run.sh', 'nohup'],
    ['nohup behind nice -n N', 'nice -n 5 nohup ./run.sh', 'nohup'],
    ['nohup behind command', 'command nohup ./run.sh', 'nohup'],
    ['nohup behind xargs', 'ls | xargs -n 1 nohup ./run.sh', 'nohup'],
    ['env -S with a detaching string', "env -S 'server &'"],
    ['a heredoc fed to bash', 'bash <<EOF\nserver &\nEOF'],
    ['a quoted heredoc fed to sh -s', "sh -s <<'EOF'\nnohup server\nEOF", 'nohup'],
    ['Windows start', 'start "" server.exe', 'start'],
    ['cmd /c start', 'cmd //c start /b server.exe', 'cmd /c start'],
    ['PowerShell Start-Process', 'powershell -Command "Start-Process server.exe"', 'Start-Process'],
    ['pwsh Start-Job', 'pwsh -c Start-Job { ./run.ps1 }', 'Start-Job'],
    ['at', 'echo ./run.sh | at now', 'at'],
    ['tmux behind a socket option', 'tmux -L work new -d ./run.sh', 'tmux new -d'],
    ['screen -d -m as two flags', 'screen -d -m ./run.sh', 'screen -m'],
    ['wait only in a comment', 'server & echo ok # ; wait'],
    ['wait only in quotes', "server & echo '; wait '"],
    ['a job of a subshell that ended before the wait', '(server &); wait'],
    ['a background job in a function', 'f() { server & }; f'],
    ['2>&1 then &', 'make 2>&1 &'],
    ['& after arithmetic', '(( y = x << 2 ))\nserver &'],
    ['a case pattern does not hide a command in its body', 'case $x in start) nohup run;; esac', 'nohup'],
    ['sudo with combined options', 'sudo -Eu www nohup ./run.sh', 'nohup'],
    ['find -exec sh -c', "find . -name '*.sh' -exec sh -c 'server &' ;"],
    ['a heredoc piped to bash', "cat <<'EOF' | bash\nserver &\nEOF"],
    ['flock running a shell', "flock /tmp/l sh -c 'server &'"],
    ['a heredoc piped through a wrapper to bash', 'cat <<EOF | sudo bash\nserver &\nEOF'],
    ['a heredoc piped to bash -s with arguments', 'cat <<EOF | bash -s -- arg\nserver &\nEOF'],
    ['xargs with glued numeric options', 'ls | xargs -0n 1 nohup ./run.sh', 'nohup'],
    ['su -c', "su - www -c 'server &'"],
    ['su --command', 'su www --command "nohup x"', 'nohup'],
    ['$SHELL -c', '$SHELL -c "server &"'],
    ['${SHELL} -c', '${SHELL} -c "server &"'],
    ['a job after an array literal', 'x=(a b); server &'],
    ['start /b', 'start /b server.exe', 'start'],
    ['at with a time and a file', 'at 5pm -f job.sh', 'at'],
    ['unquoted Start-Process', 'powershell Start-Process server.exe', 'Start-Process'],
    ['a detacher after quoted assignments', 'FOO=1 BAR="x" nohup ./run.sh', 'nohup'],
    ['a substitution in a parameter default', 'echo ${x:-$(server &)}'],
    ['batch', 'echo ./run.sh | batch', 'batch'],
  ];
  // A third element names the detaching word; without one the reason is the bare &.
  for (const [name, command, word] of denied) {
    it(`denies ${name}`, () => {
      assert.equal(findDetached(command), word ? detachedWord(word) : DENY_AMPERSAND, command);
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
    ['an arithmetic command', 'if (( x & 1 )); then echo odd; fi'],
    [';& in case', 'case $x in a) echo a ;& b) echo b ;; esac'],
    ['bash -c as grep arguments', "ps aux | grep bash -c 'a & b'"],
    ['tmux attach -d', 'tmux attach -d -t main'],
    ['screen -dr', 'screen -dr main'],
    ['a heredoc for a -c script', "bash -c 'cat' <<EOF\na & b\nEOF"],
    ['a heredoc with a \\EOF delimiter', 'cat <<\\EOF\na & b\nEOF'],
    ['npm start', 'npm start'],
    ['Start-Process with -Wait', 'powershell -Command "Start-Process setup.exe -Wait"'],
    ['jobs reaped inside their subshell', '(a & b & wait)'],
    ['an ANSI-C quoted &', "echo $'a\\'b & c'"],
    ['xargs running a plain command', 'ls | xargs -n 1 echo'],
    ['a quoted value glued to an assignment', 'MODE="batch" python train.py'],
    ['a single-quoted assignment value', "ACTION='start' ./ctl.sh"],
    ['case patterns named like detachers', 'case "$1" in\n  start)\n    ./run.sh ;;\n  stop)\n    ./stop.sh ;;\nesac'],
    ['an alternative case pattern', 'case $1 in a|start) echo a;; esac'],
    ['a function named start', 'start() { ./run.sh; }\nstart'],
    ['a relative script named start', './bin/start --port 80'],
    ['unquoted Start-Process with -Wait', 'powershell Start-Process setup.exe -Wait'],
    ['a shell script fed data by a heredoc', 'bash check.sh <<EOF\na & b\nEOF'],
    ['a heredoc piped to a shell with a script', 'cat <<EOF | bash check.sh\na & b\nEOF'],
    ['a heredoc piped to a tool', 'cat <<EOF | grep x\nserver &\nEOF'],
    ['a parameter expansion', 'echo ${s//&/and}'],
    ['a quoted command path with spaces', '"C:/Program Files/nodejs/node.exe" build.js'],
    ['the word start as an argument', 'echo start'],
    ['upstart start', 'start nginx'],
    ['at without a time', 'at -l'],
    ['a case statement then other commands', 'case $x in start) echo a;; esac; echo done'],
    ['a substitution reaped by wait', 'x=`server &`; wait'],
    ['an array literal named like detachers', 'modes=(batch stream)\necho ${modes[0]}'],
    ['an array literal as a declare argument', 'declare -a steps=(start stop)'],
    ['a variable named like a detacher', '$batch --run'],
    ['variables named like detachers as arguments', 'echo $start $at ${batch}'],
    ['a heredoc piped through a wrapper to a tool', 'cat <<EOF | sudo grep x\nserver &\nEOF'],
    ['a heredoc piped to bash -c', "cat <<EOF | bash -c 'cat'\na & b\nEOF"],
    ['a commit message heredoc in a substitution', "git commit -m \"$(cat <<'EOF'\nfix a & b\nEOF\n)\""],
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

  it('sees an edited matcher as stale and keeps a CRLF file CRLF', (t) => {
    const dir = sandbox(t);
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{\r\n  "model": "x"\r\n}\r\n');
    assert.equal(updateNobg(path, 'enable', { binPath: BIN }), 'enabled');
    const written = readFileSync(path, 'utf8');
    assert.equal(written.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF');
    const edited = JSON.parse(written);
    edited.hooks.PreToolUse[0].matcher = 'Edit';
    writeFileSync(path, JSON.stringify(edited, null, 2));
    assert.equal(readNobgState(path, BIN), 'stale');
    assert.equal(updateNobg(path, 'enable', { binPath: BIN }), 'updated');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).hooks.PreToolUse[0].matcher, 'Bash');
  });

  it('creates a missing file and refuses invalid JSON or an unsafe bin path', (t) => {
    const dir = sandbox(t);
    const fresh = join(dir, 'new', 'settings.json');
    assert.equal(updateNobg(fresh, 'disable'), 'not-enabled');
    assert.equal(existsSync(fresh), false);
    assert.equal(updateNobg(fresh, 'enable', { binPath: BIN }), 'enabled');

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ nope');
    assert.throws(() => updateNobg(broken, 'enable', { binPath: BIN }), SettingsFileError);
    assert.equal(readFileSync(broken, 'utf8'), '{ nope');
    assert.throws(() => nobgHooks('C:/Users/$me/cah-nobg.js'), SettingsFileError);
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
