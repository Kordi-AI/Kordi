import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const lockfiles = [
  'shared/omp-runtime/bun.lock',
  'experiments/omp-provider-routing/bun.lock',
  'app/desktop/package-lock.json',
  'pnpm-lock.yaml',
];

// A mirror in a lockfile makes CI and image builds fail whenever that mirror
// is down, even though the official registry is up.
test('lockfiles download npm packages from the official registry only', () => {
  for (const path of lockfiles) {
    const text = readFileSync(new URL(path, root), 'utf8');
    const hosts = new Set([...text.matchAll(/https:\/\/([a-z0-9.-]+)\/[^"'\s]*\.tgz/g)].map((match) => match[1]));
    hosts.delete('registry.npmjs.org');
    assert.deepEqual([...hosts], [], `${path} downloads packages from ${[...hosts].join(', ')}`);
  }
});
