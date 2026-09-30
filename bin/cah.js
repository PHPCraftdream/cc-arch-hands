#!/usr/bin/env node
import { run } from '../lib/cli.js';

try {
  const code = run(process.argv.slice(2));
  if (typeof code !== 'number') {
    // Guards against a future refactor making a subcommand async: a returned
    // Promise would coerce to NaN and silently exit 0, masking the failure.
    process.stderr.write('cah: internal error: run() did not return a numeric exit code\n');
    process.exitCode = 1;
  } else {
    process.exitCode = code;
  }
} catch (e) {
  process.stderr.write(`cah: unexpected error: ${e && e.message ? e.message : e}\n`);
  process.exitCode = 1;
}
