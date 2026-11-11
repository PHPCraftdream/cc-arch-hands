import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BUNDLED_ROOT = resolve(__dirname, '..', 'templates');

// Harness-neutral text shared by templates of every harness (Claude, Codex,
// OpenCode, OMP) lives in <root>/shared/<name>.md and is pulled into a
// Markdown template by a line holding only `{{include:<name>}}`.
export const SHARED_KIND = 'shared';
const INCLUDE_MARK = '{{include:';
const INCLUDE_LINE = /^\{\{include:([a-z0-9]+(?:-[a-z0-9]+)*)\}\}(\r?)$/gm;

export class Templates {
  constructor(root, label) {
    this.root = root;
    this.label = label;
  }

  // Every installer reads templates through here, so includes expand in one
  // place for all harnesses.
  skillTree(name, kind = 'skills') {
    const skillRoot = join(this.root, kind, name);
    const files = [];
    walkDir(skillRoot, (absPath) => {
      const rel = relative(skillRoot, absPath).replace(/\\/g, '/');
      files.push({ relPath: rel, bytes: this.expandIncludes(readFileSync(absPath), `${kind}/${name}/${rel}`) });
    });
    return files;
  }

  expandIncludes(bytes, where) {
    if (!where.endsWith('.md')) return bytes;
    const text = bytes.toString('utf8');
    if (!text.includes(INCLUDE_MARK)) return bytes;
    const expanded = text.replace(INCLUDE_LINE, (_, name, cr) => `${this.sharedFragment(name, where)}${cr}`);
    if (expanded.includes(INCLUDE_MARK)) {
      throw new Error(`${where}: an include must be a whole line {{include:<slug>}}`);
    }
    return Buffer.from(expanded, 'utf8');
  }

  sharedFragment(name, where) {
    const path = join(this.root, SHARED_KIND, `${name}.md`);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`${where}: missing shared fragment ${SHARED_KIND}/${name}.md`);
      throw e;
    }
    if (text.includes(INCLUDE_MARK)) {
      throw new Error(`${SHARED_KIND}/${name}.md: shared fragments cannot include other fragments`);
    }
    return text.replace(/\r?\n$/, '');
  }
}

export function embeddedTemplates() {
  return new Templates(BUNDLED_ROOT, 'embedded');
}

export function diskTemplates(dir) {
  const abs = resolve(dir);
  const info = statSync(abs);
  if (!info.isDirectory()) throw new Error(`templates path is not a directory: ${abs}`);
  return new Templates(abs, `disk:${abs}`);
}

function walkDir(dir, cb) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, cb);
    } else {
      cb(full);
    }
  }
}
