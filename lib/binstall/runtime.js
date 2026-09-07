import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SentinelBin } from '../sentinel.js';
import { contentDigest, sameFileIdentity } from '../fs-atomic-identity.js';

// The companion runtime is deliberately described as data.  The graph and the
// publication order below are calculated from one frozen source generation by
// writeBins, so a source swap cannot change the attempted runtime halfway
// through an install or its repair.
export const BinFileDefinitions = [
  { src: 'lib/cah-bin-package.json', dest: 'package.json', mode: 0o644 },
  { src: 'lib/sentinel.js', dest: 'lib/sentinel.js', mode: 0o755 },
  { src: 'lib/fs-atomic-identity.js', dest: 'lib/fs-atomic-identity.js', mode: 0o755 },
  { src: 'lib/fs-atomic-publication.js', dest: 'lib/fs-atomic-publication.js', mode: 0o755 },
  { src: 'lib/lease-lock.js', dest: 'lib/lease-lock.js', mode: 0o755 },
  { src: 'lib/fs-atomic.js', dest: 'lib/fs-atomic.js', mode: 0o755 },
  { src: 'lib/fsutil.js', dest: 'lib/fsutil.js', mode: 0o755 },
  { src: 'lib/marker-capacity-ops.js', dest: 'lib/marker-capacity-ops.js', mode: 0o755 },
  { src: 'lib/marker-capacity-stage.js', dest: 'lib/marker-capacity-stage.js', mode: 0o755 },
  { src: 'lib/marker-capacity-recovery.js', dest: 'lib/marker-capacity-recovery.js', mode: 0o755 },
  { src: 'lib/marker-state.js', dest: 'lib/marker-state.js', mode: 0o755 },
  { src: 'lib/transcript-stats.js', dest: 'lib/transcript-stats.js', mode: 0o755 },
  { src: 'lib/update-check.js', dest: 'lib/update-check.js', mode: 0o755 },
  { src: 'bin/cah-checkpoint-hint.js', dest: 'bin/cah-checkpoint-hint.js', mode: 0o755 },
  { src: 'bin/cah-status.js', dest: 'bin/cah-status.js', mode: 0o755 },
  { src: 'bin/cah-stamp.js', dest: 'bin/cah-stamp.js', mode: 0o755 },
  { src: 'bin/cah-status-probe.js', dest: 'bin/cah-status-probe.js', mode: 0o755 },
];

// Deep-freeze the definitions so the "frozen data description" promise is
// real: install and repair derive their generation from these entries, and a
// stray in-place edit to an element would otherwise poison every derivation
// mid-flight.  Read-only consumers (graph/publication derivation) are
// unaffected.
for (const element of BinFileDefinitions) Object.freeze(element);
Object.freeze(BinFileDefinitions);

const LOCAL_IMPORT_RE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g;
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE_CAPTURE_MAX_ATTEMPTS = 3;

function posixPath(path) {
  return path.split(sep).join('/');
}

function localModuleDest(importer, specifier, sourceRoot, byDest) {
  const importedPath = resolve(sourceRoot, dirname(importer), specifier);
  const candidates = [importedPath, `${importedPath}.js`, join(importedPath, 'index.js')];
  const candidate = candidates.find((path) => byDest.has(posixPath(relative(sourceRoot, path))));
  if (!candidate) {
    const relativeImport = posixPath(relative(sourceRoot, importedPath));
    throw new Error(
      `companion runtime leaf ${importer} imports unmanaged local module ${relativeImport}`,
    );
  }
  return posixPath(relative(sourceRoot, candidate));
}

