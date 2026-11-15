// marked-section.js — one block between two marker lines inside a file the user
// also writes (AGENTS.md, APPEND_SYSTEM.md). The block is added, refreshed and
// removed in place; the rest of the file is never touched, and a file whose
// markers are broken is refused rather than guessed at. Line ends follow the
// file: a CRLF file gets a CRLF block.

import { captureRegularFileSnapshot, removeOwnedRegularFile, writeFileAtomic } from './fsutil.js';

function positions(content, marker) {
  const found = [];
  for (let from = 0; ; ) {
    const at = content.indexOf(marker, from);
    if (at < 0) return found;
    found.push(at);
    from = at + marker.length;
  }
}

// `begin`/`end`: the marker lines; `section`: the whole block, markers included;
// `label`: how errors name the file ("Codex AGENTS.md").
export function createMarkedSection({ begin, end, section, label }) {
  const beginBytes = Buffer.from(begin);
  const endBytes = Buffer.from(end);

  function range(content) {
    const starts = positions(content, beginBytes);
    const ends = positions(content, endBytes);
    if (starts.length === 0 && ends.length === 0) return null;
    if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0] + beginBytes.length) {
      throw new Error(`${label} has incomplete or duplicate markers`);
    }
    const first = starts[0];
    const last = ends[0] + endBytes.length;
    if ((first > 0 && content[first - 1] !== 10)
        || (last < content.length && content[last] !== 10 && content[last] !== 13)) {
      throw new Error(`${label} markers must occupy their own lines`);
    }
    return { start: first, end: last };
  }

  function inspect(path) {
    const snapshot = captureRegularFileSnapshot(path);
    return { path, snapshot, range: range(snapshot.content ?? Buffer.alloc(0)) };
  }

  // The file's bytes with the block added or refreshed.
  function inserted(original, at) {
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const block = Buffer.from(eol === '\n' ? section : section.replace(/\n/g, eol));
    if (at) return Buffer.concat([original.subarray(0, at.start), block, original.subarray(at.end)]);
    return Buffer.concat([original, original.length ? Buffer.from(eol + eol) : Buffer.alloc(0),
      block, Buffer.from(eol)]);
  }

  // The file's bytes with the block cut out, together with the blank line before it
  // and the line end after it.
  function cut(original, at) {
    let from = at.start;
    for (const blank of ['\r\n\r\n', '\n\n']) {
      if (original.subarray(Math.max(0, at.start - blank.length), at.start).toString() === blank) {
        from = at.start - blank.length;
        break;
      }
    }
    let to = at.end;
    const tail = original.subarray(to).toString();
    if (tail === '\n' || tail === '\r\n') to = original.length;
    return Buffer.concat([original.subarray(0, from), original.subarray(to)]);
  }

  function write(path) {
    const { snapshot, range: at } = inspect(path);
    const original = snapshot.content ?? Buffer.alloc(0);
    const updated = inserted(original, at);
    if (updated.equals(original)) return { written: 0, skipped: [] };
    writeFileAtomic(path, updated, { expectedDestination: snapshot.expectedDestination });
    return { written: 1, skipped: [] };
  }

  function remove(path) {
    const { snapshot, range: at } = inspect(path);
    if (!at) return { removed: 0, skipped: [] };
    const updated = cut(snapshot.content, at);
    // A file that held nothing but the block goes away with it.
    if (updated.length === 0) removeOwnedRegularFile(path, snapshot.expectedDestination);
    else writeFileAtomic(path, updated, { expectedDestination: snapshot.expectedDestination });
    return { removed: 1, skipped: [] };
  }

  return { range, inspect, write, remove };
}
