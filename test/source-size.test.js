import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const productionRoots = ['bin', 'lib'];
const maximumLines = 1000;

function productionJavaScriptFiles() {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
    }
  };
  for (const root of productionRoots) visit(join(repoRoot, root));
  return files.sort();
}

function lineCount(path) {
  const source = readFileSync(path, 'utf8');
  if (source.length === 0) return 0;
  const lines = source.split(/\r\n|\n|\r/);
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

describe('production source-size contract', () => {
  it(`keeps production JavaScript files at or below ${maximumLines} lines`, () => {
    const violations = productionJavaScriptFiles()
      .map((path) => ({ path, lines: lineCount(path) }))
      .filter(({ lines }) => lines > maximumLines)
      .map(({ path, lines }) => `${relative(repoRoot, path)}: ${lines} lines`);

    assert.deepEqual(violations, [], `production source-size violations:\n${violations.join('\n')}`);
  });
});