export function companionImportGraph(files, sourceRoot = PACKAGE_ROOT, sourceBytes = null) {
  const root = resolve(sourceRoot);
  const byDest = new Map();
  for (const file of files) {
    if (byDest.has(file.dest)) throw new Error(`duplicate companion runtime destination ${file.dest}`);
    byDest.set(file.dest, file);
  }

  const graph = new Map();
  for (const file of files) {
    const source = sourceBytes?.get(file.dest) || readFileSync(join(root, file.src));
    const dependencies = new Set();
    for (const match of source.toString('utf8').matchAll(LOCAL_IMPORT_RE)) {
      const specifier = match[1] || match[2];
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const dependency = localModuleDest(file.src, specifier, root, byDest);
        if (dependency !== file.dest) dependencies.add(dependency);
      }
    }
    // The boundary is synthetic from the graph's point of view: every JS
    // leaf requires the managed ESM package.json to remain present.
    if (file.dest.endsWith('.js')) dependencies.add('package.json');
    graph.set(file.dest, dependencies);
  }
  return graph;
}

export function deriveCompanionPublicationOrder(files, sourceRoot = PACKAGE_ROOT, sourceBytes = null) {
  const graph = companionImportGraph(files, sourceRoot, sourceBytes);
  const boundary = files.filter((file) => file.dest === 'package.json');
  if (boundary.length !== 1) throw new Error('companion runtime requires exactly one package.json boundary');
  const boundaryFile = boundary[0];
  const emitted = new Set();
  const ordered = [];

  while (ordered.length < files.length) {
    const librariesComplete = files
      .filter((file) => file.dest.startsWith('lib/'))
      .every((file) => emitted.has(file.dest));
    const next = files.find((file) => !emitted.has(file.dest)
      && [...graph.get(file.dest)].every((dependency) => emitted.has(dependency))
      && (file === boundaryFile ? ordered.length === 0
        : !file.dest.startsWith('bin/') || librariesComplete));
    if (!next) {
      const pending = files
        .filter((file) => !emitted.has(file.dest))
        .map((file) => file.dest)
        .join(', ');
      throw new Error(`companion runtime dependency graph is cyclic or cannot satisfy publication phases: ${pending}`);
    }
    emitted.add(next.dest);
    ordered.push(next);
  }
  return ordered;
}

export function validateCompanionFileOrder(files, sourceRoot = PACKAGE_ROOT, sourceBytes = null) {
  const graph = companionImportGraph(files, sourceRoot, sourceBytes);
  const positions = new Map(files.map((file, index) => [file.dest, index]));
  const boundaryIndex = positions.get('package.json');
  if (boundaryIndex !== 0) throw new Error('companion package.json boundary must be published first');
  const firstExecutable = files.findIndex((file) => file.dest.startsWith('bin/'));
  if (firstExecutable !== -1 && files.slice(firstExecutable).some((file) => file.dest.startsWith('lib/'))) {
    throw new Error('companion executable leaves must be published after every library leaf');
  }
  for (const [importer, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (positions.get(dependency) >= positions.get(importer)) {
        throw new Error(`companion publication order places importer ${importer} before dependency ${dependency}`);
      }
    }
  }
  return { graph, order: files.map((file) => file.dest) };
}

function lstatSource(path) {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return stat;
}

function sourceUnavailable(file) {
  return new Error(`companion runtime source is unavailable or non-regular: ${file.src}`);
}

function sourceChanged(file) {
  const error = new Error(`companion runtime source changed while freezing: ${file.src}`);
  error.code = 'ERR_COMPANION_SOURCE_CHANGED';
  return error;
}

function readSource(path, file, missingIsChange) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' && missingIsChange) throw sourceChanged(file);
    throw error;
  }
}

// Read a source twice around identity checks.  Besides detecting replacement,
// the second read prevents a direct in-place edit from contributing a torn
// byte sequence while its inode happens to remain the same.
function captureStableSource(path, file, initialCapture) {
  const before = lstatSource(path);
  if (!before) {
    if (initialCapture) throw sourceUnavailable(file);
    throw sourceChanged(file);
  }
  const bytes = readSource(path, file, true);
  const after = lstatSource(path);
  const verifyBytes = readSource(path, file, true);
  const afterVerify = lstatSource(path);
  if (!after || !afterVerify || !sameFileIdentity(before, after)
      || !sameFileIdentity(after, afterVerify) || !bytes.equals(verifyBytes)) {
    throw sourceChanged(file);
  }
  return {
    bytes: Buffer.from(bytes),
    identity: afterVerify,
    digest: contentDigest(bytes),
  };
}

