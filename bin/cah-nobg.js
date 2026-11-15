#!/usr/bin/env node
// cah-nobg — PreToolUse hook for the Bash tool: denies a command that detaches
// a job from the tool call. A detached job outlives the call, ignores SIGINT, is
// not tracked and is not stopped with the session; the Bash tool's
// `run_in_background: true` has none of that.
//
// Caught, with one small quote-aware scan and no shell grammar:
//   - a bare `&` that no later `wait` of the same (sub)shell reaps;
//   - `nohup`, `setsid`, `disown`, `coproc`, `daemonize`, `systemd-run`,
//     `batch`, `at <time>`, `start "" x` / `start /b x` / `start x.exe`,
//     `screen -dm`, `tmux new … -d` in command position, also quoted, as `x.exe`,
//     behind wrappers with their options (`sudo -Eu www`, `env -u X`, `timeout -s
//     KILL 5`, `command`, `xargs -n1`, `find -exec`), `VAR=x`, `if`/`do`/`{`;
//   - `cmd /c start …` and PowerShell `Start-Process`/`Start-Job` without a wait;
//   - the same inside `$(…)`, backticks, `bash -c '…'`, `env -S '…'`, `eval …`
//     and a heredoc fed to a shell (`bash <<EOF`, `cat <<EOF | bash`).
// Not a command: a case pattern (`start)`), a function definition (`start() {`),
// a relative script (`./bin/start`), an assignment value (`MODE="batch" x`), a
// parameter expansion (`${s//&/x}`), `(( ))`, `;&`, quoted text, comments.
// Fail-open: any unexpected state ends with exit 0 and no output (allow).

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOW = 'Run the command in the foreground, or call the Bash tool with `run_in_background: true` '
  + 'and no `&`/`nohup`. `&&`, `2>&1` and `&>file` are fine.';
export const DENY_AMPERSAND = `cah-nobg: a bare \`&\` starts a detached background job (it outlives this call, `
  + `ignores SIGINT and nothing tracks it). ${HOW}`;
export const detachedWord = (word) => `cah-nobg: \`${word}\` starts a detached background job (it outlives this call `
  + `and nothing tracks it). ${HOW}`;

const DETACHERS = new Set(['nohup', 'setsid', 'disown', 'coproc', 'daemonize', 'systemd-run', 'batch']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'busybox']);
const SHELL_C = /^-[A-Za-z]*c[A-Za-z]*$/;
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const PS_DETACH = /\bStart-(?:Process|Job)\b/i;
const PS_WAITS = /-Wait\b|\bWait-Job\b/i;
const AT_TIME = /^(?:now|noon|midnight|teatime|tomorrow|today|\d|-[ftmqMv])/i;
const START_ARG = /^(?:|\/.*|.*\.(?:exe|bat|cmd|com))$/i;
// Commands whose arguments run another command: a shell among them is a shell.
const EXEC_RUNNERS = new Set([
  'docker', 'podman', 'nerdctl', 'kubectl', 'lxc', 'chroot', 'nsenter', 'unshare', 'firejail',
  'flatpak', 'wsl', 'runuser', 'su', 'script', 'flock', 'watch', 'parallel', 'taskset', 'setpriv',
]);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
// Words after which a command word still follows, with the options of each that take an argument.
const WRAPPERS = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '--unset', '--chdir'],
  time: ['-f', '-o', '--format', '--output'],
  exec: ['-a'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p', '-t'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  command: [],
  builtin: [],
  xargs: ['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a', '--max-args', '--replace', '--max-lines',
    '--max-procs', '--delimiter', '--arg-file', '--eof'],
};
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
const KEEP = new Set(['{', '!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do']);
const ASSIGN = /^[A-Za-z_]\w*=/;
const TMUX_NEW = new Set(['new-session', 'new', 'new-window', 'neww', 'split-window', 'splitw']);
const TMUX_OPT_ARG = new Set(['-L', '-S', '-f', '-c', '-T']);
const WORD = /[^\s;|&()<>"'`\\$]/;
// After a word: a case pattern (`start)`, `a|start)`; only inside `case`) or a function definition (`start()`).
const CASE_PATTERN = /^(?:\s*\|\s*[^\s;|&()<>]+)*\s*\)/;
const FUNCTION_DEF = /^\s*\(\s*\)/;
const MAX_DEPTH = 4;

