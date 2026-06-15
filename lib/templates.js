import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BUNDLED_ROOT = resolve(__dirname, '..', 'templates');

export class Templates {
  constructor(root, label) {
    this.root = root;
    this.label = label;
  }

  skillTree(name) {
    const skillRoot = join(this.root, 'skills', name);
    const files = [];
    walkDir(skillRoot, (absPath) => {
      const rel = relative(skillRoot, absPath).replace(/\\/g, '/');
      files.push({ relPath: rel, bytes: readFileSync(absPath) });
    });
    return files;
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
