import { symlinkSync } from 'node:fs';

// Creates a link (type 'dir' is a junction on Windows). A Windows host that
// may not create one skips the test and gets `false`; any other failure throws.
export function symlinkOrSkip(t, target, path, type) {
  try {
    symlinkSync(target, path, type === 'dir' && process.platform === 'win32' ? 'junction' : type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EINVAL', 'UNKNOWN'].includes(error.code)) {
      t.skip('symbolic links are unavailable on this Windows host');
      return false;
    }
    throw error;
  }
}