const baseName = (word) => word.split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();

function arithmeticEnd(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '(') depth += 1;
    else if (s[j] === ')') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

// The end (past `}`) of the `${…}` that opens at `open`, or -1.
function braceEnd(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '{') depth += 1;
    else if (s[j] === '}') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

// Heredoc delimiter after `<<` at `i`: { word, dash, end } or null (`<<<` is a here-string).
function heredocAt(s, i) {
  if (s[i + 2] === '<') return null;
  let j = i + 2;
  const dash = s[j] === '-';
  if (dash) j += 1;
  while (s[j] === ' ' || s[j] === '\t') j += 1;
  if (s[j] === '\\') j += 1;
  const quote = s[j] === '"' || s[j] === "'" ? s[j] : '';
  if (quote) j += 1;
  const begin = j;
  while (j < s.length && (quote ? s[j] !== quote : /[\w.-]/.test(s[j]))) j += 1;
  if (j === begin) return null;
  return { word: s.slice(begin, j), dash, end: quote ? j + 1 : j };
}

// Code that runs inside a double-quoted string: the `$(…)` and backtick bodies.
function substitutions(text) {
  const parts = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      const end = arithmeticEnd(text, i + 1);
      if (end === -1) break;
      parts.push(text.slice(i + 2, end - 1));
      i = end - 1;
    } else if (text[i] === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1) break;
      parts.push(text.slice(i + 1, close));
      i = close;
    }
  }
  return parts;
}

