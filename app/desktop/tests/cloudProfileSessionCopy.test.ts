import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { signOutDescription } from '../src/pages/cloudProfileSessionCopy';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

/** The source without comments, so only text the person can see is checked. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the Sign out row names the Mac only in the Mac app', () => {
  assert.equal(signOutDescription(true), 'Sign out of Kordi on this Mac.');
  assert.equal(signOutDescription(false), 'Sign out of Kordi on this device.');
  assert.doesNotMatch(signOutDescription(false), /\bMac\b/);
});

test('the Profile session rows name no platform outside the Mac app', () => {
  const panel = withoutComments(readSource('pages/CloudProfilePanel.tsx'));
  assert.match(panel, /description=\{signOutDescription\(\)\}/);
  assert.doesNotMatch(panel, /\bthis Mac\b/);
  for (const path of [
    'features/cloud/CloudDeleteAccountRow.tsx',
    'features/cloud/CloudDeleteAccountDialog.tsx',
    'features/cloud/accountDeletionProof.ts',
  ]) {
    assert.doesNotMatch(withoutComments(readSource(path)), /\b(?:Mac|macOS|browser)\b/, path);
  }
});