function revalidateCapturedSources(files, root, captures) {
  const currentSources = new Map();
  let changed = null;
  for (const file of files) {
    const path = join(root, file.src);
    try {
      currentSources.set(file.dest, captureStableSource(path, file, false));
    } catch (error) {
      if (error?.code !== 'ERR_COMPANION_SOURCE_CHANGED') throw error;
      changed ||= error;
    }
  }
  if (changed) throw changed;
  for (const file of files) {
    const captured = captures.get(file.dest);
    const current = currentSources.get(file.dest);
    if (!sameFileIdentity(captured.identity, current.identity)
        || captured.digest !== current.digest) {
      throw sourceChanged(file);
    }
  }
}

function frozenPayload(bytes) {
  const text = bytes.toString('utf8');
  if (!text.includes(SentinelBin)) {
    if (text.startsWith('#!')) {
      const nl = text.indexOf('\n');
      if (nl !== -1) {
        const lineEnd = nl > 0 && text[nl - 1] === '\r' ? nl - 1 : nl;
        return Buffer.from(
          text.slice(0, lineEnd) + '\n' + SentinelBin + '\n' + text.slice(nl + 1),
          'utf8',
        );
      }
    }
    return Buffer.from(SentinelBin + '\n' + text, 'utf8');
  }
  return Buffer.from(bytes);
}

export function freezeCompanionGeneration(files, sourceRoot, options = {}) {
  const root = resolve(sourceRoot);
  let lastChanged = null;

  for (let attempt = 0; attempt < SOURCE_CAPTURE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const sourceBytes = new Map();
      const payloads = new Map();
      const identities = new Map();
      const captures = new Map();
      for (const file of files) {
        // This hook is deliberately before each later read so tests can make
        // a deterministic successor change after an early dependency was
        // captured, exercising the whole-generation retry.
        options.testInterlock?.('binstall-before-source-capture', file.dest, attempt);
        const capture = captureStableSource(join(root, file.src), file, true);
        sourceBytes.set(file.dest, capture.bytes);
        payloads.set(file.dest, frozenPayload(capture.bytes));
        identities.set(file.dest, capture.identity);
        captures.set(file.dest, capture);
        options.testInterlock?.('binstall-after-source-capture', file.dest, attempt);
      }

      // Per-file stability is not enough: an early dependency may have been
      // replaced after it was read but before a later leaf was captured. Make
      // one complete identity+digest pass over the attempted generation
      // before deriving anything or acquiring the lifecycle lease.
      revalidateCapturedSources(files, root, captures);

      const graph = companionImportGraph(files, root, sourceBytes);
      const publicationFiles = deriveCompanionPublicationOrder(files, root, sourceBytes);
      // The order is part of the captured generation.  Repair must never
      // rediscover an order from the live source tree (or from BinFiles),
      // because doing so can publish an importer before the dependency that
      // belongs to this exact attempt.
      return Object.freeze({
        root, sourceBytes, payloads, identities, graph,
        publicationFiles: Object.freeze([...publicationFiles]),
      });
    } catch (error) {
      if (error?.code !== 'ERR_COMPANION_SOURCE_CHANGED') throw error;
      lastChanged = error;
    }
  }

  const error = new Error(
    `${lastChanged?.message || 'companion runtime source changed while freezing'} `
      + `(capture retry limit exceeded after ${SOURCE_CAPTURE_MAX_ATTEMPTS} attempts)`,
  );
  error.code = 'ERR_COMPANION_SOURCE_CHANGED';
  error.cause = lastChanged;
  throw error;
}