const unescapeDouble = (text) => text.replace(/\\([\\"$`])/g, '$1');

// The reason `command` detaches a job, or null. Nested code (`bash -c`, `eval`,
// `$(…)`, a heredoc fed to a shell) is analysed the same way, up to MAX_DEPTH levels.
export function findDetached(command, depth = 0) {
  const s = String(command);
  const nested = [];
  const heredocs = [];
  // Background jobs not reaped yet, by the subshell depth they started at.
  let pending = [];
  let escaped = false;
  let parens = 0;
  let psDeny = null;
  // The end of the last word segment, and whether that word was an assignment.
  let lastEnd = -1;
  let lastAssign = false;
  let afterPipe = false;
  let caseDepth = 0;
  // Per simple command state.
  let atCommand = true;
  let wrapper = null;
  let optArgNext = false;
  let envSplit = false;
  let cmd = null;
  let argCount = 0;
  let shellSeen = false;
  let shellScript = false;
  let shellStdin = false;
  let shellC = false;
  let pipedDocs = [];
  let codeNext = false;
  let evalMode = false;
  let cmdC = false;
  let psText = '';
  let screenFlags = '';
  let tmuxSub = null;
  let tmuxDetach = false;
  let tmuxOptArg = false;

  const flushPs = () => {
    if (psText && PS_DETACH.test(psText) && !PS_WAITS.test(psText)) {
      psDeny ??= detachedWord(psText.match(PS_DETACH)[0]);
    }
    psText = '';
  };
  const reset = () => {
    flushPs();
    atCommand = true; wrapper = null; optArgNext = false; envSplit = false; cmd = null; argCount = 0;
    shellSeen = false; shellScript = false; shellStdin = false; shellC = false; pipedDocs = [];
    codeNext = false; evalMode = false; cmdC = false;
    screenFlags = ''; tmuxSub = null; tmuxDetach = false; tmuxOptArg = false;
  };
  const argument = (code) => {
    if (codeNext || evalMode) { nested.push(code); codeNext = false; }
  };
  // A shell given a script or -c reads no code from stdin: a piped heredoc is data.
  const shellTakesProgram = () => {
    for (const doc of pipedDocs) doc.code = false;
    pipedDocs = [];
  };

  // A word in command position (or a wrapper's operand); a reason to deny, or null.
  // `end` is the index just past the word in the source.
  const commandWord = (raw, end) => {
    if (optArgNext) { optArgNext = false; return null; }
    if (envSplit) { envSplit = false; nested.push(raw); return null; }
    if (raw === '') return null;
    if (ASSIGN.test(raw)) { lastAssign = true; return null; }
    if (KEEP.has(raw)) return null;
    if (wrapper) {
      if (raw.startsWith('-')) {
        if (wrapper === 'command' && /^-[A-Za-z]*[vV]/.test(raw)) { atCommand = false; cmd = 'command'; return null; }
        if (wrapper === 'env' && (raw === '-S' || raw === '--split-string')) { envSplit = true; return null; }
        if (wrapper === 'env' && raw.startsWith('--split-string=')) { nested.push(raw.slice(15)); return null; }
        const options = WRAPPERS[wrapper];
        if (options.includes(raw)) optArgNext = true;
        else if (/^-[A-Za-z]{2,}$/.test(raw) && options.includes(`-${raw.at(-1)}`)) optArgNext = true;
        return null;
      }
      if (wrapper === 'timeout' && DURATION.test(raw)) return null;
    }
    const base = baseName(raw);
    if (Object.hasOwn(WRAPPERS, base)) { wrapper = base; return null; }
    if (raw === 'case') caseDepth += 1;
    if (raw === 'esac') caseDepth = Math.max(0, caseDepth - 1);
    // A case pattern or a function definition names no command.
    const after = s.slice(end);
    if (FUNCTION_DEF.test(after) || (caseDepth > 0 && CASE_PATTERN.test(after))) return null;
    atCommand = false;
    wrapper = null;
    cmd = base;
    argCount = 0;
    shellSeen = SHELLS.has(base);
    if (shellSeen && afterPipe && heredocs.length > 0) {
      // `cat <<EOF | bash`: the heredoc is the shell's program, unless it is given one.
      for (const doc of heredocs) doc.code = true;
      pipedDocs = [...heredocs];
    }
    // A relative script (`./bin/start`) is the user's own, whatever it is called.
    if (DETACHERS.has(base) && !/^\.{1,2}[\\/]/.test(raw)) return detachedWord(base);
    if (base === 'wait') pending = pending.filter((d) => d !== parens);
    evalMode = base === 'eval';
    return null;
  };

  // An argument of the current command; a reason to deny, or null.
  const argWord = (raw) => {
    const first = argCount === 0;
    argCount += 1;
    // The program text after `-c`.
    if (codeNext) { nested.push(raw); codeNext = false; return null; }
    if (shellSeen && SHELL_C.test(raw)) { codeNext = true; shellC = true; shellTakesProgram(); return null; }
    if (shellSeen && raw === '-s') { shellStdin = true; return null; }
    if (shellSeen && !shellC && !raw.startsWith('-')) {
      if (!shellScript) { shellScript = true; shellTakesProgram(); }
      return null;
    }
    if (EXEC_RUNNERS.has(cmd) && SHELLS.has(baseName(raw))) { shellSeen = true; return null; }
    if (cmd === 'find' && FIND_EXEC.has(raw)) { reset(); return null; }
    if (cmd === 'start' && first && START_ARG.test(raw)) return detachedWord('start');
    if (cmd === 'at' && first && AT_TIME.test(raw)) return detachedWord('at');
    if (cmd === 'cmd') {
      if (/^\/\/?[cCkK]$/.test(raw)) { cmdC = true; return null; }
      if (cmdC) {
        cmdC = false;
        if (/^start(\s|$)/i.test(raw.trim())) return detachedWord('cmd /c start');
      }
    }
    if (POWERSHELLS.has(cmd)) { psText += ` ${raw}`; return null; }
    if (cmd === 'screen' && /^-[A-Za-z]+$/.test(raw)) {
      screenFlags += raw.slice(1);
      if (/[dD]/.test(screenFlags) && screenFlags.includes('m')) return detachedWord(`screen ${raw}`);
    }
    if (cmd === 'tmux') {
      if (tmuxOptArg) { tmuxOptArg = false; return null; }
      if (raw.startsWith('-')) {
        if (tmuxSub === null && TMUX_OPT_ARG.has(raw)) tmuxOptArg = true;
        else if (tmuxSub !== null && /^-[A-Za-z]*d/.test(raw)) tmuxDetach = true;
      } else if (tmuxSub === null) tmuxSub = raw;
      if (tmuxDetach && TMUX_NEW.has(tmuxSub)) return detachedWord(`tmux ${tmuxSub} -d`);
      return null;
    }
    argument(raw);
    return null;
  };

  // One word segment (bare or quoted) that ends at `end`.
  const word = (raw, start, end) => {
    // A segment glued to an assignment is part of its value: `MODE="batch" x`.
    const glued = start === lastEnd && lastAssign;
    lastEnd = end;
    if (glued) return null;
    lastAssign = false;
    const reason = atCommand ? commandWord(raw, end) : argWord(raw);
    afterPipe = false;
    return reason;
  };

  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (WORD.test(c)) {
      let j = i;
      while (j < s.length && WORD.test(s[j])) j += 1;
      const reason = word(s.slice(i, j), i, j);
      if (reason) return reason;
      i = j;
      continue;
    }
    if (c === '\\') {
      // `\nohup` runs nohup: an escaped word character starts a word.
      i += WORD.test(s[i + 1] ?? '') ? 1 : 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '$' && s[i + 1] === "'") {
      let j = i + 2;
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
      const reason = word(s.slice(i + 2, j), i, j + 1);
      if (reason) return reason;
      i = j + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '{') {
      // `${var//&/x}`: not code, but a default may hold a substitution.
      const end = braceEnd(s, i + 1);
      const inner = s.slice(i + 2, end === -1 ? s.length : end - 1);
      nested.push(...substitutions(inner));
      i = end === -1 ? s.length : end;
      continue;
    }
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      const end = close === -1 ? s.length : close;
      const reason = word(s.slice(i + 1, end), i, end + 1);
      if (reason) return reason;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      const inner = s.slice(i + 1, j);
      nested.push(...substitutions(inner));
      const reason = word(unescapeDouble(inner), i, j + 1);
      if (reason) return reason;
      i = j + 1;
      continue;
    }
    if (c === '$' && s.startsWith('$((', i)) {
      const end = arithmeticEnd(s, i + 1);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (c === '(' && s[i + 1] === '(' && atCommand) {
      // `(( … ))`: an arithmetic command, not two subshells.
      const end = arithmeticEnd(s, i);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (c === '<' && s[i + 1] === '<') {
      const doc = heredocAt(s, i);
      if (doc) {
        // A shell with no script operand (or with -s) reads its program from the heredoc.
        doc.code = SHELLS.has(cmd) && !shellC && (!shellScript || shellStdin);
        heredocs.push(doc);
        i = doc.end;
      } else i += 2;
      continue;
    }
    if (c === '\n') {
      i += 1;
      for (const doc of heredocs.splice(0)) {
        const body = [];
        while (i < s.length) {
          const nl = s.indexOf('\n', i);
          const line = s.slice(i, nl === -1 ? s.length : nl);
          i = nl === -1 ? s.length : nl + 1;
          if ((doc.dash ? line.replace(/^\t+/, '') : line) === doc.word) break;
          body.push(line);
        }
        if (doc.code) nested.push(body.join('\n'));
      }
      reset();
      afterPipe = false;
      continue;
    }
    if (c === '&') {
      const next = s[i + 1];
      const prev = i > 0 ? s[i - 1] : '';
      if (next === '&') { reset(); afterPipe = false; i += 2; continue; }
      if (next === '>' || prev === '>' || prev === '<' || prev === '|' || prev === ';') { i += 1; continue; }
      pending.push(parens);
      reset();
      afterPipe = false;
      i += 1;
      continue;
    }
    if (c === '(') parens += 1;
    if (c === ')' && parens > 0) {
      // Jobs of the subshell that ends here are past any later `wait`.
      if (pending.some((d) => d >= parens)) escaped = true;
      pending = pending.filter((d) => d < parens);
      parens -= 1;
    }
    if (c === ';' || c === '|' || c === '(' || c === ')' || c === '`') {
      reset();
      afterPipe = c === '|' && s[i + 1] !== '|' && s[i - 1] !== '|';
    }
    i += 1;
  }
  flushPs();

  if (escaped || pending.length > 0) return DENY_AMPERSAND;
  if (psDeny) return psDeny;
  if (depth >= MAX_DEPTH) return null;
  for (const code of nested) {
    const reason = findDetached(code, depth + 1);
    if (reason) return reason;
  }
  return null;
}

// The PreToolUse answer for a hook payload: the deny object, or null to allow.
export function decide(payload) {
  if (payload?.tool_name !== 'Bash') return null;
  const command = payload.tool_input?.command;
  if (typeof command !== 'string') return null;
  const reason = findDetached(command);
  if (!reason) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function run() {
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  const answer = decide(payload);
  if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
}

// Node resolves the module URL through links and junctions; argv[1] stays as typed.
function invokedDirectly() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (process.argv[1] && invokedDirectly()) {
  try { run(); } catch { /* fail-open */ }
  process.exit(0);
}
