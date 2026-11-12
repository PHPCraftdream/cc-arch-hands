#!/usr/bin/env node
// cah-nobg — PreToolUse hook for the Bash tool: denies a command that detaches
// a job from the tool call. A detached job outlives the call, ignores SIGINT, is
// not tracked and is not stopped with the session; the Bash tool's
// `run_in_background: true` has none of that.
//
// Caught, with one small quote-aware scan and no shell grammar:
//   - a bare `&` (`server &`, `a & b`, `( a; b ) &`, `a &> log &`);
//   - `nohup`, `setsid`, `disown`, `coproc`, `daemonize`, `systemd-run`,
//     `screen -d…` and `tmux … -d` in command position (also behind `sudo`,
//     `env`, `time`, `timeout 5`, `VAR=x`, `if`/`do`/`{`);
//   - the same inside `$(…)`, backticks, `bash -c '…'`, `sh -c "…"` and `eval …`.
// Allowed: `&&`, `||`, `|&`, `&>`, `>&`, `<&` (`2>&1`), an `&` in single quotes,
// a comment, a heredoc body or `$(( ))`, and a command that reaps its jobs with
// a `wait` after the last `&`.
// Fail-open: any unexpected state ends with exit 0 and no output (allow).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOW = 'Run the command in the foreground, or call the Bash tool with `run_in_background: true` '
  + 'and no `&`/`nohup`. `&&`, `2>&1` and `&>file` are fine.';
export const DENY_AMPERSAND = `cah-nobg: a bare \`&\` starts a detached background job (it outlives this call, `
  + `ignores SIGINT and nothing tracks it). ${HOW}`;
export const detachedWord = (word) => `cah-nobg: \`${word}\` starts a detached background job (it outlives this call `
  + `and nothing tracks it). ${HOW}`;

const DETACHERS = new Set(['nohup', 'setsid', 'disown', 'coproc', 'daemonize', 'systemd-run']);
const MUXERS = new Set(['screen', 'tmux']);
const MUX_DETACH = /^-[A-Za-z]*[dD][A-Za-z]*$/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'busybox']);
const SHELL_C = /^-[A-Za-z]*c[A-Za-z]*$/;
// Words after which a command word still follows.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'exec', 'nice', 'ionice', 'stdbuf', 'timeout']);
const KEEP = new Set(['{', '!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do']);
const ASSIGN = /^[A-Za-z_]\w*=/;
const WRAPPER_ARG = /^(-.*|\d+[smhd]?)$/;
const WORD = /[^\s;|&()<>"'`\\$]/;
const REAPED = /(^|[;&|\n(])[ \t]*wait([ \t;)\n]|$)/;
const MAX_DEPTH = 4;

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

// Heredoc delimiter after `<<` at `i`: { word, dash, end } or null (`<<<` is a here-string).
function heredocAt(s, i) {
  if (s[i + 2] === '<') return null;
  let j = i + 2;
  const dash = s[j] === '-';
  if (dash) j += 1;
  while (s[j] === ' ' || s[j] === '\t') j += 1;
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
// `$(…)`) is analysed the same way, up to MAX_DEPTH levels.
export function findDetached(command, depth = 0) {
  const s = String(command);
  const nested = [];
  const heredocs = [];
  let lastAmp = -1;
  let word = null;
  // Per simple command state.
  let atCommand = true;
  let wrapped = false;
  let cmd = null;
  let shellSeen = false;
  let codeNext = false;
  let evalMode = false;

  const reset = () => { atCommand = true; wrapped = false; cmd = null; shellSeen = false; codeNext = false; evalMode = false; };
  const argument = (code) => {
    if (codeNext || evalMode) { nested.push(code); codeNext = false; }
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
      word = s.slice(i, j);
      i = j;
      if (atCommand) {
        const base = word.split('/').pop();
        if (ASSIGN.test(word) || KEEP.has(word)) continue;
        if (WRAPPERS.has(base)) { wrapped = true; continue; }
        if (wrapped && WRAPPER_ARG.test(word)) continue;
        atCommand = false;
        wrapped = false;
        cmd = base;
        shellSeen = SHELLS.has(base);
        if (DETACHERS.has(base)) return detachedWord(base);
        evalMode = base === 'eval';
      } else if (shellSeen && SHELL_C.test(word)) {
        codeNext = true;
      } else if (SHELLS.has(word.split('/').pop())) {
        shellSeen = true;
      } else if (MUXERS.has(cmd) && MUX_DETACH.test(word)) {
        return detachedWord(`${cmd} ${word}`);
      } else {
        argument(word);
      }
      continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      const end = close === -1 ? s.length : close;
      if (!atCommand) argument(s.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      const inner = s.slice(i + 1, j);
      nested.push(...substitutions(inner));
      if (!atCommand) argument(unescapeDouble(inner));
      i = j + 1;
      continue;
    }
    if (c === '$' && s.startsWith('$((', i)) {
      const end = arithmeticEnd(s, i + 1);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (c === '<' && s[i + 1] === '<') {
      const doc = heredocAt(s, i);
      if (doc) { heredocs.push(doc); i = doc.end; } else i += 2;
      continue;
    }
    if (c === '\n') {
      i += 1;
      for (const doc of heredocs.splice(0)) {
        while (i < s.length) {
          const nl = s.indexOf('\n', i);
          const line = s.slice(i, nl === -1 ? s.length : nl);
          i = nl === -1 ? s.length : nl + 1;
          if ((doc.dash ? line.replace(/^\t+/, '') : line) === doc.word) break;
        }
      }
      reset();
      continue;
    }
    if (c === '&') {
      const next = s[i + 1];
      const prev = i > 0 ? s[i - 1] : '';
      if (next === '&') { reset(); i += 2; continue; }
      if (next === '>' || prev === '>' || prev === '<' || prev === '|') { i += 1; continue; }
      lastAmp = i;
      reset();
      i += 1;
      continue;
    }
    if (c === ';' || c === '|' || c === '(' || c === ')' || c === '`') reset();
    i += 1;
  }

  if (lastAmp !== -1 && !REAPED.test(s.slice(lastAmp + 1))) return DENY_AMPERSAND;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { run(); } catch { /* fail-open */ }
  process.exit(0);
}
