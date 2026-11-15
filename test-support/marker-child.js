// Source text of the marker config the child-process scripts of the marker
// tests declare. A child script is a string run with `node -e`, so the config
// is spliced in as code: `const cfg = ${markerChildConfig({ interlock: true })};`
// The script reads CAH_TEST_MARKER_DIR (see markerEnv) and, with `interlock`,
// must import makeInterlock from test-support/interlocks.js itself.
export function markerChildConfig({
  claimTtlMs = 30_000, interlock = false, ownerTestEnv = true,
} = {}) {
  const fields = [
    'markerDir: process.env.CAH_TEST_MARKER_DIR',
    "namespace: 'marker-tests'",
    "prefix: 'marker-'",
    'ttlMs: 86400000',
    'maxSessions: 1',
    'scanCap: 128',
    `claimTtlMs: ${claimTtlMs}`,
    ...(ownerTestEnv ? ["ownerTestEnv: 'CAH_TEST_ONLY_MARKER_CAPACITY_LEASE_MS'"] : []),
    'markerNameRe: /^marker-[a-f0-9]{64}$/',
    ...(interlock ? ['testInterlock: makeInterlock()'] : []),
  ];
  return `{ ${fields.join(', ')} }`;
}
